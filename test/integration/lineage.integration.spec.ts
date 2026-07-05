import { createTestApp, TestAppContext } from '../helpers/test-app';

const SECRET = 'lineage-test-secret';

function event(
  ctxId: string,
  derivedFrom: string[],
  agentId = 'did:web:agent-a.example',
) {
  return {
    type: 'context_published',
    ctx_id: ctxId,
    lineage_id: 'lin-1',
    agent_id: agentId,
    context_type: 'observation',
    visibility: 'public',
    version: 1,
    derived_from: derivedFrom,
    registry_authority: 'registry-a.example',
    scenario_id: 'lineage-scenario',
    created_at: new Date().toISOString(),
  };
}

describe('Lineage DAG (integration)', () => {
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

  it('builds a DAG of nodes (context_published events) and directed edges (derived_from)', async () => {
    const runId = 'run-lineage-1';
    //   c1 ──┐
    //         ├──► c3
    //   c2 ──┘
    //               └──► c4
    await ctx.client.ingest(event('acdp://registry-a/c1', []), { runId, secret: SECRET });
    await ctx.client.ingest(event('acdp://registry-a/c2', []), { runId, secret: SECRET });
    await ctx.client.ingest(
      event('acdp://registry-a/c3', ['acdp://registry-a/c1', 'acdp://registry-a/c2']),
      { runId, secret: SECRET },
    );
    await ctx.client.ingest(event('acdp://registry-a/c4', ['acdp://registry-a/c3']), {
      runId,
      secret: SECRET,
    });

    const dag = (await ctx.client.getLineage(runId)) as {
      runId: string;
      nodes: Array<{ ctxId: string }>;
      edges: Array<{ from: string; to: string }>;
    };

    expect(dag.runId).toBe(runId);
    expect(dag.nodes.map((n) => n.ctxId).sort()).toEqual([
      'acdp://registry-a/c1',
      'acdp://registry-a/c2',
      'acdp://registry-a/c3',
      'acdp://registry-a/c4',
    ]);
    expect(dag.edges).toEqual(
      expect.arrayContaining([
        { from: 'acdp://registry-a/c1', to: 'acdp://registry-a/c3' },
        { from: 'acdp://registry-a/c2', to: 'acdp://registry-a/c3' },
        { from: 'acdp://registry-a/c3', to: 'acdp://registry-a/c4' },
      ]),
    );
    expect(dag.edges.length).toBe(3);
  });

  it('returns an empty DAG for a run with no published contexts', async () => {
    const runId = 'run-lineage-empty';
    await ctx.client.ingest(
      {
        type: 'context_archived',
        ctx_id: 'acdp://registry-a/c-archived',
        agent_id: 'did:web:agent-a.example',
        registry_authority: 'registry-a.example',
        scenario_id: 's',
        created_at: new Date().toISOString(),
      },
      { runId, secret: SECRET },
    );
    const dag = (await ctx.client.getLineage(runId)) as {
      nodes: unknown[];
      edges: unknown[];
    };
    expect(dag.nodes).toEqual([]);
    expect(dag.edges).toEqual([]);
  });

  // ── ACDP 0.3.0 lifecycle (RFC-ACDP-0013 retract / republish) ────────────

  function lifecycleEvent(
    type: 'context_retracted' | 'context_republished',
    ctxId: string,
    at: string,
    eventId: string,
  ) {
    // Flattened wire shape: no agent_id / created_at; `actor`, `event_id`
    // (actor-minted lifecycle id) and `at` instead.
    return {
      type,
      ctx_id: ctxId,
      lineage_id: 'lin-1',
      actor: 'did:web:agent-a.example',
      event_id: eventId,
      reason: 'test retraction',
      at,
      registry_authority: 'registry-a.example',
    };
  }

  it('flags retracted DAG nodes and clears the flag on republish (mark-not-delete)', async () => {
    const runId = 'run-lineage-retract';
    await ctx.client.ingest(event('acdp://registry-a/r1', []), { runId, secret: SECRET });
    await ctx.client.ingest(event('acdp://registry-a/r2', ['acdp://registry-a/r1']), {
      runId,
      secret: SECRET,
    });

    const retract = lifecycleEvent(
      'context_retracted',
      'acdp://registry-a/r2',
      new Date().toISOString(),
      'lc-evt-1',
    );
    await ctx.client.ingest(retract, { secret: SECRET });
    // Exact replay (same event_id) — dedup keeps everything single-shot.
    await ctx.client.ingest(retract, { secret: SECRET });

    let dag = (await ctx.client.getLineage(runId)) as {
      nodes: Array<{ ctxId: string; retracted: boolean }>;
      edges: unknown[];
    };
    // The retracted node STAYS in the DAG, flagged.
    expect(dag.nodes.length).toBe(2);
    expect(dag.edges.length).toBe(1);
    const byId = new Map(dag.nodes.map((n) => [n.ctxId, n.retracted]));
    expect(byId.get('acdp://registry-a/r1')).toBe(false);
    expect(byId.get('acdp://registry-a/r2')).toBe(true);

    await ctx.client.ingest(
      lifecycleEvent(
        'context_republished',
        'acdp://registry-a/r2',
        new Date(Date.now() + 1000).toISOString(),
        'lc-evt-2',
      ),
      { secret: SECRET },
    );

    dag = (await ctx.client.getLineage(runId)) as typeof dag;
    expect(dag.nodes.every((n) => n.retracted === false)).toBe(true);
  });

  it('ignores stale out-of-order lifecycle deliveries (timestamp-guarded)', async () => {
    const runId = 'run-lineage-ooo';
    await ctx.client.ingest(event('acdp://registry-a/o1', []), { runId, secret: SECRET });

    const t1 = '2026-01-01T00:00:00.000Z';
    const t2 = '2026-01-02T00:00:00.000Z';
    await ctx.client.ingest(
      lifecycleEvent('context_retracted', 'acdp://registry-a/o1', t1, 'lc-ooo-1'),
      { secret: SECRET },
    );
    await ctx.client.ingest(
      lifecycleEvent('context_republished', 'acdp://registry-a/o1', t2, 'lc-ooo-2'),
      { secret: SECRET },
    );
    // A stale re-transmission of the ORIGINAL retract under a fresh delivery
    // id must not regress the newer republished state.
    await ctx.client.ingest(
      lifecycleEvent('context_retracted', 'acdp://registry-a/o1', t1, 'lc-ooo-3'),
      { secret: SECRET },
    );

    const dag = (await ctx.client.getLineage(runId)) as {
      nodes: Array<{ ctxId: string; retracted: boolean }>;
    };
    expect(dag.nodes[0].retracted).toBe(false);
  });

  it('does not duplicate lineage edges when the same event is re-ingested', async () => {
    const runId = 'run-lineage-dedup';
    const ev = event('acdp://registry-a/c2', ['acdp://registry-a/c1']);
    await ctx.client.ingest(event('acdp://registry-a/c1', []), { runId, secret: SECRET });
    await ctx.client.ingest(ev, { runId, secret: SECRET });
    await ctx.client.ingest(ev, { runId, secret: SECRET });

    const dag = (await ctx.client.getLineage(runId)) as {
      edges: Array<{ from: string; to: string }>;
    };
    expect(dag.edges).toEqual([
      { from: 'acdp://registry-a/c1', to: 'acdp://registry-a/c2' },
    ]);
  });
});
