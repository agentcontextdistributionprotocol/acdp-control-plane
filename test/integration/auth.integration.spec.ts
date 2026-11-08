import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';

describe('Auth (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp({ apiKey: 'authn-test-key' });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('rejects requests without Authorization header (401)', async () => {
    const noAuth = new TestClient(ctx.url);
    const res = await noAuth.requestRaw('GET', '/runs');
    expect(res.status).toBe(401);
  });

  it('rejects requests with an unknown API key (401)', async () => {
    const wrong = new TestClient(ctx.url, 'wrong-key');
    const res = await wrong.requestRaw('GET', '/runs');
    expect(res.status).toBe(401);
  });

  it('accepts requests with the configured API key', async () => {
    const ok = new TestClient(ctx.url, 'authn-test-key');
    const res = await ok.requestRaw('GET', '/runs');
    expect(res.status).toBe(200);
  });

  it('@Public() endpoints (healthz, /ingest/health) are accessible without auth', async () => {
    const noAuth = new TestClient(ctx.url);
    expect((await noAuth.requestRaw('GET', '/healthz')).status).toBe(200);
    expect((await noAuth.requestRaw('GET', '/ingest/health')).status).toBe(200);
  });

  it('/metrics is not public: 401 without a key', async () => {
    const noAuth = new TestClient(ctx.url);
    expect((await noAuth.requestRaw('GET', '/metrics')).status).toBe(401);
  });
});
