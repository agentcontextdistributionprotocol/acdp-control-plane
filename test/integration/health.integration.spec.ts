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

  it('GET /healthz returns ok=true, service name, and a version string', async () => {
    const res = (await client.healthz()) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect(res.service).toBe('acdp-control-plane');
    expect(typeof res.version).toBe('string');
    expect((res.version as string).length).toBeGreaterThan(0);
  });

  it('GET /readyz reports database status', async () => {
    const res = (await client.readyz()) as Record<string, unknown>;
    expect(res).toHaveProperty('ok');
    expect(res).toHaveProperty('database');
    expect(res.database).toBe('ok');
  });

  it('GET and HEAD /readyz: 200 with Cache-Control: no-store (issue #210)', async () => {
    const noAuth = new TestClient(ctx.url);
    const get = await noAuth.requestRaw('GET', '/readyz');
    expect(get.status).toBe(200);
    expect(get.headers['cache-control']).toBe('no-store');
    expect(get.body).toMatchObject({ ok: true, database: 'ok', checks: { database: { status: 'up' } } });
    const head = await noAuth.requestRaw('HEAD', '/readyz');
    expect(head.status).toBe(200);
    expect(head.headers['cache-control']).toBe('no-store');
    expect(head.body).toBe('');
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

describe('Health Probes under AUTH_REQUIRE_TENANT strict mode (issue #210)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp({ requireTenant: true });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('a probe is @Public(): strict mode cannot reject it, and a spoofed X-Tenant-Id is ignored', async () => {
    const noAuth = new TestClient(ctx.url);
    for (const path of ['/healthz', '/readyz']) {
      const variants: Array<Record<string, string>> = [
        {},
        { 'X-Tenant-Id': 'spoofed-tenant' },
        { 'X-Tenant-Id': 'default' },
      ];
      for (const headers of variants) {
        const res = await noAuth.requestRaw('GET', path, { headers });
        expect({ path, headers, status: res.status }).toEqual({ path, headers, status: 200 });
      }
    }
  });
});
