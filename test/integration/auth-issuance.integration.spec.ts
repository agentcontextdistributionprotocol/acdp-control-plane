// MUST be first: enables TOKEN_ISSUANCE_ENABLED before AppModule is imported
// (AuthModule.forRoot() reads it at module-evaluation time). The afterAll below
// deletes it so the flag does not leak into sibling integration specs.
import '../helpers/enable-token-issuance';
import { generateKeyPairSync, sign } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';

/**
 * End-to-end IdP flow: `/auth/challenge` → sign → `/auth/token` → use the
 * bearer on a protected route. Covers the Phase-5 issuance surface that had
 * no integration coverage (the unit specs exercise TokenIssuer in isolation).
 */
const JWT_SECRET = 'integration-issuer-secret-key-0123456789';
const AUTHORITY = 'cp.test';
const DID = 'did:web:cp.test:agents:alice';
const TENANT = 'tenant-alpha';

// A pinned Ed25519 agent key. `rawPubB64` is the trailing 32 SPKI bytes — the
// shape PinnedKeysService stores and AcdpVerifier checks against.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' });
const RAW_PUB_B64 = Buffer.from(spki.subarray(spki.length - 32)).toString('base64');

interface ChallengeResp {
  nonce: string;
  registry_authority: string;
  expires_at: number;
  signing_input: string;
}
interface TokenResp {
  token: string;
  token_type: string;
  expires_at: number;
}

