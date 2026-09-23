/**
 * Federation proxy integration: base-URL propagation (BUG-CP-07 /
 * FEAT-CP-04) + SSRF safety (FEAT-CP-05 / SEC-CP-01) + the RFC-ACDP-0006
 * §4.1 step 7 served-vs-requested `ctx_id` binding.
 *
 * The proxy can only reach a registry once its base_url is known. We
 * prove the two propagation paths (payload field + Origin header) and
 * that the SSRF guard refuses a loopback target — all without real
 * network egress, because a loopback base_url is rejected synchronously.
 *
 * The binding cases DO need an upstream that answers, so they stub
 * `SafeFederationClient.get` — that is the seam a hostile registry sits
 * behind, and the substitution attack this check exists for can only be
 * exercised end-to-end through the real route + exception filter.
 */
import { SafeFederationClient } from '../../src/contexts/safe-federation-client';
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
  // Canonical under `CtxId::parse`: lowercase DNS authority + lowercase v4 UUID.
  const CTX_UUID = 'abcdef01-2345-4678-9abc-def012345678';
  const CTX_ID = `acdp://${AUTHORITY}/${CTX_UUID}`;
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

  // The route's ctx_id grammar is the SDK's `CtxId::parse`, so these never
  // reach the registry — they would only have earned an upstream 400 anyway,
  // and 502 on this route is reserved for "the upstream misbehaved".
  const nonCanonical: Array<[string, string]> = [
    ['an uppercase authority', `acdp://REGISTRY-A.example/${CTX_UUID}`],
    ['a port-bearing authority', `acdp://${AUTHORITY}:8443/${CTX_UUID}`],
    ['a non-v4 uuid', `acdp://${AUTHORITY}/00000000-0000-0000-0000-000000000001`],
    ['an opaque (non-uuid) id', `acdp://${AUTHORITY}/ctx-1`],
  ];

  it.each(nonCanonical)(
    'rejects %s with 400 without any outbound request',
    async (_label, ctxId) => {
      const fed = jest.spyOn(ctx.module.get(SafeFederationClient), 'get');
      try {
        await ctx.client.ingest(ingestBody({ registry_base_url: 'https://registry-a.example' }));
        await new Promise((r) => setTimeout(r, 100));

        const resp = await ctx.client.requestRaw('GET', `/contexts/${encodeURIComponent(ctxId)}`);

        expect(resp.status).toBe(400);
        expect(fed).not.toHaveBeenCalled();
      } finally {
        fed.mockRestore();
      }
    },
  );

  // SSRF: an IP-literal base_url is refused synchronously (no DNS, no egress)
  // regardless of range — the guard is https-only + reject-IP-literal. Covers
  // cloud-metadata (IMDS) and the RFC-1918 / link-local private ranges.
  const ssrfTargets: Array<[string, string]> = [
    ['cloud metadata (IMDS)', 'https://169.254.169.254'],
    ['RFC-1918 10/8', 'https://10.0.0.1'],
    ['RFC-1918 192.168/16', 'https://192.168.1.1'],
    ['RFC-1918 172.16/12', 'https://172.16.0.1'],
    ['IPv6 loopback', 'https://[::1]:9'],
  ];

  it.each(ssrfTargets)(
    'SSRF-blocks a %s base_url (502, never egresses)',
    async (_label, baseUrl) => {
      await ctx.client.ingest(ingestBody({ registry_base_url: baseUrl }));
      await new Promise((r) => setTimeout(r, 100));

      const resp = await ctx.client.requestRaw('GET', CTX_PATH);
      expect(resp.status).toBe(502);
    },
  );

  it('rejects a plaintext http base_url (https-only; 502)', async () => {
    await ctx.client.ingest(ingestBody({ registry_base_url: 'http://registry-a.example' }));
    await new Promise((r) => setTimeout(r, 100));

    const resp = await ctx.client.requestRaw('GET', CTX_PATH);
    expect(resp.status).toBe(502);
  });

  // ── ctx_id binding (RFC-ACDP-0006 §4.1 step 7) ────────────────────────────
  //
  // `ctx_id` is registry-assigned and outside `content_hash` / producer
  // signature coverage (RFC-ACDP-0001 §5.7), so a registry can serve a
  // *different, validly signed* context under this URL and every other check
  // in the path passes. The substitution case below is the attack this check
  // exists for: it has to be proven end-to-end through the real route,
  // guards and exception filter, not only at the unit seam.
  describe('served-vs-requested ctx_id binding', () => {
    const OTHER_CTX_ID = `acdp://${AUTHORITY}/11111111-1111-4111-8111-111111111111`;
    const SECRET_MARKER = 'substituted-context-must-not-be-relayed';

    /** A `FullContext` the SDK's strict `Body` deserialization accepts. */
    function fullContext(ctxId: string): string {
      return JSON.stringify({
        body: {
          ctx_id: ctxId,
          lineage_id: 'lin:sha256:' + 'c'.repeat(64),
          origin_registry: AUTHORITY,
          created_at: '2026-06-12T00:00:00.000Z',
          content_hash: 'sha256:' + 'a'.repeat(64),
          signature: {
            algorithm: 'ed25519',
            key_id: 'did:web:agent.example#key-1',
            value: 'AAA',
          },
          version: 1,
          agent_id: 'did:web:agent.example',
          contributors: [],
          title: SECRET_MARKER,
          type: 'analysis',
          data_refs: [],
          derived_from: [],
          visibility: 'public',
        },
        registry_state: { status: 'active' },
      });
    }

    /** Enroll the registry, then answer its retrievals with `served`. */
    async function proxyWith(served: {
      status: number;
      contentType: string | null;
      body: string;
    }) {
      await ctx.client.ingest(ingestBody({ registry_base_url: `https://${AUTHORITY}` }));
      await new Promise((r) => setTimeout(r, 100));
      const fed = jest
        .spyOn(ctx.module.get(SafeFederationClient), 'get')
        .mockResolvedValue(served);
      try {
        return await ctx.client.requestRaw('GET', CTX_PATH);
      } finally {
        fed.mockRestore();
      }
    }

    it('relays a matching 2xx verbatim', async () => {
      const body = fullContext(CTX_ID);
      const resp = await proxyWith({
        status: 200,
        contentType: 'application/acdp+json',
        body,
      });

      expect(resp.status).toBe(200);
      expect(resp.headers['content-type']).toContain('application/acdp+json');
      expect(JSON.stringify(resp.body)).toBe(body);
    });

    it('refuses a substituted context: 502 CONTEXT_ID_MISMATCH, body never relayed', async () => {
      const resp = await proxyWith({
        status: 200,
        contentType: 'application/json',
        body: fullContext(OTHER_CTX_ID),
      });

      expect(resp.status).toBe(502);
      expect(resp.body).toMatchObject({
        statusCode: 502,
        errorCode: 'CONTEXT_ID_MISMATCH',
      });
      // The substituted body reaches the caller in NO form.
      expect(JSON.stringify(resp.body)).not.toContain(SECRET_MARKER);
      expect(JSON.stringify(resp.body)).not.toContain(OTHER_CTX_ID);
    });

    it('refuses an unverifiable 2xx with the DISTINCT CONTEXT_BINDING_UNVERIFIABLE code', async () => {
      const resp = await proxyWith({
        status: 200,
        contentType: 'text/html',
        body: `<html>${SECRET_MARKER}</html>`,
      });

      expect(resp.status).toBe(502);
      expect(resp.body).toMatchObject({
        statusCode: 502,
        errorCode: 'CONTEXT_BINDING_UNVERIFIABLE',
      });
      expect(JSON.stringify(resp.body)).not.toContain(SECRET_MARKER);
    });

    it('relays a non-2xx unchanged, with no binding check', async () => {
      // A registry's own 404 for a ctx_id it does not hold is not a
      // substitution — the public-only relay must still surface it verbatim.
      const resp = await proxyWith({
        status: 404,
        contentType: 'application/problem+json',
        body: '{"error":"not_found"}',
      });

      expect(resp.status).toBe(404);
      expect(resp.body).toEqual({ error: 'not_found' });
    });
  });
});
