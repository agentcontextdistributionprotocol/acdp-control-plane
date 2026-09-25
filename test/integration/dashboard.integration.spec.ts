/**
 * Dashboard overview integration: exercises the full KPI aggregation —
 * including the raw `byScenario` / `byRegistry` GROUP BY queries that the
 * tenancy spec's count-only assertions don't reach — and the window param.
 */
import { AppConfigService } from '../../src/config/app-config.service';
import { createTestApp, TestAppContext } from '../helpers/test-app';

interface Overview {
  window: string;
  totalRuns: number;
  totalContexts: number;
  totalRetracted: number;
  totalContextsLive: number;
  totalAgents: number;
  recentRuns: Array<{ runId: string }>;
  byScenario: Array<{ scenario_id: string; run_count: number }>;
  byRegistry: Array<{ registry_authority: string; event_count: number }>;
  logWitness: {
    witnessedLogs: number;
    activeAlerts: number;
    unacknowledgedAlerts: number;
    headsMeetingQuorum: number;
  } | null;
  keyRevocation: {
    preCompromise: number;
    revokedAtOrAfter: number;
    revokedTimeUnverifiable: number;
  } | null;
  features: {
    receiptAudit: boolean;
    keyRevocationCheck: boolean;
    logWitness: boolean;
    logInclusionAudit: boolean;
    witnessCosigning: boolean;
    witnessQuorum: boolean;
  };
}