describe('Auth issuance (integration)', () => {
  let ctx: TestAppContext;
  let pub: TestClient; // @Public() endpoints — auth is skipped regardless

  beforeAll(async () => {
    ctx = await createTestApp({
      apiKey: 'issuer-test-key',
      tokenIssuance: {
        jwtSecret: JWT_SECRET,
        authority: AUTHORITY,
        pinnedKeys: `${DID}=${RAW_PUB_B64}`,
        tenantAgents: `${TENANT}:${DID}`,
      },
    });
    pub = new TestClient(ctx.url);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  async function mintToken(): Promise<TokenResp> {
    const ch = await pub.requestJson<ChallengeResp>('POST', '/auth/challenge', {
      body: { agent_id: DID },
    });
    const signature = sign(null, Buffer.from(ch.signing_input), privateKey).toString('base64');
    return pub.requestJson<TokenResp>('POST', '/auth/token', {
      body: {
        agent_id: DID,
        key_id: `${DID}#key-1`,
        nonce: ch.nonce,
        expires_at: ch.expires_at,
        algorithm: 'ed25519',
        signature,
      },
    });
  }

  it('issues a challenge with a nonce + canonical signing input', async () => {
    const res = await pub.requestRaw('POST', '/auth/challenge', {
      body: { agent_id: DID },
    });
    expect(res.status).toBe(200);
    const body = res.body as ChallengeResp;
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.signing_input).toContain('acdp-registry-auth:v1:');
    expect(body.signing_input).toContain(body.nonce);
    expect(body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('exchanges a signed challenge for a bearer JWT with the expected claims', async () => {
    const tok = await mintToken();
    expect(tok.token_type).toBe('Bearer');
    expect(tok.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const decoded = jwt.verify(tok.token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: AUTHORITY,
      audience: AUTHORITY,
    }) as Record<string, unknown>;
    expect(decoded.sub).toBe(DID);
    expect(decoded.tenant).toBe(TENANT);
    expect((decoded.acdp as { registry: string }).registry).toBe(AUTHORITY);
  });

  it('accepts the minted bearer on a protected route, scoped to the agent tenant', async () => {
    const { token } = await mintToken();
    const bearer = new TestClient(ctx.url, token);
    const res = await bearer.requestRaw('GET', '/runs');
    expect(res.status).toBe(200);
  });

  it('rejects a token request carrying a forged signature (401)', async () => {
    const ch = await pub.requestJson<ChallengeResp>('POST', '/auth/challenge', {
      body: { agent_id: DID },
    });
    const res = await pub.requestRaw('POST', '/auth/token', {
      body: {
        agent_id: DID,
        key_id: `${DID}#key-1`,
        nonce: ch.nonce,
        expires_at: ch.expires_at,
        algorithm: 'ed25519',
        signature: Buffer.from('not-the-real-signature').toString('base64'),
      },
    });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown / never-issued nonce (401)', async () => {
    const res = await pub.requestRaw('POST', '/auth/token', {
      body: {
        agent_id: DID,
        key_id: `${DID}#key-1`,
        nonce: 'never-issued-nonce',
        expires_at: Math.floor(Date.now() / 1000) + 300,
        algorithm: 'ed25519',
        signature: Buffer.from('x').toString('base64'),
      },
    });
    expect(res.status).toBe(401);
  });

  it('rejects nonce reuse — a challenge is single-shot (401 on replay)', async () => {
    const ch = await pub.requestJson<ChallengeResp>('POST', '/auth/challenge', {
      body: { agent_id: DID },
    });
    const signature = sign(null, Buffer.from(ch.signing_input), privateKey).toString('base64');
    const body = {
      agent_id: DID,
      key_id: `${DID}#key-1`,
      nonce: ch.nonce,
      expires_at: ch.expires_at,
      algorithm: 'ed25519',
      signature,
    };
    const first = await pub.requestRaw('POST', '/auth/token', { body });
    expect(first.status).toBe(200);
    const replay = await pub.requestRaw('POST', '/auth/token', { body });
    expect(replay.status).toBe(401);
  });

  it('rejects an unsupported signature algorithm (400)', async () => {
    const ch = await pub.requestJson<ChallengeResp>('POST', '/auth/challenge', {
      body: { agent_id: DID },
    });
    const res = await pub.requestRaw('POST', '/auth/token', {
      body: {
        agent_id: DID,
        key_id: `${DID}#key-1`,
        nonce: ch.nonce,
        expires_at: ch.expires_at,
        algorithm: 'rsa-sha256',
        signature: sign(null, Buffer.from(ch.signing_input), privateKey).toString('base64'),
      },
    });
    expect(res.status).toBe(400);
  });

  it('serves an (empty) JWKS for an HS256 issuer, unauthenticated', async () => {
    const res = await pub.requestRaw('GET', '/.well-known/jwks.json');
    expect(res.status).toBe(200);
    // HS256 secrets are never published — an asymmetric issuer would list its key.
    expect(res.body).toEqual({ keys: [] });
  });
});

/**
 * EdDSA signing end-to-end. `jsonwebtoken` can't do EdDSA, so before the
 * jwt-codec fix this entire path threw ("not a valid algorithm"). This proves
 * mint → verify → bearer-use → JWKS all work with Ed25519.
 */
describe('Auth issuance — EdDSA signing (integration)', () => {
  let ctx: TestAppContext;
  let pub: TestClient;

  // Signing keypair for the CP itself (distinct from the agent's pinned key).
  const cpKeys = generateKeyPairSync('ed25519');
  const cpPrivPem = cpKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  beforeAll(async () => {
    ctx = await createTestApp({
      apiKey: 'issuer-eddsa-key',
      tokenIssuance: {
        jwtSecret: JWT_SECRET, // present but unused under EdDSA
        signingAlg: 'EdDSA',
        privateKeyPem: cpPrivPem,
        authority: AUTHORITY,
        pinnedKeys: `${DID}=${RAW_PUB_B64}`,
        tenantAgents: `${TENANT}:${DID}`,
      },
    });
    pub = new TestClient(ctx.url);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('mints an EdDSA-signed bearer that is accepted on a protected route', async () => {
    const ch = await pub.requestJson<ChallengeResp>('POST', '/auth/challenge', {
      body: { agent_id: DID },
    });
    const sig = sign(null, Buffer.from(ch.signing_input), privateKey).toString('base64');
    const tok = await pub.requestJson<TokenResp>('POST', '/auth/token', {
      body: {
        agent_id: DID,
        key_id: `${DID}#key-1`,
        nonce: ch.nonce,
        expires_at: ch.expires_at,
        algorithm: 'ed25519',
        signature: sig,
      },
    });
    expect(tok.token_type).toBe('Bearer');
    // The token header advertises EdDSA.
    const header = JSON.parse(Buffer.from(tok.token.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe('EdDSA');

    const bearer = new TestClient(ctx.url, tok.token);
    const res = await bearer.requestRaw('GET', '/runs');
    expect(res.status).toBe(200);
  });

  it('publishes the Ed25519 public key at /.well-known/jwks.json', async () => {
    const res = await pub.requestRaw('GET', '/.well-known/jwks.json');
    expect(res.status).toBe(200);
    const keys = (res.body as { keys: Array<Record<string, string>> }).keys;
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
    expect(keys[0].x).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

/**
 * Default-tenant regression: an agent NOT mapped via TENANT_AGENTS must still
 * receive a usable token. Before the fix, mintJwt stamped `tenant: 'default'`,
 * which the AuthGuard rejects as a reserved assertion — so the CP's own token
 * was 403'd. The token must now omit the tenant claim and resolve to `default`
 * through the claim's absence.
 */
describe('Auth issuance — unmapped agent / default tenant (integration)', () => {
  let ctx: TestAppContext;
  let pub: TestClient;

  beforeAll(async () => {
    ctx = await createTestApp({
      apiKey: 'issuer-default-key',
      tokenIssuance: {
        jwtSecret: JWT_SECRET,
        authority: AUTHORITY,
        pinnedKeys: `${DID}=${RAW_PUB_B64}`,
        // No tenantAgents → agent is unmapped, app is NOT in strict tenant mode.
      },
    });
    pub = new TestClient(ctx.url);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  async function mint(): Promise<TokenResp> {
    const ch = await pub.requestJson<ChallengeResp>('POST', '/auth/challenge', {
      body: { agent_id: DID },
    });
    const sig = sign(null, Buffer.from(ch.signing_input), privateKey).toString('base64');
    return pub.requestJson<TokenResp>('POST', '/auth/token', {
      body: {
        agent_id: DID,
        key_id: `${DID}#key-1`,
        nonce: ch.nonce,
        expires_at: ch.expires_at,
        algorithm: 'ed25519',
        signature: sig,
      },
    });
  }

  it('mints a token with NO tenant claim for an unmapped agent', async () => {
    const { token } = await mint();
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: AUTHORITY,
      audience: AUTHORITY,
    }) as Record<string, unknown>;
    expect(decoded.tenant).toBeUndefined();
  });

  it('accepts that token on a protected route (resolves to default via absence)', async () => {
    const { token } = await mint();
    const bearer = new TestClient(ctx.url, token);
    const res = await bearer.requestRaw('GET', '/runs');
    // Before the fix this was 403 (reserved-tenant assertion on the CP's own token).
    expect(res.status).toBe(200);
  });
});

// File-scoped: clear the import-time issuance flag so it doesn't leak into
// sibling integration specs that re-evaluate AppModule (single --runInBand
// process). Runs after every describe in this file.
afterAll(() => {
  delete process.env.TOKEN_ISSUANCE_ENABLED;
});
