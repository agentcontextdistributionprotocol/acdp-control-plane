/**
 * Phase 5 features: data-retention purge (FEAT-CP-02) and the admin
 * routing-stats endpoint (FEAT-CP-06).
 */
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';
import { DataRetentionService } from '../../src/retention/data-retention.service';

describe('Retention & routing (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp({ adminApiKey: 'admin-key' });
  });

  afterAll(async () => {
    await ctx.cleanup();
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  function event(runId: string, createdAt: string) {
    return {
      type: 'context_published',
      run_id: runId,
      agent_id: 'did:web:agent.example',
      ctx_id: `acdp://reg.local/${runId}`,
      registry_authority: 'reg.local',
      context_type: 'data_snapshot',
      visibility: 'public',
      created_at: createdAt,
    };
  }

  it('purge() deletes events older than the TTL and keeps recent ones', async () => {
    await ctx.client.requestRaw('POST', '/ingest/acdp', {
      body: event('old-run', '2000-01-01T00:00:00Z'),
    });
    await ctx.client.requestRaw('POST', '/ingest/acdp', {
      body: event('new-run', new Date().toISOString()),
    });
    await new Promise((r) => setTimeout(r, 100));

    const retention = ctx.module.get(DataRetentionService);
    const result = await retention.purge();
    expect(result.events).toBeGreaterThanOrEqual(1);

    const resp = await ctx.client.requestRaw('GET', '/events');
    const runIds = (resp.body as { data: Array<{ runId: string }> }).data.map((e) => e.runId);
    expect(runIds).toContain('new-run');
    expect(runIds).not.toContain('old-run');
  });

  it('routing stats are admin-only', async () => {
    const nonAdmin = new TestClient(ctx.url, 'test-key');
    const denied = await nonAdmin.requestRaw('GET', '/routing/stats');
    expect(denied.status).toBe(403);

    const admin = new TestClient(ctx.url, 'admin-key');
    const ok = await admin.requestRaw('GET', '/routing/stats');
    expect(ok.status).toBe(200);
    expect(Array.isArray((ok.body as { arms: unknown[] }).arms)).toBe(true);
  });
});
