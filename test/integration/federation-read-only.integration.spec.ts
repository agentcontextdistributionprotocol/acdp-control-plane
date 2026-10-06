// MUST be first: TOKEN_ISSUANCE_ENABLED is read when AppModule is evaluated.
import '../helpers/enable-token-issuance';
import jwt from 'jsonwebtoken';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';
import { TestSSEClient } from '../helpers/sse-client';

/**
 * Per-issuer `read_only` (#225) through the real AuthGuard → CrossIssuerValidator
 * stack, with two HS256 federation peers: `peer-ro` (flagged) and `peer-rw`
 * (unflagged — the D3 no-behaviour-change pin). First integration coverage of
 * TRUSTED_ISSUERS at all.
 */
const LOCAL_SECRET = 'local-ro-integration-secret-0123456789';
const RO_SECRET = 'R'.repeat(40);
const RW_SECRET = 'W'.repeat(40);
const TRUSTED =
  `peer-ro|HS256|${RO_SECRET}|peer-ro.example||read_only,` +
  `peer-rw|HS256|${RW_SECRET}|peer-rw.example`;

function peerToken(iss: string, secret: string, extra: Record<string, unknown> = {}): string {
  return jwt.sign(
    { sub: `did:web:${iss}.example:agents:a`, aud: `${iss}.example`, jti: `${iss}-${Math.random()}`, ...extra },
    secret,
    { algorithm: 'HS256', issuer: iss, expiresIn: 300 },
  );
}

describe('Per-issuer read_only (integration)', () => {
  let ctx: TestAppContext;
  let ro: TestClient;
  let rw: TestClient;
  let api: TestClient;

  beforeAll(async () => {
    ctx = await createTestApp({
      apiKey: 'local-api-key',
      trustedIssuers: TRUSTED,
      tokenIssuance: { jwtSecret: LOCAL_SECRET, authority: 'cp.test' },
    });
    ro = new TestClient(ctx.url, peerToken('peer-ro', RO_SECRET));
    rw = new TestClient(ctx.url, peerToken('peer-rw', RW_SECRET));
    api = new TestClient(ctx.url, 'local-api-key');
  });

  afterAll(async () => {
    delete process.env.TOKEN_ISSUANCE_ENABLED;
    delete process.env.TRUSTED_ISSUERS;
    await ctx.app.close();
  });

  const hook = { url: 'https://example.com/hook', events: ['context_published'], secret: 'wh-secret' };

  it('denies POST /webhooks for a read_only peer: 403 ISSUER_READ_ONLY, nothing created', async () => {
    const res = await ro.requestRaw('POST', '/webhooks', { body: hook });
    expect(res.status).toBe(403);
    expect((res.body as any).error.code).toBe('ISSUER_READ_ONLY');
    const listed = (await api.listWebhooks()) as unknown[];
    expect(listed).toHaveLength(0);
  });

  it('D3 pin: the unflagged peer can still POST /webhooks (201)', async () => {
    const res = await rw.requestRaw('POST', '/webhooks', { body: hook });
    expect(res.status).toBe(201);
  });

  it('local API key is unaffected', async () => {
    const res = await api.requestRaw('POST', '/webhooks', { body: hook });
    expect(res.status).toBe(201);
  });

  it('read_only peer may still read: GET /runs and the global SSE stream', async () => {
    expect((await ro.requestRaw('GET', '/runs')).status).toBe(200);
    const sse = new TestSSEClient(ctx.url, peerToken('peer-ro', RO_SECRET));
    await sse.connect('/events/stream');
    sse.close();
  });

  it('denies other CP-local writes for the read_only peer', async () => {
    for (const [method, path] of [
      ['POST', '/capabilities'],
      ['POST', '/auth/token/revoke'],
      ['DELETE', '/webhooks/does-not-matter'],
    ] as const) {
      const res = await ro.requestRaw(method, path, method === 'DELETE' ? {} : { body: {} });
      expect(res.status).toBe(403);
      expect((res.body as any).error.code).toBe('ISSUER_READ_ONLY');
    }
  });

  it('read_only peer may introspect (RFC 7662 POST exemption)', async () => {
    const tok = peerToken('peer-ro', RO_SECRET);
    const res = await ro.requestRaw('POST', '/auth/introspect', { body: { token: tok } });
    expect(res.status).toBe(200);
    expect((res.body as any).active).toBe(true);
  });

  it('a bad X-Tenant-Id is TENANT_MISMATCH-class precedence, not masked by read_only (claim vs header)', async () => {
    const tok = peerToken('peer-ro', RO_SECRET, { tenant: 'tenant-a' });
    const c = new TestClient(ctx.url, tok);
    const res = await c.requestRaw('POST', '/webhooks', { body: hook, headers: { 'x-tenant-id': 'tenant-b' } });
    expect(res.status).toBe(403);
    expect((res.body as any).error.code).toBe('TENANT_MISMATCH');
  });
});
