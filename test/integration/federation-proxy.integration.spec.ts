/**
 * Federation proxy integration: base-URL propagation (BUG-CP-07 /
 * FEAT-CP-04) + SSRF safety (FEAT-CP-05 / SEC-CP-01).
 *
 * The proxy can only reach a registry once its base_url is known. We
 * prove the two propagation paths (payload field + Origin header) and
 * that the SSRF guard refuses a loopback target — all without real
 * network egress, because a loopback base_url is rejected synchronously.
 */
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';

describe('Federation proxy (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp({});
  });

  afterAll(async () => {
    await ctx.cleanup();
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  const AUTHORITY = 'registry-a.example';
  const CTX_ID = `acdp://${AUTHORITY}/00000000-0000-0000-0000-000000000001`;
  const CTX_PATH = `/contexts/${encodeURIComponent(CTX_ID)}`;

  function ingestBody(extra: Record<string, unknown> = {}) {
    return {
      type: 'context_published',
      agent_id: 'did:web:agent.example',
      ctx_id: CTX_ID,
      registry_authority: AUTHORITY,
      context_type: 'data_snapshot',
      visibility: 'public',
      created_at: new Date().toISOString(),
      ...extra,
    };
  }

  it('returns 404 when the registry base_url was never propagated', async () => {
    await ctx.client.ingest(ingestBody());
    await new Promise((r) => setTimeout(r, 100));

    const resp = await ctx.client.requestRaw('GET', CTX_PATH);
    expect(resp.status).toBe(404); // unknown base_url, nothing to proxy to
  });

  it('propagates registry_base_url from the payload, then SSRF-blocks loopback (502)', async () => {
    // A loopback base_url is rejected by the SSRF guard — proves both that
    // the base_url propagated (else 404) and that the guard runs (502, not a
    // successful proxy to localhost).
    await ctx.client.ingest(ingestBody({ registry_base_url: 'https://localhost:9' }));
    await new Promise((r) => setTimeout(r, 100));

    const resp = await ctx.client.requestRaw('GET', CTX_PATH);
    expect(resp.status).toBe(502);
  });

  it('falls back to the Origin header for the registry base_url (502 once proxied)', async () => {
    const client = new TestClient(ctx.url, 'test-key');
    await client.requestRaw('POST', '/ingest/acdp', {
      body: ingestBody(),
      headers: {
        'X-ACDP-Event': 'context_published',
        Origin: 'https://localhost:9',
      },
    });
    await new Promise((r) => setTimeout(r, 100));

    const resp = await ctx.client.requestRaw('GET', CTX_PATH);
    expect(resp.status).toBe(502); // base_url came from Origin; SSRF-blocked
  });

  it('rejects a malformed ctx_id with 400', async () => {
    const resp = await ctx.client.requestRaw(
      'GET',
      `/contexts/${encodeURIComponent('not-an-acdp-uri')}`,
    );
    expect(resp.status).toBe(400);
  });
});
