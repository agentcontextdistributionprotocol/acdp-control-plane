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
      recentRuns,
      byScenario,
      byRegistry,
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
    ]);

    return {
      window,
      totalRuns: Number(totalRuns[0]?.n ?? 0),
      totalContexts: Number(totalContexts[0]?.n ?? 0),
      totalAgents: Number(totalAgents[0]?.n ?? 0),
      recentRuns,
      byScenario: byScenario.rows,
      byRegistry: byRegistry.rows,
    };
  }
}
