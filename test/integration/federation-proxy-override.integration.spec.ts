/**
 * Federation proxy + REGISTRY_FETCH_URL_OVERRIDES, end-to-end with REAL
 * egress: the override points at a plain-http server on 127.0.0.1 — a target
 * the public-only SSRF policy refuses on two counts (http, loopback) — and the
 * proxy must reach it, relay the served bytes verbatim, and still run the
 * §4.1 step 7 ctx_id binding. An authority WITHOUT an override keeps the full
 * SSRF gate, so the bypass is scoped to exact configured authorities only.
 *
 * Config is read at construction, so the env var is set before
 * `createTestApp` and removed in `afterAll` — process.env is mutated in place
 * and would otherwise leak into later suites.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { createTestApp, TestAppContext } from '../helpers/test-app';

const AUTHORITY = 'registry-a.example';
const UNMAPPED = 'registry-z.example';
const CTX_ID = `acdp://${AUTHORITY}/abcdef01-2345-4678-9abc-def012345678`;
const OTHER_CTX_ID = `acdp://${AUTHORITY}/11111111-1111-4111-8111-111111111111`;
const UNMAPPED_CTX_ID = `acdp://${UNMAPPED}/abcdef01-2345-4678-9abc-def012345678`;

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
      title: 'served via the private-network override',
      type: 'analysis',
      data_refs: [],
      derived_from: [],
      visibility: 'public',
    },
    registry_state: { status: 'active' },
  });
}

describe('Federation proxy — REGISTRY_FETCH_URL_OVERRIDES (integration)', () => {
  let ctx: TestAppContext;
  let upstream: Server;
  let served: { status: number; body: string };
  const seenPaths: string[] = [];

  beforeAll(async () => {
    upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      seenPaths.push(req.url ?? '');
      res.writeHead(served.status, { 'content-type': 'application/acdp+json' });
      res.end(served.body);
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const { port } = upstream.address() as AddressInfo;
    // A path prefix proves the base is joined, not replaced.
    process.env.REGISTRY_FETCH_URL_OVERRIDES = JSON.stringify({
      [AUTHORITY]: `http://127.0.0.1:${port}/registries/a/`,
    });
    ctx = await createTestApp({});
  });

  afterAll(async () => {
    delete process.env.REGISTRY_FETCH_URL_OVERRIDES;
    await ctx.cleanup();
    await ctx.app.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  beforeEach(async () => {
    await ctx.cleanup();
    seenPaths.length = 0;
  });

  async function observe(authority: string, ctxId: string): Promise<void> {
    // The observed (payload-sourced) base_url is an SSRF-blocked loopback
    // https target: if the override were ignored this would 502.
    await ctx.client.ingest({
      type: 'context_published',
      agent_id: 'did:web:agent.example',
      ctx_id: ctxId,
      registry_authority: authority,
      registry_base_url: 'https://localhost:9',
      context_type: 'data_snapshot',
      visibility: 'public',
      created_at: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 100));
  }

  it('fetches the override target over http/loopback and relays the bytes verbatim', async () => {
    await observe(AUTHORITY, CTX_ID);
    served = { status: 200, body: fullContext(CTX_ID) };

    const resp = await ctx.client.requestRaw('GET', `/contexts/${encodeURIComponent(CTX_ID)}`);

    expect(resp.status).toBe(200);
    expect(resp.headers['content-type']).toContain('application/acdp+json');
    expect(JSON.stringify(resp.body)).toBe(served.body);
    expect(seenPaths).toEqual([`/registries/a/contexts/${encodeURIComponent(CTX_ID)}`]);
  });

  it('still enforces the ctx_id binding on the override path (502 CONTEXT_ID_MISMATCH)', async () => {
    await observe(AUTHORITY, CTX_ID);
    served = { status: 200, body: fullContext(OTHER_CTX_ID) };

    const resp = await ctx.client.requestRaw('GET', `/contexts/${encodeURIComponent(CTX_ID)}`);

    expect(resp.status).toBe(502);
    expect(resp.body).toMatchObject({ errorCode: 'CONTEXT_ID_MISMATCH' });
  });

  it('relays an upstream non-2xx from the override target unchanged', async () => {
    await observe(AUTHORITY, CTX_ID);
    served = { status: 404, body: '{"error":"not_found"}' };

    const resp = await ctx.client.requestRaw('GET', `/contexts/${encodeURIComponent(CTX_ID)}`);

    expect(resp.status).toBe(404);
    expect(resp.body).toEqual({ error: 'not_found' });
  });

  it('keeps the SSRF gate for an authority with no override (502, never egresses)', async () => {
    await observe(UNMAPPED, UNMAPPED_CTX_ID);
    served = { status: 200, body: fullContext(UNMAPPED_CTX_ID) };

    const resp = await ctx.client.requestRaw(
      'GET',
      `/contexts/${encodeURIComponent(UNMAPPED_CTX_ID)}`,
    );

    expect(resp.status).toBe(502);
    expect(resp.body).toMatchObject({ errorCode: 'FEDERATION_UPSTREAM_ERROR' });
    expect(seenPaths).toEqual([]);
  });

  it('does not widen tenancy: an overridden authority never observed in the tenant is 404', async () => {
    const resp = await ctx.client.requestRaw('GET', `/contexts/${encodeURIComponent(CTX_ID)}`);

    expect(resp.status).toBe(404);
    expect(resp.body).toMatchObject({ errorCode: 'REGISTRY_NOT_FOUND' });
    expect(seenPaths).toEqual([]);
  });
});
