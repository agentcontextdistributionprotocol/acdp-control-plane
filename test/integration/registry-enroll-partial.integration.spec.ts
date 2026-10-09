/**
 * Re-enroll is PATCH-like (tenant-enroll-quota-fix P2): a same-tenant
 * re-enroll of an existing authority keeps every field it omits (the
 * per-registry HMAC secret, base URL, DID, and an operator `enabled:false`),
 * and an explicit `null` clears the nullable fields. Runs with a GLOBAL
 * `WEBHOOK_SECRET` set so a cleared per-registry secret is observable as a
 * 401 for the old secret (ingest falls back to the global one).
 */
import { DatabaseService } from '../../src/db/database.service';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';

const GLOBAL_SECRET = 'global-webhook-secret-p2-000001';
const SECRET_S = 'per-registry-secret-p2-0000001';

describe('Registry re-enroll preserves omitted fields (integration)', () => {
  let ctx: TestAppContext;
  let admin: TestClient;

  beforeAll(async () => {
    ctx = await createTestApp({ adminApiKey: 'admin-key', webhookSecret: GLOBAL_SECRET });
    admin = new TestClient(ctx.url, 'admin-key');
  });

  afterAll(async () => {
    await ctx.cleanup();
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  async function row(authority: string) {
    const db = ctx.module.get(DatabaseService);
    const res = await db.pool.query(
      `SELECT authority, tenant_id, base_url, registry_did, webhook_secret, enabled,
              created_at::text AS created_at, updated_at::text AS updated_at
         FROM registry_enrollments WHERE authority = $1`,
      [authority],
    );
    return res.rows[0] as Record<string, unknown> | undefined;
  }

  async function enroll(body: Record<string, unknown>, expected = 201) {
    const r = await admin.requestRaw('POST', '/registries/enroll', { body });
    expect(r.status).toBe(expected);
    expect(JSON.stringify(r.body)).not.toContain(SECRET_S);
    return r;
  }

  function event(authority: string, runId: string) {
    return {
      type: 'context_published',
      run_id: runId,
      agent_id: 'did:web:agent.example',
      ctx_id: `acdp://${authority}/${runId}`,
      registry_authority: authority,
      context_type: 'data_snapshot',
      visibility: 'public',
      created_at: '2026-01-01T00:00:00Z',
    };
  }

  it('insert defaults are unchanged: omitted nullable fields NULL, enabled true', async () => {
    await enroll({ authority: 'p2-defaults.local', tenantId: 'tenant-x' });
    expect(await row('p2-defaults.local')).toMatchObject({
      tenant_id: 'tenant-x',
      base_url: null,
      registry_did: null,
      webhook_secret: null,
      enabled: true,
    });
  });

  it('re-enroll changing only baseUrl keeps the secret (ingest with S still 204) and created_at', async () => {
    const authority = 'p2-keep.local';
    await enroll({
      authority,
      tenantId: 'tenant-x',
      baseUrl: `https://${authority}`,
      registryDid: `did:web:${authority}`,
      webhookSecret: SECRET_S,
    });
    const before = await row(authority);

    const resp = await enroll({
      authority,
      tenantId: 'tenant-x',
      baseUrl: 'https://p2-keep-new.local',
    });
    expect(resp.body).toMatchObject({ baseUrl: 'https://p2-keep-new.local', enabled: true });
    expect(resp.body).not.toHaveProperty('webhookSecret');

    const after = await row(authority);
    expect(after).toMatchObject({
      tenant_id: 'tenant-x',
      base_url: 'https://p2-keep-new.local',
      registry_did: `did:web:${authority}`,
      webhook_secret: SECRET_S,
      enabled: true,
    });
    expect(after!.created_at).toBe(before!.created_at);

    const runId = 'p2-keep-run';
    const ok = await ctx.client.ingest(event(authority, runId), { runId, secret: SECRET_S });
    expect(ok.status).toBe(204);
    // The global secret is NOT accepted while the per-registry one is pinned.
    const viaGlobal = await ctx.client.ingest(event(authority, `${runId}-g`), {
      runId: `${runId}-g`,
      secret: GLOBAL_SECRET,
    });
    expect(viaGlobal.status).toBe(401);
  });

  it('a disabled registry stays disabled across a re-enroll that omits enabled (or sends null)', async () => {
    const authority = 'p2-disabled.local';
    await enroll({ authority, tenantId: 'tenant-x', webhookSecret: SECRET_S });
    await enroll({ authority, tenantId: 'tenant-x', enabled: false });
    expect(await row(authority)).toMatchObject({ enabled: false, webhook_secret: SECRET_S });

    await enroll({ authority, tenantId: 'tenant-x', baseUrl: `https://${authority}` });
    expect(await row(authority)).toMatchObject({ enabled: false, base_url: `https://${authority}` });

    // enabled:null is treated as omitted — never a NULL write (would 500).
    await enroll({ authority, tenantId: 'tenant-x', enabled: null });
    expect(await row(authority)).toMatchObject({ enabled: false });

    const runId = 'p2-disabled-run';
    const blocked = await ctx.client.ingest(event(authority, runId), { runId, secret: SECRET_S });
    expect(blocked.status).toBe(403);
    expect((blocked.body as { errorCode: string }).errorCode).toBe('REGISTRY_DISABLED');

    // An explicit enabled:true re-enables.
    await enroll({ authority, tenantId: 'tenant-x', enabled: true });
    expect(await row(authority)).toMatchObject({ enabled: true, webhook_secret: SECRET_S });
  });

  it('explicit null clears webhookSecret / baseUrl / registryDid; ingest falls back to the global secret', async () => {
    const authority = 'p2-clear.local';
    await enroll({
      authority,
      tenantId: 'tenant-x',
      baseUrl: `https://${authority}`,
      registryDid: `did:web:${authority}`,
      webhookSecret: SECRET_S,
    });
    const before = await row(authority);

    await enroll({ authority, tenantId: 'tenant-x', webhookSecret: null });
    let after = await row(authority);
    expect(after).toMatchObject({
      webhook_secret: null,
      // Untouched — only the explicitly-nulled field changed.
      base_url: `https://${authority}`,
      registry_did: `did:web:${authority}`,
      enabled: true,
    });
    expect(after!.created_at).toBe(before!.created_at);

    const runId = 'p2-clear-run';
    const withOld = await ctx.client.ingest(event(authority, runId), { runId, secret: SECRET_S });
    expect(withOld.status).toBe(401);
    const withGlobal = await ctx.client.ingest(event(authority, runId), {
      runId,
      secret: GLOBAL_SECRET,
    });
    expect(withGlobal.status).toBe(204);

    await enroll({ authority, tenantId: 'tenant-x', baseUrl: null, registryDid: null });
    after = await row(authority);
    expect(after).toMatchObject({ base_url: null, registry_did: null, webhook_secret: null });
  });

  it('a partial re-enroll from ANOTHER tenant is rejected (409) and changes nothing (incl. null-clear)', async () => {
    const authority = 'p2-xtenant.local';
    await enroll({ authority, tenantId: 'tenant-x', webhookSecret: SECRET_S });
    const before = await row(authority);
    await enroll({ authority, tenantId: 'tenant-y' }, 409);
    await enroll({ authority, tenantId: 'tenant-y', webhookSecret: null }, 409);
    await enroll({ authority, tenantId: 'tenant-y', enabled: false }, 409);
    expect(await row(authority)).toEqual(before);
  });

  it('a short or empty secret is still rejected (400) and leaves the row untouched', async () => {
    const authority = 'p2-short.local';
    await enroll({ authority, tenantId: 'tenant-x', webhookSecret: SECRET_S });
    const before = await row(authority);
    await enroll({ authority, tenantId: 'tenant-x', webhookSecret: '' }, 400);
    await enroll({ authority, tenantId: 'tenant-x', webhookSecret: 'short' }, 400);
    expect(await row(authority)).toEqual(before);
  });
});
