/**
 * Quota enforcement integration: the QuotaGuard meters per-tenant, per-action
 * windowed counters and returns 429 + Retry-After on exceed. Ingest carries
 * `@CheckQuota('publish')`; with no tenant binding the request resolves to the
 * `default` tenant, so a `default:publish` rule gates it.
 */
import { createTestApp, TestAppContext } from '../helpers/test-app';

describe('Quota enforcement (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp({ tenantQuotas: 'default:publish=2/min' });
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
      ctx_id: `acdp://r.local/${runId}`,
      context_type: 'data_snapshot',
      visibility: 'public',
      event_ts: new Date().toISOString(),
    };
  }

  it('allows up to the limit then 429s with a Retry-After header', async () => {
    // Window is per (tenant, action); the guard increments only on allowed
    // requests, so the 3rd publish under a 2/min cap is the one that trips.
    const first = await ctx.client.requestRaw('POST', '/ingest/acdp', { body: event('q-1') });
    const second = await ctx.client.requestRaw('POST', '/ingest/acdp', { body: event('q-2') });
    expect(first.status).toBeLessThan(300);
    expect(second.status).toBeLessThan(300);

    const third = await ctx.client.requestRaw('POST', '/ingest/acdp', { body: event('q-3') });
    expect(third.status).toBe(429);
    // RFC 9110 Retry-After (delta-seconds) so clients can back off.
    expect(third.headers['retry-after']).toBeDefined();
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
  });
});
