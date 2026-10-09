/**
 * Ingest trust + reliability (Phase 4): event dedup (FEAT-CP-03) and the
 * admin registry-enrollment endpoint (CP-3.1).
 */
import { DatabaseService } from '../../src/db/database.service';
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
    expect((denied.body as { errorCode: string }).errorCode).toBe('ADMIN_REQUIRED');
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

  // ── Enrollment tenant immutability (tenant-enroll-quota-fix P1) ─────────
  describe('enrollment tenant binding is immutable', () => {
    const SECRET_X = 'tenant-x-original-secret-0001';
    const SECRET_Y = 'tenant-y-hostile-secret-00001';

    async function enrollmentRow(authority: string) {
      const db = ctx.module.get(DatabaseService);
      const res = await db.pool.query(
        `SELECT authority, tenant_id, base_url, registry_did, webhook_secret, enabled,
                created_at::text AS created_at, updated_at::text AS updated_at
           FROM registry_enrollments WHERE authority = $1`,
        [authority],
      );
      return res.rows as Array<Record<string, unknown>>;
    }

    async function enrollX(admin: TestClient, authority: string) {
      const r = await admin.requestRaw('POST', '/registries/enroll', {
        body: {
          authority,
          tenantId: 'tenant-x',
          baseUrl: `https://${authority}`,
          registryDid: `did:web:${authority}`,
          webhookSecret: SECRET_X,
          enabled: true,
        },
      });
      expect(r.status).toBe(201);
      return r;
    }

    it('rejects a cross-tenant re-enroll with 409 and leaves the row unchanged', async () => {
      const admin = new TestClient(ctx.url, 'admin-key');
      await enrollX(admin, 'reg-imm.local');
      const before = await enrollmentRow('reg-imm.local');

      const resp = await admin.requestRaw('POST', '/registries/enroll', {
        body: {
          authority: 'reg-imm.local',
          tenantId: 'tenant-y',
          baseUrl: 'https://evil.example',
          webhookSecret: SECRET_Y,
          enabled: false,
        },
      });
      expect(resp.status).toBe(409);
      const body = resp.body as Record<string, unknown>;
      expect(body.errorCode).toBe('REGISTRY_ENROLLED_ELSEWHERE');
      // The body never names the owning tenant (only the caller's own may appear).
      expect(JSON.stringify(body)).not.toContain('tenant-x');

      const after = await enrollmentRow('reg-imm.local');
      expect(after).toEqual(before);
      expect(after[0]).toMatchObject({
        tenant_id: 'tenant-x',
        base_url: 'https://reg-imm.local',
        webhook_secret: SECRET_X,
        enabled: true,
      });
    });

    it('a same-tenant re-enroll succeeds (201) and updates the row', async () => {
      const admin = new TestClient(ctx.url, 'admin-key');
      await enrollX(admin, 'reg-same.local');
      const before = (await enrollmentRow('reg-same.local'))[0];

      const resp = await admin.requestRaw('POST', '/registries/enroll', {
        body: {
          authority: 'reg-same.local',
          tenantId: 'tenant-x',
          baseUrl: 'https://reg-same-new.local',
          webhookSecret: SECRET_X,
        },
      });
      expect(resp.status).toBe(201);
      expect(resp.body).toMatchObject({
        authority: 'reg-same.local',
        tenantId: 'tenant-x',
        baseUrl: 'https://reg-same-new.local',
      });
      const after = (await enrollmentRow('reg-same.local'))[0];
      expect(after).toMatchObject({ tenant_id: 'tenant-x', base_url: 'https://reg-same-new.local' });
      expect(after.created_at).toBe(before.created_at);
    });

    it('an unbound admin re-enrolling without tenantId (resolves to default) gets 409', async () => {
      const admin = new TestClient(ctx.url, 'admin-key');
      await enrollX(admin, 'reg-unbound.local');
      const before = await enrollmentRow('reg-unbound.local');

      const resp = await admin.requestRaw('POST', '/registries/enroll', {
        body: { authority: 'reg-unbound.local' },
      });
      expect(resp.status).toBe(409);
      expect((resp.body as { errorCode: string }).errorCode).toBe('REGISTRY_ENROLLED_ELSEWHERE');
      expect(JSON.stringify(resp.body)).not.toContain('tenant-x');
      expect(await enrollmentRow('reg-unbound.local')).toEqual(before);
    });

    it('two concurrent cross-tenant first-enrolls: exactly one succeeds', async () => {
      const admin = new TestClient(ctx.url, 'admin-key');
      for (let i = 0; i < 5; i++) {
        const authority = `reg-race-${i}.local`;
        const [a, b] = await Promise.all([
          admin.requestRaw('POST', '/registries/enroll', {
            body: { authority, tenantId: 'tenant-a' },
          }),
          admin.requestRaw('POST', '/registries/enroll', {
            body: { authority, tenantId: 'tenant-b' },
          }),
        ]);
        const statuses = [a.status, b.status].sort();
        expect(statuses).toEqual([201, 409]);
        const winner = a.status === 201 ? 'tenant-a' : 'tenant-b';
        const loser = a.status === 201 ? b : a;
        expect((loser.body as { errorCode: string }).errorCode).toBe(
          'REGISTRY_ENROLLED_ELSEWHERE',
        );
        const rows = await enrollmentRow(authority);
        expect(rows).toHaveLength(1);
        expect(rows[0].tenant_id).toBe(winner);
      }
    });

    it('after a rejected move, ingest still resolves the original tenant and secret', async () => {
      const admin = new TestClient(ctx.url, 'admin-key');
      const authority = 'reg-ingest-imm.local';
      await enrollX(admin, authority);
      const moved = await admin.requestRaw('POST', '/registries/enroll', {
        body: { authority, tenantId: 'tenant-y', webhookSecret: SECRET_Y },
      });
      expect(moved.status).toBe(409);

      const runId = 'imm-ingest-run';
      const evt = {
        type: 'context_published',
        run_id: runId,
        agent_id: 'did:web:agent.example',
        ctx_id: `acdp://${authority}/${runId}`,
        registry_authority: authority,
        context_type: 'data_snapshot',
        visibility: 'public',
        created_at: '2026-01-01T00:00:00Z',
      };
      // The would-be new owner's secret does not authenticate…
      const forged = await ctx.client.ingest(evt, { runId, secret: SECRET_Y });
      expect(forged.status).toBe(401);
      // …the original enrollment's secret still does, into the original tenant.
      const ok = await ctx.client.ingest(evt, { runId, secret: SECRET_X });
      expect(ok.status).toBe(204);

      const db = ctx.module.get(DatabaseService);
      const res = await db.pool.query(
        'SELECT tenant_id FROM context_events WHERE run_id = $1',
        [runId],
      );
      expect(res.rows).toEqual([{ tenant_id: 'tenant-x' }]);
    });
  });
});
