/**
 * Cross-tenant isolation integration test.
 *
 * Per deferred-plan §6: tenant-A's data MUST NOT be readable by a
 * request bearing tenant-B credentials. This spec writes events
 * under both tenants then exercises GET /runs from each side and
 * asserts the isolation.
 *
 * Coverage is intentionally narrow — proves the tenant gate works
 * end-to-end on at least one controller path. Per-controller
 * regressions would be caught by their own specs (most read paths
 * are filtered at the repository layer).
 */
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';
import { TestSSEClient } from '../helpers/sse-client';

describe('Cross-tenant isolation (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp({
      tenantApiKeys: [
        { tenantId: 'tenant-a', apiKey: 'key-a' },
        { tenantId: 'tenant-b', apiKey: 'key-b' },
      ],
    });
  });

  afterAll(async () => {
    await ctx.cleanup();
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Helper: send a registry webhook tagged with `X-Tenant-Id`. The
   * ingest endpoint is `@Public()` (authenticated by HMAC, not bearer)
   * so AuthGuard doesn't pin tenantId from a key — the upstream
   * registry sets the header to attribute the event to a tenant.
   */
  async function publishEvent(tenantId: string, runId: string) {
    // Auth header is irrelevant on @Public ingest, but TestClient
    // requires a key. Any non-empty key works since AUTH_API_KEYS
    // is populated (any of the tenant keys would pass).
    const client = new TestClient(ctx.url, 'key-a');
    const body = {
      type: 'context_published',
      run_id: runId,
      agent_id: 'did:web:agent.example',
      ctx_id: `acdp://r.local/${runId}`,
      lineage_id: 'lin:sha256:x',
      context_type: 'data_snapshot',
      visibility: 'public',
      version: 1,
      derived_from: [],
      scenario_id: 'test-scenario',
      event_ts: new Date().toISOString(),
    };
    return client.requestRaw('POST', '/ingest/acdp', {
      // Pass the object directly — requestRaw JSON-stringifies it once.
      // Passing a pre-stringified string here double-encodes the body, so
      // the server parses a JSON string literal (not an object) and ingest
      // rejects it with 400 "Payload must be an object".
      body,
      headers: {
        'X-ACDP-Event': 'context_published',
        'X-Tenant-Id': tenantId,
      },
    });
  }

  it('two tenants each see only their own runs via GET /runs', async () => {
    // Tenant A writes one run; tenant B writes a different one.
    const r1 = await publishEvent('tenant-a', 'run-tenant-a-1');
    expect(r1.status).toBeLessThan(300);
    const r2 = await publishEvent('tenant-b', 'run-tenant-b-1');
    expect(r2.status).toBeLessThan(300);

    // Allow processing to settle (IngestService is synchronous in V1).
    await new Promise((r) => setTimeout(r, 100));

    const clientA = new TestClient(ctx.url, 'key-a');
    const clientB = new TestClient(ctx.url, 'key-b');

    const aResp = await clientA.requestRaw('GET', '/runs');
    const bResp = await clientB.requestRaw('GET', '/runs');
    expect(aResp.status).toBe(200);
    expect(bResp.status).toBe(200);
    const aBody = aResp.body as { data: Array<{ runId: string }> };
    const bBody = bResp.body as { data: Array<{ runId: string }> };

    // Tenant A sees its run; tenant B sees its run; neither sees the
    // other's run.
    const aIds = aBody.data.map((r) => r.runId);
    const bIds = bBody.data.map((r) => r.runId);
    expect(aIds).toContain('run-tenant-a-1');
    expect(aIds).not.toContain('run-tenant-b-1');
    expect(bIds).toContain('run-tenant-b-1');
    expect(bIds).not.toContain('run-tenant-a-1');
  });

  it('GET /runs/:runId for the other tenant\'s run returns 404', async () => {
    const r = await publishEvent('tenant-a', 'run-only-a');
    expect(r.status).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 100));

    const clientB = new TestClient(ctx.url, 'key-b');
    const resp = await clientB.requestRaw('GET', '/runs/run-only-a');
    expect(resp.status).toBe(404);
  });

  it('GET /events is tenant-scoped: each tenant sees only its own events', async () => {
    await publishEvent('tenant-a', 'run-events-a');
    await publishEvent('tenant-b', 'run-events-b');
    await new Promise((r) => setTimeout(r, 100));

    const clientA = new TestClient(ctx.url, 'key-a');
    const clientB = new TestClient(ctx.url, 'key-b');

    const aResp = await clientA.requestRaw('GET', '/events');
    const bResp = await clientB.requestRaw('GET', '/events');
    expect(aResp.status).toBe(200);
    expect(bResp.status).toBe(200);
    const aRuns = (aResp.body as { data: Array<{ runId: string }> }).data.map((e) => e.runId);
    const bRuns = (bResp.body as { data: Array<{ runId: string }> }).data.map((e) => e.runId);
    expect(aRuns).toContain('run-events-a');
    expect(aRuns).not.toContain('run-events-b');
    expect(bRuns).toContain('run-events-b');
    expect(bRuns).not.toContain('run-events-a');
  });

  it('GET /dashboard/overview counts only the caller\'s tenant', async () => {
    await publishEvent('tenant-a', 'run-dash-a');
    await new Promise((r) => setTimeout(r, 100));

    const clientB = new TestClient(ctx.url, 'key-b');
    const bResp = await clientB.requestRaw('GET', '/dashboard/overview');
    expect(bResp.status).toBe(200);
    // Tenant B has no runs — its dashboard must not count tenant A's run.
    expect((bResp.body as { totalRuns: number }).totalRuns).toBe(0);

    const clientA = new TestClient(ctx.url, 'key-a');
    const aResp = await clientA.requestRaw('GET', '/dashboard/overview');
    expect((aResp.body as { totalRuns: number }).totalRuns).toBeGreaterThanOrEqual(1);
  });

  it('global SSE feed is tenant-isolated: tenant A does not receive tenant B events', async () => {
    const sseA = new TestSSEClient(ctx.url, 'key-a');
    await sseA.connect('/events/stream');
    try {
      // Tenant B publishes — tenant A's stream must not receive it.
      await publishEvent('tenant-b', 'run-sse-b');
      // Then tenant A publishes — used as a liveness marker.
      await publishEvent('tenant-a', 'run-sse-a');

      const evt = await sseA.waitForEvent('context_published', 5000);
      const data = evt.data as { runId?: string };
      expect(data.runId).toBe('run-sse-a');
      // Only the tenant-A event should have been delivered.
      const runIds = sseA.getDataEvents().map((e) => (e.data as { runId?: string }).runId);
      expect(runIds).not.toContain('run-sse-b');
    } finally {
      sseA.close();
    }
  });

  it('composite keys: the same runId can exist under two tenants without collision', async () => {
    // Both tenants publish an event for the SAME run id.
    const ra = await publishEvent('tenant-a', 'shared-run-id');
    const rb = await publishEvent('tenant-b', 'shared-run-id');
    expect(ra.status).toBeLessThan(300);
    expect(rb.status).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 100));

    const clientA = new TestClient(ctx.url, 'key-a');
    const clientB = new TestClient(ctx.url, 'key-b');

    // Each tenant resolves its OWN row for the shared id (no 404, no cross-read).
    const aRun = await clientA.requestRaw('GET', '/runs/shared-run-id');
    const bRun = await clientB.requestRaw('GET', '/runs/shared-run-id');
    expect(aRun.status).toBe(200);
    expect(bRun.status).toBe(200);
    expect((aRun.body as { runId: string }).runId).toBe('shared-run-id');
    expect((bRun.body as { runId: string }).runId).toBe('shared-run-id');
  });

  it('per-run SSE rejects a cross-tenant subscriber with 404', async () => {
    await publishEvent('tenant-a', 'run-sse-owned-a');
    await new Promise((r) => setTimeout(r, 100));

    const sseB = new TestSSEClient(ctx.url, 'key-b');
    await expect(sseB.connect('/runs/run-sse-owned-a/events/stream')).rejects.toThrow(
      /HTTP 404/,
    );
    sseB.close();
  });

  describe('X-Tenant-Id spoofing defenses', () => {
    it('rejects a header asserting a tenant other than the key is bound to (403)', async () => {
      // key-a is bound to tenant-a; claiming tenant-b via the header is hostile.
      const clientA = new TestClient(ctx.url, 'key-a');
      const res = await clientA.requestRaw('GET', '/runs', {
        headers: { 'X-Tenant-Id': 'tenant-b' },
      });
      expect(res.status).toBe(403);
    });

    it('rejects an explicit assertion of the reserved `default` tenant (403)', async () => {
      // `default` is the silent untenanted sentinel — reachable only by the
      // ABSENCE of an assertion, never by asserting it.
      const clientA = new TestClient(ctx.url, 'key-a');
      const res = await clientA.requestRaw('GET', '/runs', {
        headers: { 'X-Tenant-Id': 'default' },
      });
      expect(res.status).toBe(403);
    });

    it('allows a header that agrees with the key-bound tenant (200)', async () => {
      const clientA = new TestClient(ctx.url, 'key-a');
      const res = await clientA.requestRaw('GET', '/runs', {
        headers: { 'X-Tenant-Id': 'tenant-a' },
      });
      expect(res.status).toBe(200);
    });
  });
});