describe('Dashboard overview (integration)', () => {
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

  function event(runId: string, agentId: string, scenario: string, registry: string) {
    return {
      type: 'context_published',
      run_id: runId,
      agent_id: agentId,
      ctx_id: `acdp://${registry}/${runId}`,
      registry_authority: registry,
      context_type: 'data_snapshot',
      visibility: 'public',
      scenario_id: scenario,
      event_ts: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };
  }

  async function seed() {
    await ctx.client.requestRaw('POST', '/ingest/acdp', {
      body: event('run-1', 'did:web:a.example', 'scenario-x', 'reg-1.example'),
    });
    await ctx.client.requestRaw('POST', '/ingest/acdp', {
      body: event('run-2', 'did:web:b.example', 'scenario-x', 'reg-2.example'),
    });
    await ctx.client.requestRaw('POST', '/ingest/acdp', {
      body: event('run-3', 'did:web:a.example', 'scenario-y', 'reg-1.example'),
    });
    await new Promise((r) => setTimeout(r, 150));
  }

  it('aggregates totals, distinct agents, recent runs, and group-bys', async () => {
    await seed();
    const body = await ctx.client.requestJson<Overview>('GET', '/dashboard/overview');

    expect(body.window).toBe('24h'); // default window
    expect(body.totalRuns).toBe(3);
    expect(body.totalContexts).toBe(3);
    expect(body.totalAgents).toBe(2); // distinct agent DIDs (a + b)

    expect(body.recentRuns.length).toBe(3);
    // Most-recent-first ordering.
    expect(body.recentRuns.map((r) => r.runId)).toEqual(
      expect.arrayContaining(['run-1', 'run-2', 'run-3']),
    );

    // byScenario: scenario-x has 2 runs, scenario-y has 1 — ordered desc.
    const scenarioX = body.byScenario.find((s) => s.scenario_id === 'scenario-x');
    expect(scenarioX?.run_count).toBe(2);
    expect(body.byScenario[0].run_count).toBeGreaterThanOrEqual(
      body.byScenario[body.byScenario.length - 1].run_count,
    );

    // byRegistry: reg-1 has 2 events, reg-2 has 1.
    const reg1 = body.byRegistry.find((r) => r.registry_authority === 'reg-1.example');
    expect(reg1?.event_count).toBe(2);
  });

  it('counts currently-retracted contexts and the net-live remainder (ACDP 0.3.0)', async () => {
    await seed();
    // Retract run-2's context, then verify the tiles split published vs live.
    await ctx.client.requestRaw('POST', '/ingest/acdp', {
      body: {
        type: 'context_retracted',
        ctx_id: 'acdp://reg-2.example/run-2',
        lineage_id: 'lin-run-2',
        actor: 'did:web:b.example',
        event_id: 'lc-dash-1',
        reason: 'bad data',
        at: new Date().toISOString(),
        registry_authority: 'reg-2.example',
      },
    });
    await new Promise((r) => setTimeout(r, 150));

    let body = await ctx.client.requestJson<Overview>('GET', '/dashboard/overview');
    expect(body.totalContexts).toBe(3); // publish events, unchanged
    expect(body.totalRetracted).toBe(1);
    expect(body.totalContextsLive).toBe(2);

    // Republish restores the context to the live count.
    await ctx.client.requestRaw('POST', '/ingest/acdp', {
      body: {
        type: 'context_republished',
        ctx_id: 'acdp://reg-2.example/run-2',
        lineage_id: 'lin-run-2',
        actor: 'did:web:b.example',
        event_id: 'lc-dash-2',
        at: new Date(Date.now() + 1000).toISOString(),
        registry_authority: 'reg-2.example',
      },
    });
    await new Promise((r) => setTimeout(r, 150));

    body = await ctx.client.requestJson<Overview>('GET', '/dashboard/overview');
    expect(body.totalRetracted).toBe(0);
    expect(body.totalContextsLive).toBe(3);
  });

  it('honors the window query parameter', async () => {
    await seed();
    const body = await ctx.client.requestJson<Overview>('GET', '/dashboard/overview', {
      query: { window: '7d' },
    });
    expect(body.window).toBe('7d');
    expect(body.totalRuns).toBe(3);
  });

  it('returns an empty overview when there is no data', async () => {
    const body = await ctx.client.requestJson<Overview>('GET', '/dashboard/overview');
    expect(body.totalRuns).toBe(0);
    expect(body.totalContexts).toBe(0);
    expect(body.totalRetracted).toBe(0);
    expect(body.totalContextsLive).toBe(0);
    expect(body.totalAgents).toBe(0);
    expect(body.recentRuns).toEqual([]);
    expect(body.byScenario).toEqual([]);
    expect(body.byRegistry).toEqual([]);
  });

  // Issue #176: keyRevocation/logWitness were always populated with `?? 0`
  // defaults, so a tenant that never enabled the check couldn't be told apart
  // from one running it and finding nothing clean.
  it('nulls keyRevocation/logWitness and reports every flag false by default', async () => {
    const body = await ctx.client.requestJson<Overview>('GET', '/dashboard/overview');
    expect(body.keyRevocation).toBeNull();
    expect(body.logWitness).toBeNull();
    expect(body.features).toEqual({
      receiptAudit: false,
      keyRevocationCheck: false,
      logWitness: false,
      logInclusionAudit: false,
      witnessCosigning: false,
      witnessQuorum: false,
    });
  });

  it('populates keyRevocation/logWitness and flips features when their flags are enabled', async () => {
    // `keyRevocationCheckEnabled` is boot-validated to require
    // `receiptAuditEnabled` in production (app-config.service.ts:573-579),
    // but that check is skipped in development mode
    // (app-config.service.ts:445), which is what this harness runs in
    // (test-app.ts) — so it isn't enforced here. Flipping both together
    // anyway keeps this test representative of the real, valid combination,
    // mirroring the pattern in trust-hardening.integration.spec.ts:519-534.
    const config = ctx.module.get(AppConfigService) as unknown as {
      receiptAuditEnabled: boolean;
      keyRevocationCheckEnabled: boolean;
      logWitnessEnabled: boolean;
    };
    config.receiptAuditEnabled = true;
    config.keyRevocationCheckEnabled = true;
    config.logWitnessEnabled = true;
    try {
      const body = await ctx.client.requestJson<Overview>('GET', '/dashboard/overview');
      expect(body.keyRevocation).toEqual({
        preCompromise: 0,
        revokedAtOrAfter: 0,
        revokedTimeUnverifiable: 0,
      });
      expect(body.logWitness).toEqual({
        witnessedLogs: 0,
        activeAlerts: 0,
        unacknowledgedAlerts: 0,
        headsMeetingQuorum: 0,
      });
      expect(body.features.receiptAudit).toBe(true);
      expect(body.features.keyRevocationCheck).toBe(true);
      expect(body.features.logWitness).toBe(true);
    } finally {
      config.receiptAuditEnabled = false;
      config.keyRevocationCheckEnabled = false;
      config.logWitnessEnabled = false;
    }
  });
});
