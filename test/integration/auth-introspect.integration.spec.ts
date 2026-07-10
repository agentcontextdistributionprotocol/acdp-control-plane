// MUST be first: enables TOKEN_ISSUANCE_ENABLED before AppModule is imported
// (AuthModule.forRoot() reads it at module-evaluation time). The afterAll below
// deletes it so the flag does not leak into sibling integration specs.
import '../helpers/enable-token-issuance';
import { generateKeyPairSync, sign } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';

/**
 * RFC 7662 token introspection over HTTP — the full loop the unit specs
 * can't see: challenge → token → POST /auth/introspect through the real
 * AuthGuard + ValidationPipe + CrossIssuerValidator stack.
 */
const JWT_SECRET = 'introspect-integration-secret-0123456789';
const AUTHORITY = 'cp.test';
const DID = 'did:web:cp.test:agents:inspector';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' });
const RAW_PUB_B64 = Buffer.from(spki.subarray(spki.length - 32)).toString('base64');

interface ChallengeResp {
  nonce: string;
  expires_at: number;
  signing_input: string;
}
interface TokenResp {
  token: string;
  token_type: string;
  expires_at: number;
}
interface IntrospectResp {
  active: boolean;
  iss?: string;
  sub?: string;
  jti?: string;
  iat?: number;
  exp?: number;
  token_type?: string;
  registry?: string;
  [k: string]: unknown;
}

describe('Token introspection (integration)', () => {
  let ctx: TestAppContext;
  let client: TestClient; // API-key authed — introspection requires a caller principal
  let pub: TestClient; // unauthenticated — for @Public() issuance routes

  beforeAll(async () => {
    ctx = await createTestApp({
      apiKey: 'introspect-test-key',
      tokenIssuance: {
        jwtSecret: JWT_SECRET,
        authority: AUTHORITY,
        pinnedKeys: `${DID}=${RAW_PUB_B64}`,
      },
    });
    client = ctx.client;
    pub = new TestClient(ctx.url);
  });

  afterAll(async () => {
    delete process.env.TOKEN_ISSUANCE_ENABLED;
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

  it('returns active=true with canonical claims for a freshly issued token', async () => {
    const tok = await mintToken();
    const res = await client.requestRaw('POST', '/auth/introspect', {
      body: { token: tok.token },
    });

    expect(res.status).toBe(200);
    const body = res.body as IntrospectResp;
    expect(body.active).toBe(true);
    expect(body.iss).toBe(AUTHORITY);
    expect(body.sub).toBe(DID);
    expect(body.token_type).toBe('Bearer');
    expect(typeof body.jti).toBe('string');
    expect(body.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('collapses every failure mode to exactly {active:false} (RFC 7662 §2.2 — no oracle)', async () => {
    const garbage = await client.requestRaw('POST', '/auth/introspect', {
      body: { token: 'not-a-jwt' },
    });
    expect(garbage.status).toBe(200);
    expect(garbage.body).toEqual({ active: false });

    // Structurally valid JWT signed with the WRONG secret: same response
    // shape as garbage — a caller must not be able to tell them apart.
    const forged = jwt.sign({ sub: DID, iss: AUTHORITY }, 'wrong-secret-wrong-secret-wrong!!', {
      algorithm: 'HS256',
      expiresIn: 300,
    });
    const res = await client.requestRaw('POST', '/auth/introspect', {
      body: { token: forged },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('reports active=false for an expired token', async () => {
    const expired = jwt.sign(
      { sub: DID, iss: AUTHORITY, aud: AUTHORITY },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: -60 },
    );
    const res = await client.requestRaw('POST', '/auth/introspect', {
      body: { token: expired },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('rejects unauthenticated introspection — the endpoint must not be a public validity oracle', async () => {
    const tok = await mintToken();
    const res = await pub.requestRaw('POST', '/auth/introspect', {
      body: { token: tok.token },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a missing/empty token body with 400 (validation), not {active:false}', async () => {
    const res = await client.requestRaw('POST', '/auth/introspect', { body: {} });
    expect(res.status).toBe(400);
  });
});
