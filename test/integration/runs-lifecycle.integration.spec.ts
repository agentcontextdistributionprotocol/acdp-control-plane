import { createTestApp, TestAppContext } from '../helpers/test-app';

const SECRET = 'lifecycle-secret';

function event(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: 'context_published',
    ctx_id: 'acdp://registry-a/c-' + Math.random().toString(36).slice(2, 10),
    agent_id: 'did:web:agent-a.example',
    context_type: 'task',
    visibility: 'public',
    version: 1,
    derived_from: [],
    registry_authority: 'registry-a.example',
    scenario_id: 'lifecycle-scenario',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('Run lifecycle (integration)', () => {
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

  it('starts a run in "running" state when the first event arrives', async () => {
    const runId = 'run-lc-1';
    await ctx.client.ingest(event(), { runId, secret: SECRET });

    const run = (await ctx.client.getRun(runId)) as Record<string, unknown>;
    expect(run.status).toBe('running');
    expect(run.completedAt).toBeNull();
  });

  it('POST /runs/:runId/complete marks the run terminal and stores result', async () => {
    const runId = 'run-lc-2';
    await ctx.client.ingest(event(), { runId, secret: SECRET });

    const completeRes = await ctx.client.markRunComplete(
      runId,
      { status: 'completed', result: { answer: 42 } },
      { secret: SECRET },
    );
    expect(completeRes.status).toBe(204);

    const run = (await ctx.client.getRun(runId)) as Record<string, unknown>;
    expect(run.status).toBe('completed');
    expect(run.result).toEqual({ answer: 42 });
    expect(run.completedAt).not.toBeNull();
  });

  it('POST /runs/started attributes the scenario, overriding the ingest "unknown" fallback', async () => {
    const runId = 'run-lc-started';
    // The first ingest event creates the run with scenario_id='unknown'
    // (registry webhooks don't carry the scenario).
    await ctx.client.ingest(event({ scenario_id: undefined }), { runId, secret: SECRET });
    const before = (await ctx.client.getRun(runId)) as Record<string, unknown>;
    expect(before.scenarioId).toBe('unknown');

    const startedRes = await ctx.client.markRunStarted(
      { run_id: runId, scenario_id: 's1_single_publish', inputs: { topic: 'demo' } },
      { secret: SECRET },
    );
    expect(startedRes.status).toBe(204);

    const after = (await ctx.client.getRun(runId)) as Record<string, unknown>;
    expect(after.scenarioId).toBe('s1_single_publish');
    // Enrichment must not clobber ingest-accumulated counters.
    expect(after.contextsCount).toBe(1);
  });

  it('POST /runs/started creates the run when it notifies before any ingest event', async () => {
    const runId = 'run-lc-started-first';
    const startedRes = await ctx.client.markRunStarted(
      { run_id: runId, scenario_id: 's3_fanout' },
      { secret: SECRET },
    );
    expect(startedRes.status).toBe(204);

    const run = (await ctx.client.getRun(runId)) as Record<string, unknown>;
    expect(run.scenarioId).toBe('s3_fanout');
    expect(run.status).toBe('running');
  });

  it('rejects run-notify calls with a bad / missing HMAC signature (401)', async () => {
    const runId = 'run-lc-badsig';
    await ctx.client.ingest(event(), { runId, secret: SECRET });

    const badSig = await ctx.client.markRunComplete(
      runId,
      { status: 'completed' },
      { signatureOverride: 'sha256=deadbeef' },
    );
    expect(badSig.status).toBe(401);

    const noSig = await ctx.client.markRunStarted({ run_id: runId, scenario_id: 'x' });
    expect(noSig.status).toBe(401);
  });

  it('GET /runs filters by status and scenarioId, paginates', async () => {
    await ctx.client.ingest(event({ scenario_id: 'a' }), { runId: 'r-a-1', secret: SECRET });
    await ctx.client.ingest(event({ scenario_id: 'a' }), { runId: 'r-a-2', secret: SECRET });
    await ctx.client.ingest(event({ scenario_id: 'b' }), { runId: 'r-b-1', secret: SECRET });
    await ctx.client.markRunComplete('r-a-1', { status: 'completed' }, { secret: SECRET });

    const byScenario = (await ctx.client.listRuns({ scenarioId: 'a' })) as {
      data: unknown[];
      total: number;
    };
    expect(byScenario.total).toBe(2);

    const byStatus = (await ctx.client.listRuns({ status: 'completed' })) as {
      data: unknown[];
      total: number;
    };
    expect(byStatus.total).toBe(1);
    expect((byStatus.data[0] as { runId: string }).runId).toBe('r-a-1');

    const paged = (await ctx.client.listRuns({ limit: 1, offset: 0 })) as {
      data: unknown[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(paged.data.length).toBe(1);
    expect(paged.total).toBe(3);
    expect(paged.limit).toBe(1);
    expect(paged.offset).toBe(0);
  });

  it('GET /runs/:runId returns 404 for unknown runs', async () => {
    const res = await ctx.client.requestRaw('GET', '/runs/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('GET /runs/:runId/events lists context events ordered by event_ts', async () => {
    const runId = 'run-lc-events';
    const t1 = new Date(Date.now() - 2000).toISOString();
    const t2 = new Date(Date.now() - 1000).toISOString();
    await ctx.client.ingest(event({ created_at: t2 }), { runId, secret: SECRET });
    await ctx.client.ingest(event({ created_at: t1 }), { runId, secret: SECRET });

    const events = (await ctx.client.getRunEvents(runId)) as {
      data: Array<{ eventTs: string }>;
    };
    expect(events.data.length).toBe(2);
    expect(new Date(events.data[0].eventTs).getTime()).toBeLessThan(
      new Date(events.data[1].eventTs).getTime(),
    );
  });
});
