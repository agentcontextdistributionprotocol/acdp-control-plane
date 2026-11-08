/**
 * Read-only API keys (AUTH_READ_ONLY_API_KEYS) + admin-only enrollment
 * listing, end-to-end through the real guard chain and exception filter.
 *
 * The console hands a non-admin key to its anonymous-read path. Before this,
 * that key could list enrolled registry base URLs and create/patch/delete
 * outbound webhook subscriptions (an attacker URL receiving every tenant
 * event). A read-only key may now only use safe methods, and
 * `GET /registries/enrollments` is admin-only.
 */
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';

const READ_ONLY_KEY = 'read-only-integration-key-0001';

describe('Read-only API key + admin-only enrollments (integration)', () => {
  let ctx: TestAppContext;
  let ro: TestClient;

  beforeAll(async () => {
    ctx = await createTestApp({ readOnlyApiKey: READ_ONLY_KEY });
    ro = new TestClient(ctx.url, READ_ONLY_KEY);
  });

  afterAll(async () => {
    await ctx.cleanup();
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  const hook = {
    url: 'https://subscriber.example/hook',
    events: ['context_published'],
    secret: 'whsec-integration',
  };

  it('reads with a read-only key (GET /runs, /webhooks, /registries → 200)', async () => {
    for (const path of ['/runs', '/webhooks', '/registries', '/events']) {
      const res = await ro.requestRaw('GET', path);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
  });

  it('denies POST /webhooks with 403 API_KEY_READ_ONLY before validation, nothing created', async () => {
    const bad = await ro.requestRaw('POST', '/webhooks', { body: {} });
    expect(bad.status).toBe(403);
    expect(bad.body).toMatchObject({ errorCode: 'API_KEY_READ_ONLY' });

    const res = await ro.requestRaw('POST', '/webhooks', { body: hook });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ statusCode: 403, errorCode: 'API_KEY_READ_ONLY' });

    const list = await ctx.adminClient.requestRaw('GET', '/webhooks');
    expect(list.status).toBe(200);
    const rows = Array.isArray(list.body) ? list.body : (list.body as { data: unknown[] }).data;
    expect(rows).toHaveLength(0);
  });

  it('denies PATCH / DELETE on an existing webhook, leaving it intact', async () => {
    const created = await ctx.client.requestRaw('POST', '/webhooks', { body: hook });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;

    const patch = await ro.requestRaw('PATCH', `/webhooks/${id}`, { body: { active: false } });
    expect(patch.status).toBe(403);
    expect(patch.body).toMatchObject({ errorCode: 'API_KEY_READ_ONLY' });
    const del = await ro.requestRaw('DELETE', `/webhooks/${id}`);
    expect(del.status).toBe(403);

    const list = await ctx.client.requestRaw('GET', '/webhooks');
    const rows = Array.isArray(list.body) ? list.body : (list.body as { data: unknown[] }).data;
    expect(rows).toHaveLength(1);
  });

  it('leaves an ordinary key read-write (POST /webhooks → 201)', async () => {
    const res = await ctx.client.requestRaw('POST', '/webhooks', { body: hook });
    expect(res.status).toBe(201);
  });

  it('GET /registries/enrollments: 403 ADMIN_REQUIRED for read-only and ordinary keys, 200 for admin', async () => {
    for (const client of [ro, ctx.client]) {
      const res = await client.requestRaw('GET', '/registries/enrollments');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ errorCode: 'ADMIN_REQUIRED' });
    }
    const admin = await ctx.adminClient.requestRaw('GET', '/registries/enrollments');
    expect(admin.status).toBe(200);
    expect(admin.body).toMatchObject({ data: [], total: 0 });
  });

  it('keeps /metrics admin-only for the read-only key (403)', async () => {
    const res = await ro.requestRaw('GET', '/metrics');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errorCode: 'ADMIN_REQUIRED' });
  });
});
