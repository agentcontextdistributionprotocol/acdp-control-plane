/**
 * Quota enforcement integration: per-tenant, per-action windowed counters
 * that return 429 + Retry-After on exceed.
 *
 * Ingest's `publish` quota is enforced INSIDE `IngestService.handle`, after
 * enrollment lookup, tenant resolution, HMAC verification and every 4xx
 * field/pack check (tenant-enroll-quota-fix P4) — not by `QuotaGuard`, which
 * would run before the signature is checked and before the tenant is known.
 * So only signed, accepted requests count, and they count against the
 * RESOLVED tenant: the enrollment's tenant for an enrolled authority, else
 * the `X-Tenant-Id` header (or `default`, the strict-mode fallback). The
 * `capability.declare` guard path is covered in capabilities.integration.spec.ts.
 */
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { resetQuotaCounters } from '../helpers/quota-reset';
import { TestClient } from '../helpers/test-client';

function event(runId: string, authority = 'r.local') {
  return {
    type: 'context_published',
    run_id: runId,
    agent_id: 'did:web:agent.example',
    ctx_id: `acdp://${authority}/${runId}`,
    context_type: 'data_snapshot',
    visibility: 'public',
    event_ts: new Date().toISOString(),
  };
}

describe('Quota enforcement (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    await resetQuotaCounters();
    // WEBHOOK_SECRET empty (dev mode) → HMAC is skipped, every request is
    // "signed"; unenrolled with no X-Tenant-Id → resolves to `default`.
    ctx = await createTestApp({ tenantQuotas: 'default:publish=2/min' });
  });

  afterAll(async () => {
    await ctx.cleanup();
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  it('allows up to the limit then 429s with a Retry-After header', async () => {
    // Window is per (tenant, action); every accepted request counts, so the
    // 3rd publish under a 2/min cap is the one that trips.
    const first = await ctx.client.requestRaw('POST', '/ingest/acdp', { body: event('q-1') });
    const second = await ctx.client.requestRaw('POST', '/ingest/acdp', { body: event('q-2') });
    expect(first.status).toBeLessThan(300);
    expect(second.status).toBeLessThan(300);

    const third = await ctx.client.requestRaw('POST', '/ingest/acdp', { body: event('q-3') });
    expect(third.status).toBe(429);
    // RFC 9110 Retry-After (delta-seconds) so clients can back off.
    expect(third.headers['retry-after']).toBeDefined();
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    // #182: QUOTA_EXCEEDED category + envelope details; legacy fields kept.
    const body = third.body as Record<string, unknown>;
    expect(body.errorCode).toBe('QUOTA_EXCEEDED');
    expect(body.code).toBe('rate_limited');
    expect(body.action).toBe('publish');
    expect(body.error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { action: 'publish', code: 'rate_limited' },
    });
  });
});

describe('Ingest quota is counted only after HMAC (integration)', () => {
  const GLOBAL_SECRET = 'global-webhook-secret-quota-0001';
  let ctx: TestAppContext;

  beforeAll(async () => {
    await resetQuotaCounters();
    ctx = await createTestApp({
      webhookSecret: GLOBAL_SECRET,
      tenantQuotas: 'default:publish=2/min',
    });
  });

  afterAll(async () => {
    await ctx.cleanup();
    await ctx.app.close();
  });

  it('a forged-signature flood beyond the limit stays 401 and leaves the budget intact', async () => {
    for (let i = 0; i < 5; i++) {
      const forged = await ctx.client.ingest(event(`forged-${i}`), {
        signatureOverride: 'sha256=' + '0'.repeat(64),
      });
      expect(forged.status).toBe(401);
      expect((forged.body as Record<string, unknown>).errorCode).toBe('INVALID_WEBHOOK_SIGNATURE');
    }

    // The full `default:publish=2/min` budget is still available…
    const ok1 = await ctx.client.ingest(event('valid-1'), { secret: GLOBAL_SECRET });
    const ok2 = await ctx.client.ingest(event('valid-2'), { secret: GLOBAL_SECRET });
    expect(ok1.status).toBe(204);
    expect(ok2.status).toBe(204);
    // …and the quota is genuinely live: the next valid request trips it.
    const over = await ctx.client.ingest(event('valid-3'), { secret: GLOBAL_SECRET });
    expect(over.status).toBe(429);
  });
});

describe('Ingest quota is charged to the enrollment-resolved tenant (integration)', () => {
  const GLOBAL_SECRET = 'global-webhook-secret-quota-0002';
  const SECRET_A = 'tenant-a-registry-secret-00001';
  let ctx: TestAppContext;

  beforeAll(async () => {
    await resetQuotaCounters();
    ctx = await createTestApp({
      adminApiKey: 'admin-key',
      webhookSecret: GLOBAL_SECRET,
      tenantQuotas: 'tenant-a:publish=2/min;default:publish=1/min',
    });
    const admin = new TestClient(ctx.url, 'admin-key');
    const enrolled = await admin.requestRaw('POST', '/registries/enroll', {
      body: { authority: 'reg-a.local', tenantId: 'tenant-a', webhookSecret: SECRET_A },
    });
    expect(enrolled.status).toBe(201);
  });

  afterAll(async () => {
    await ctx.cleanup();
    await ctx.app.close();
  });

  it("meters tenant-a's rule, not default's, and leaves the default counter untouched", async () => {
    // Enrolled authority → tenant-a (header ignored). tenant-a:publish=2/min.
    const a1 = await ctx.client.ingest(event('a-1', 'reg-a.local'), { secret: SECRET_A });
    const a2 = await ctx.client.ingest(event('a-2', 'reg-a.local'), { secret: SECRET_A });
    expect(a1.status).toBe(204);
    expect(a2.status).toBe(204);

    const a3 = await ctx.client.ingest(event('a-3', 'reg-a.local'), { secret: SECRET_A });
    expect(a3.status).toBe(429);
    expect(Number(a3.headers['retry-after'])).toBeGreaterThan(0);
    const body = a3.body as Record<string, unknown>;
    expect(body.errorCode).toBe('QUOTA_EXCEEDED');
    expect(body).toMatchObject({ tenantId: 'tenant-a', action: 'publish', limit: 2 });

    // default:publish=1/min — had tenant-a's three requests touched the
    // `default` counter, this unenrolled authority's FIRST request would 429.
    const d1 = await ctx.client.ingest(event('d-1', 'reg-free.local'), { secret: GLOBAL_SECRET });
    expect(d1.status).toBe(204);
    const d2 = await ctx.client.ingest(event('d-2', 'reg-free.local'), { secret: GLOBAL_SECRET });
    expect(d2.status).toBe(429);
    expect((d2.body as Record<string, unknown>).tenantId).toBe('default');

    // Every quota 429 is visible as an ingest rejection.
    const metrics = await ctx.client.metrics();
    expect(metrics).toMatch(/acdp_ingest_rejected_total\{reason="quota"\} 2/);
  });
});
