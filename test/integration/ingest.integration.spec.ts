import { createHmac } from 'node:crypto';
import { createTestApp, TestAppContext } from '../helpers/test-app';

const SECRET = 'integration-test-secret';

function makeEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: 'context_published',
    ctx_id: 'acdp://registry-a.example/ctx-001',
    lineage_id: 'lineage-001',
    agent_id: 'did:web:agent-1.example',
    context_type: 'task',
    visibility: 'public',
    version: 1,
    derived_from: [],
    registry_authority: 'registry-a.example',
    scenario_id: 'scenario-x',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('Ingest pipeline (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp({ webhookSecret: SECRET });
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('accepts valid HMAC-signed events and persists the raw event + run + agent + registry', async () => {
    const runId = 'run-ingest-1';
    const payload = makeEvent();

    const res = await ctx.client.ingest(payload, { runId, secret: SECRET });
    expect(res.status).toBe(204);

    // Run record exists with the right scenario + registry list
    const run = (await ctx.client.getRun(runId)) as Record<string, unknown>;
    expect(run.runId).toBe(runId);
    expect(run.scenarioId).toBe('scenario-x');
    expect(run.registries).toEqual(['registry-a.example']);
    expect(run.contextsCount).toBe(1);

    // Cross-run event listing includes it
    const events = (await ctx.client.listEvents()) as { data: unknown[] };
    expect(events.data.length).toBe(1);

    // Agent + registry registries populated
    const agents = (await ctx.client.listAgents()) as { data: unknown[] };
    expect(agents.data.length).toBe(1);
    const registries = (await ctx.client.listRegistries()) as { data: unknown[] };
    expect(registries.data.length).toBe(1);
  });

  it('rejects events with a bad HMAC signature (401)', async () => {
    const payload = makeEvent();
    const body = JSON.stringify(payload);
    const wrongSig = createHmac('sha256', 'wrong-secret').update(body).digest('hex');

    const res = await ctx.client.requestRaw('POST', '/ingest/acdp', {
      rawBody: body,
      headers: {
        'Content-Type': 'application/json',
        'x-acdp-signature': `sha256=${wrongSig}`,
      },
    });
    expect(res.status).toBe(401);

    // Nothing persisted
    const events = (await ctx.client.listEvents()) as { data: unknown[] };
    expect(events.data.length).toBe(0);
  });

  it('rejects requests without a signature header (401)', async () => {
    const payload = makeEvent();
    const res = await ctx.client.requestRaw('POST', '/ingest/acdp', {
      body: payload,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects malformed JSON (400)', async () => {
    const validSig = createHmac('sha256', SECRET).update('not json').digest('hex');
    const res = await ctx.client.requestRaw('POST', '/ingest/acdp', {
      rawBody: 'not json',
      headers: {
        'Content-Type': 'application/json',
        'x-acdp-signature': `sha256=${validSig}`,
      },
    });
    expect(res.status).toBe(400);
  });

  it('rejects payloads missing required fields (400)', async () => {
    const payload = { type: 'context_published' }; // missing agent_id + registry_authority
    const res = await ctx.client.ingest(payload as Record<string, unknown>, {
      secret: SECRET,
    });
    expect(res.status).toBe(400);
  });

  it('accepts registry-shaped events that omit registry_authority by extracting it from ctx_id', async () => {
    const runId = 'run-ingest-registry-shape';
    // Matches the actual ACDP registry WebhookEvent: no explicit
    // registry_authority on the wire — the authority is encoded in ctx_id.
    const payload = {
      type: 'context_published',
      ctx_id: 'acdp://registry-z.example/01H7X4Z',
      lineage_id: 'lin-1',
      agent_id: 'did:web:agent-z.example',
      context_type: 'data_snapshot',
      visibility: 'public',
      version: 1,
      derived_from: [],
      created_at: new Date().toISOString(),
    };
    const res = await ctx.client.ingest(payload, { runId, secret: SECRET });
    expect(res.status).toBe(204);

    const run = (await ctx.client.getRun(runId)) as Record<string, unknown>;
    expect(run.registries).toEqual(['registry-z.example']);

    const registries = (await ctx.client.listRegistries()) as { data: unknown[] };
    expect(registries.data.length).toBe(1);
  });

  it('correlates multiple events by run_id (X-Run-Id header), incrementing contexts_count', async () => {
    const runId = 'run-ingest-multi';
    await ctx.client.ingest(
      makeEvent({ ctx_id: 'acdp://registry-a.example/c1' }),
      { runId, secret: SECRET },
    );
    await ctx.client.ingest(
      makeEvent({ ctx_id: 'acdp://registry-a.example/c2' }),
      { runId, secret: SECRET },
    );
    await ctx.client.ingest(
      makeEvent({
        ctx_id: 'acdp://registry-b.example/c3',
        registry_authority: 'registry-b.example',
      }),
      { runId, secret: SECRET },
    );

    const run = (await ctx.client.getRun(runId)) as Record<string, unknown>;
    expect(run.contextsCount).toBe(3);
    expect(run.registries).toEqual(
      expect.arrayContaining(['registry-a.example', 'registry-b.example']),
    );
    expect((run.registries as string[]).length).toBe(2);
  });

  it('GET /ingest/health is public and does not require auth', async () => {
    const noAuth = await ctx.client.requestRaw('GET', '/ingest/health', {
      headers: { Authorization: '' },
    });
    expect(noAuth.status).toBe(200);
    expect(noAuth.body).toEqual({ ok: true });
  });

  it('accepts run_id embedded in payload when no X-Run-Id header is provided', async () => {
    const runId = 'run-from-payload';
    await ctx.client.ingest(makeEvent({ run_id: runId }), { secret: SECRET });

    const run = (await ctx.client.getRun(runId)) as Record<string, unknown>;
    expect(run.runId).toBe(runId);
  });

  it('accepts a payload larger than the framework default (~200 kB, under the 1 MB ingest cap)', async () => {
    // Regression for the interop fix: the registry's max_payload_bytes is 1 MB,
    // but Express's ~100 kB default body-parser limit would 413 a legitimate
    // webhook before HMAC verification. main.ts (and the test harness) raise the
    // limit to INGEST_MAX_BODY_BYTES so bodies in the 100 kB–1 MB range pass.
    const runId = 'run-large-body';
    const payload = makeEvent({ run_id: runId, padding: 'x'.repeat(200_000) });
    const res = await ctx.client.ingest(payload, { secret: SECRET });
    expect(res.status).toBe(204);

    const run = (await ctx.client.getRun(runId)) as Record<string, unknown>;
    expect(run.runId).toBe(runId);
  });

  it('preserves an anc-001-shaped anchors array byte-identically through ingest and retrieval (RFC-ACDP-0016)', async () => {
    // CP-3: anchors are opaque, producer-authored, verification-side claims —
    // the control plane has no schema/DTO on this path (see main.ts's
    // ValidationPipe, which never applies here) and must not strip or
    // reject them. Shape lifted from the spec's anc-001 conformance fixture
    // (schemas/conformance/anc-001-well-formed-anchor.json).
    const runId = 'run-anchors-anc-001';
    const contentHash =
      'sha256:2a5fe49a82228322e0be1b9de8f5c7905f95b7f0fe469809e9c7399412206861';
    const anchors = [
      {
        scheme: 'macp.commitment',
        content_hash:
          'sha256:fa8fe6b9143b469866d31de09b81928cc44d226ed935162cd346ae80d14fd200',
      },
    ];
    const payload = makeEvent({
      ctx_id: 'acdp://registry-a.example/anc-001',
      content_hash: contentHash,
      anchors,
    });

    const res = await ctx.client.ingest(payload, { runId, secret: SECRET });
    expect(res.status).toBe(204);

    const events = (await ctx.client.getRunEvents(runId)) as {
      data: Array<Record<string, unknown>>;
    };
    expect(events.data.length).toBe(1);
    const stored = events.data[0].rawPayload as Record<string, unknown>;
    // Same content_hash in, same content_hash out; anchors untouched —
    // no code path re-derives, truncates, or filters this array.
    expect(stored.content_hash).toBe(contentHash);
    expect(stored.anchors).toEqual(anchors);
  });
});
