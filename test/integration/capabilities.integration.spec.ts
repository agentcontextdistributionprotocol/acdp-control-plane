// MUST be first: capability.declare is policy-gated on a subject DID, which
// only a bearer JWT carries — so this suite mints real tokens and needs the
// issuance routes mounted. AuthModule.forRoot() reads the flag at import time.
import '../helpers/enable-token-issuance';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';

const JWT_SECRET = 'integration-issuer-secret-key-0123456789';
const AUTHORITY = 'cp.test';
const DID = 'did:web:cp.test:agents:alice';
const TENANT = 'tenant-alpha';
const CAP_URI = 'urn:acdp:cap:publish:data_snapshot:finance';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' });
const RAW_PUB_B64 = Buffer.from(spki.subarray(spki.length - 32)).toString('base64');

interface ChallengeResp {
  nonce: string;
  expires_at: number;
  signing_input: string;
}

describe('Capabilities (integration)', () => {
  let ctx: TestAppContext;
  let pub: TestClient;
  let bearer: TestClient;

  beforeAll(async () => {
    ctx = await createTestApp({
      apiKey: 'cap-test-key',
      tokenIssuance: {
        jwtSecret: JWT_SECRET,
        authority: AUTHORITY,
        pinnedKeys: `${DID}=${RAW_PUB_B64}`,
        tenantAgents: `${TENANT}:${DID}`,
      },
    });
    pub = new TestClient(ctx.url);

    // Mint a bearer for the agent — its `sub` is the subjectDid the PolicyGuard
    // requires for capability.declare.
    const ch = await pub.requestJson<ChallengeResp>('POST', '/auth/challenge', {
      body: { agent_id: DID },
    });
    const sig = sign(null, Buffer.from(ch.signing_input), privateKey).toString('base64');
    const tok = await pub.requestJson<{ token: string }>('POST', '/auth/token', {
      body: {
        agent_id: DID,
        key_id: `${DID}#key-1`,
        nonce: ch.nonce,
        expires_at: ch.expires_at,
        algorithm: 'ed25519',
        signature: sig,
      },
    });
    bearer = new TestClient(ctx.url, tok.token);
  });

  afterAll(async () => {
    await ctx.app.close();
    delete process.env.TOKEN_ISSUANCE_ENABLED;
  });

  /** Sign `acdp-cap:v1:<did>:<uri>:<declared_at>` with the pinned key. */
  function declareBody(uri: string, declaredAt: string) {
    const assertion = `acdp-cap:v1:${DID}:${uri}:${declaredAt}`;
    return {
      agent_did: DID,
      capability_uri: uri,
      declared_at: declaredAt,
      key_id: `${DID}#key-1`,
      algorithm: 'ed25519',
      signature: sign(null, Buffer.from(assertion), privateKey).toString('base64'),
    };
  }

  it('rejects a capability declaration from an API-key caller (no subject DID)', async () => {
    // No bearer → no subjectDid → policy/auth refuses. (Strict tenant mode is on
    // because tenantAgents is set, so an unbound key is rejected outright.)
    const res = await pub.requestRaw('POST', '/capabilities', {
      headers: { Authorization: 'Bearer cap-test-key' },
      body: declareBody(CAP_URI, new Date().toISOString()),
    });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(404);
  });

  it('declares a capability with a valid signature (200) and echoes the record', async () => {
    const declaredAt = new Date().toISOString();
    const res = await bearer.requestRaw('POST', '/capabilities', {
      body: declareBody(CAP_URI, declaredAt),
    });
    expect(res.status).toBe(200);
    const body = res.body as { agent_did: string; capability_uri: string; signed_by: string };
    expect(body.agent_did).toBe(DID);
    expect(body.capability_uri).toBe(CAP_URI);
    expect(body.signed_by).toBe(`${DID}#key-1`);
  });

  it('is idempotent — redeclaring the same (agent, capability) returns the original', async () => {
    const first = await bearer.requestRaw('POST', '/capabilities', {
      body: declareBody(CAP_URI, new Date().toISOString()),
    });
    expect(first.status).toBe(200);
    const firstDeclaredAt = (first.body as { declared_at: string }).declared_at;

    // A second declare with a fresh declared_at returns the ORIGINAL row.
    const second = await bearer.requestRaw('POST', '/capabilities', {
      body: declareBody(CAP_URI, new Date(Date.now() + 1000).toISOString()),
    });
    expect(second.status).toBe(200);
    expect((second.body as { declared_at: string }).declared_at).toBe(firstDeclaredAt);
  });

  it('rejects a declaration whose signature does not verify (401)', async () => {
    const declaredAt = new Date().toISOString();
    const body = declareBody('urn:acdp:cap:analyze:prediction:finance', declaredAt);
    body.signature = Buffer.from('not-a-valid-signature').toString('base64');
    const res = await bearer.requestRaw('POST', '/capabilities', { body });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed capability URN (400)', async () => {
    const declaredAt = new Date().toISOString();
    const res = await bearer.requestRaw('POST', '/capabilities', {
      body: declareBody('not-a-urn', declaredAt),
    });
    expect(res.status).toBe(400);
  });

  it('finds the declaring agent via /capabilities/search', async () => {
    // Ensure the capability exists (declared above; idempotent if repeated).
    await bearer.requestRaw('POST', '/capabilities', {
      body: declareBody(CAP_URI, new Date().toISOString()),
    });
    const res = await bearer.requestJson<{ data: Array<{ agent_did: string }>; total: number }>(
      'GET',
      '/capabilities/search',
      { query: { capability: CAP_URI } },
    );
    expect(res.total).toBeGreaterThanOrEqual(1);
    expect(res.data.some((r) => r.agent_did === DID)).toBe(true);
  });

  it('400s a search with no `capability` query parameter', async () => {
    const res = await bearer.requestRaw('GET', '/capabilities/search');
    expect(res.status).toBe(400);
  });

  it('lists an agent’s capabilities via /capabilities/by-agent/*did', async () => {
    const res = await bearer.requestJson<{ data: Array<{ capability_uri: string }>; total: number }>(
      'GET',
      `/capabilities/by-agent/${DID}`,
    );
    expect(res.total).toBeGreaterThanOrEqual(1);
    expect(res.data.some((r) => r.capability_uri === CAP_URI)).toBe(true);
  });
});
