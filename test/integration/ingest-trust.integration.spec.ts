/**
 * Ingest trust + reliability (Phase 4): event dedup (FEAT-CP-03) and the
 * admin registry-enrollment endpoint (CP-3.1).
 */
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';

describe('Ingest trust & reliability (integration)', () => {
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

  function event(runId: string) {
    return {
      type: 'context_published',
      run_id: runId,
      agent_id: 'did:web:agent.example',
      ctx_id: `acdp://reg.local/${runId}`,
      registry_authority: 'reg.local',
      context_type: 'data_snapshot',
      visibility: 'public',
      created_at: '2026-01-01T00:00:00Z',
    };
  }

  it('dedupes a replayed webhook (same fingerprint) into a single event', async () => {
    const body = event('dedup-run');
    const r1 = await ctx.client.requestRaw('POST', '/ingest/acdp', { body });
    const r2 = await ctx.client.requestRaw('POST', '/ingest/acdp', { body });
    expect(r1.status).toBeLessThan(300);
    expect(r2.status).toBeLessThan(300); // replay still 204 — silently deduped
    await new Promise((r) => setTimeout(r, 100));

    const resp = await ctx.client.requestRaw('GET', '/events', { query: { runId: 'dedup-run' } });
    const data = (resp.body as { data: unknown[] }).data;
    expect(data.length).toBe(1);
  });

  it('dedupes on the X-ACDP-Event-Id header even when payload content differs', async () => {
    // Same registry-minted event_id across a retry whose body was reshaped
    // (different created_at) — would yield two distinct content fingerprints,
    // but the stable event_id collapses them to one (REG-P2-6).
    const base = event('evtid-run');
    const r1 = await ctx.client.requestRaw('POST', '/ingest/acdp', {
      body: { ...base, created_at: '2026-01-01T00:00:00Z' },
      headers: { 'x-acdp-event-id': 'stable-evt-1' },
    });
    const r2 = await ctx.client.requestRaw('POST', '/ingest/acdp', {
      body: { ...base, created_at: '2026-02-02T00:00:00Z' },
      headers: { 'x-acdp-event-id': 'stable-evt-1' },
    });
    expect(r1.status).toBeLessThan(300);
    expect(r2.status).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 100));

    const resp = await ctx.client.requestRaw('GET', '/events', { query: { runId: 'evtid-run' } });
    const data = (resp.body as { data: unknown[] }).data;
    expect(data.length).toBe(1);
  });

  it('accepts all three event variants (publish, retrieve, search) — retrieve/search carry no agent_id', async () => {
    const authority = 'reg.local';
    const runId = 'variants-run';
    const publish = event(runId);
    const retrieve = {
      type: 'context_retrieved',
      run_id: runId,
      ctx_id: `acdp://${authority}/${runId}`,
      registry_authority: authority,
      requester_did: 'did:web:reader.example',
      created_at: '2026-01-01T00:00:01Z',
    };
    const search = {
      type: 'search_executed',
      run_id: runId,
      registry_authority: authority,
      query: 'earnings',
      result_count: 2,
      created_at: '2026-01-01T00:00:02Z',
    };

    const rp = await ctx.client.requestRaw('POST', '/ingest/acdp', {
      body: publish,
      headers: { 'x-acdp-event-id': 'evt-pub' },
    });
    const rr = await ctx.client.requestRaw('POST', '/ingest/acdp', {
      body: retrieve,
      headers: { 'x-acdp-event-id': 'evt-ret' },
    });
    const rs = await ctx.client.requestRaw('POST', '/ingest/acdp', {
      body: search,
      headers: { 'x-acdp-event-id': 'evt-search' },
    });
    // The pre-fix guard 400'd retrieve/search for the missing agent_id.
    expect(rp.status).toBeLessThan(300);
    expect(rr.status).toBeLessThan(300);
    expect(rs.status).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 100));

    const resp = await ctx.client.requestRaw('GET', '/events', { query: { runId } });
    const data = (resp.body as { data: unknown[] }).data;
    expect(data.length).toBe(3);
  });

  it('dedupes an agent-less context_retrieved via the event_id', async () => {
    const authority = 'reg.local';
    const runId = 'retrieve-dedup-run';
    const retrieve = {
      type: 'context_retrieved',
      run_id: runId,
      ctx_id: `acdp://${authority}/${runId}`,
      registry_authority: authority,
      created_at: '2026-01-01T00:00:00Z',
    };
    const r1 = await ctx.client.requestRaw('POST', '/ingest/acdp', {
      body: retrieve,
      headers: { 'x-acdp-event-id': 'evt-ret-dup' },
    });
    const r2 = await ctx.client.requestRaw('POST', '/ingest/acdp', {
      body: { ...retrieve, created_at: '2026-02-02T00:00:00Z' },
      headers: { 'x-acdp-event-id': 'evt-ret-dup' },
    });
    expect(r1.status).toBeLessThan(300);
    expect(r2.status).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 100));

    const resp = await ctx.client.requestRaw('GET', '/events', { query: { runId } });
    const data = (resp.body as { data: unknown[] }).data;
    expect(data.length).toBe(1);
  });

  it('registry enroll is admin-only', async () => {
    const nonAdmin = new TestClient(ctx.url, 'test-key');
    const denied = await nonAdmin.requestRaw('POST', '/registries/enroll', {
      body: { authority: 'reg.local', tenantId: 'tenant-x' },
    });
    expect(denied.status).toBe(403);
  });

  it('admin can enroll a registry; the secret is never echoed back', async () => {
    const admin = new TestClient(ctx.url, 'admin-key');
    const resp = await admin.requestRaw('POST', '/registries/enroll', {
      body: {
        authority: 'reg.local',
        tenantId: 'tenant-x',
        baseUrl: 'https://reg.local',
        webhookSecret: 'a-sufficiently-long-secret',
      },
    });
    expect(resp.status).toBeLessThan(300);
    expect(resp.body).toMatchObject({ authority: 'reg.local', tenantId: 'tenant-x' });
    expect((resp.body as Record<string, unknown>).webhookSecret).toBeUndefined();
  });
});
