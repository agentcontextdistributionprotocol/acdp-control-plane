import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';

describe('Health Probes (integration)', () => {
  let ctx: TestAppContext;
  let client: TestClient;

  beforeAll(async () => {
    ctx = await createTestApp();
    client = ctx.client;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('GET /healthz returns ok=true and service name', async () => {
    const res = (await client.healthz()) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect(res.service).toBe('acdp-control-plane');
  });

  it('GET /readyz reports database status', async () => {
    const res = (await client.readyz()) as Record<string, unknown>;
    expect(res).toHaveProperty('ok');
    expect(res).toHaveProperty('database');
    expect(res.database).toBe('ok');
  });

  it('GET /metrics returns Prometheus text', async () => {
    const text = await client.metrics();
    expect(typeof text).toBe('string');
    expect(text).toMatch(/process_cpu|nodejs_/);
  });

  it('GET /metrics exposes the app-specific acdp_* metrics, not just runtime defaults', async () => {
    const text = (await client.metrics()) as string;
    // InstrumentationService registers these at boot; a wiring regression
    // (metric constructed outside the service, registry cleared, renamed
    // prefix) would drop them even while default nodejs_* metrics survive.
    expect(text).toMatch(/^# TYPE acdp_/m);
  });

  it('health/metrics endpoints do not require auth', async () => {
    const noAuth = new TestClient(ctx.url);
    const healthRes = await noAuth.requestRaw('GET', '/healthz');
    const readyRes = await noAuth.requestRaw('GET', '/readyz');
    const metricsRes = await noAuth.requestRaw('GET', '/metrics');
    expect(healthRes.status).toBe(200);
    expect(readyRes.status).toBe(200);
    expect(metricsRes.status).toBe(200);
  });
});
