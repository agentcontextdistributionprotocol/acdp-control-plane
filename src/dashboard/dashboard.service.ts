import { Injectable } from '@nestjs/common';
import { and, count, countDistinct, desc, eq, gt, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { contextEvents, runs } from '../db/schema';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';

type Window = '1h' | '6h' | '24h' | '7d' | '30d';

const WINDOW_INTERVAL: Record<Window, string> = {
  '1h': '1 hour',
  '6h': '6 hours',
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};

export interface DashboardOverviewOptions {
  window?: Window;
  tenantId?: string;
}

@Injectable()
export class DashboardService {
  constructor(private readonly database: DatabaseService) {}

  async getOverview(opts: DashboardOverviewOptions) {
    const window: Window = opts.window ?? '24h';
    const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
    const interval = WINDOW_INTERVAL[window];
    const cutoff = sql`now() - interval '${sql.raw(interval)}'`;

    const [
      totalRuns,
      totalContexts,
      totalAgents,
      retractedContexts,
      recentRuns,
      byScenario,
      byRegistry,
      receiptCoverage,
      didMethods,
      logWitness,
    ] = await Promise.all([
      this.database.db
        .select({ n: count() })
        .from(runs)
        .where(and(eq(runs.tenantId, tenantId), gt(runs.startedAt, cutoff))),
      this.database.db
        .select({ n: count() })
        .from(contextEvents)
        .where(
          and(
            eq(contextEvents.tenantId, tenantId),
            eq(contextEvents.eventType, 'context_published'),
            gt(contextEvents.eventTs, cutoff),
          ),
        ),
      this.database.db
        .select({ n: countDistinct(contextEvents.agentId) })
        .from(contextEvents)
        .where(
          and(
            eq(contextEvents.tenantId, tenantId),
            gt(contextEvents.eventTs, cutoff),
          ),
        ),
      // ACDP 0.3.0 (RFC-ACDP-0013): of the contexts published in the window,
      // how many are CURRENTLY retracted. DISTINCT because retraction is
      // per-context while totalContexts counts publish events.
      this.database.db.execute(sql`
        SELECT count(DISTINCT ce.ctx_id)::int AS n
        FROM context_events ce
        JOIN context_lifecycle cl
          ON cl.tenant_id = ce.tenant_id AND cl.ctx_id = ce.ctx_id
        WHERE ce.tenant_id = ${tenantId}
          AND ce.event_type = 'context_published'
          AND ce.event_ts > now() - interval '${sql.raw(interval)}'
          AND cl.retracted
      `),
      this.database.db
        .select()
        .from(runs)
        .where(eq(runs.tenantId, tenantId))
        .orderBy(desc(runs.startedAt))
        .limit(10),
      this.database.db.execute(sql`
        SELECT scenario_id, count(*)::int AS run_count
        FROM runs
        WHERE tenant_id = ${tenantId}
          AND started_at > now() - interval '${sql.raw(interval)}'
        GROUP BY scenario_id
        ORDER BY run_count DESC
        LIMIT 10
      `),
      this.database.db.execute(sql`
        SELECT registry_authority, count(*)::int AS event_count
        FROM context_events
        WHERE tenant_id = ${tenantId}
          AND event_ts > now() - interval '${sql.raw(interval)}'
        GROUP BY registry_authority
        ORDER BY event_count DESC
        LIMIT 10
      `),
      // ACDP 0.2.0: registry-receipt coverage per registry (RFC-ACDP-0010).
      this.database.db.execute(sql`
        SELECT registry_authority,
               count(*)::int AS publish_count,
               count(*) FILTER (WHERE receipt_present)::int AS receipt_count
        FROM context_events
        WHERE tenant_id = ${tenantId}
          AND event_type = 'context_published'
          AND event_ts > now() - interval '${sql.raw(interval)}'
        GROUP BY registry_authority
        ORDER BY publish_count DESC
        LIMIT 10
      `),
      // ACDP 0.2.0: producer DID-method mix (did:web vs did:key).
      this.database.db.execute(sql`
        SELECT CASE
                 WHEN agent_id LIKE 'did:web:%' THEN 'did:web'
                 WHEN agent_id LIKE 'did:key:%' THEN 'did:key'
                 ELSE 'other'
               END AS method,
               count(*)::int AS publish_count
        FROM context_events
        WHERE tenant_id = ${tenantId}
          AND event_type = 'context_published'
          AND event_ts > now() - interval '${sql.raw(interval)}'
        GROUP BY 1
        ORDER BY publish_count DESC
      `),
      // ACDP 0.3.0 Tier 3: transparency-log witness tiles (RFC-ACDP-0012) —
      // how many distinct logs this control plane is witnessing, and how many
      // registries currently sit in an alerted state (root rewrite, split
      // view, regression, reset). Not window-scoped: witness state is a
      // current posture, not an event stream.
      this.database.db.execute(sql`
        SELECT
          (SELECT count(DISTINCT log_id)::int
             FROM log_witness_checkpoints
            WHERE tenant_id = ${tenantId}) AS witnessed_logs,
          (SELECT count(*)::int
             FROM log_witness_cursors
            WHERE tenant_id = ${tenantId} AND alerted) AS active_alerts
      `),
    ]);

    const contexts = Number(totalContexts[0]?.n ?? 0);
    const retracted = Number(
      (retractedContexts.rows[0] as { n?: number } | undefined)?.n ?? 0,
    );

    return {
      window,
      totalRuns: Number(totalRuns[0]?.n ?? 0),
      // Publish events in the window — unchanged for existing consumers.
      totalContexts: contexts,
      // ACDP 0.3.0 lifecycle tiles: currently-retracted contexts from the
      // window, and the net-live remainder (published − currently retracted).
      totalRetracted: retracted,
      totalContextsLive: contexts - retracted,
      totalAgents: Number(totalAgents[0]?.n ?? 0),
      recentRuns,
      byScenario: byScenario.rows,
      byRegistry: byRegistry.rows,
      receiptCoverage: receiptCoverage.rows,
      didMethods: didMethods.rows,
      // ACDP 0.3.0 Tier 3 (RFC-ACDP-0012): checkpoint-witness posture.
      logWitness: {
        witnessedLogs: Number(
          (logWitness.rows[0] as { witnessed_logs?: number } | undefined)?.witnessed_logs ?? 0,
        ),
        activeAlerts: Number(
          (logWitness.rows[0] as { active_alerts?: number } | undefined)?.active_alerts ?? 0,
        ),
      },
    };
  }
}
