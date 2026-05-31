import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, lt, SQL } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { contextEvents, ContextEvent, NewContextEvent } from '../db/schema';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';

export interface ContextEventFilter {
  runId?: string;
  eventType?: string;
  agentId?: string;
  registryAuthority?: string;
  ctxId?: string;
  lineageId?: string;
  afterTs?: string;
  beforeTs?: string;
  limit?: number;
  tenantId?: string;
}

export interface ListByRunFilter {
  runId: string;
  eventType?: string;
  limit?: number;
  tenantId?: string;
}

@Injectable()
export class ContextEventRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Insert a raw event. When `input.fingerprint` is set, a duplicate
   * (same tenant + fingerprint) is silently skipped via the partial
   * unique index — returns null so the caller can short-circuit the
   * rest of the pipeline (ingest idempotency, FEAT-CP-03).
   */
  async create(input: NewContextEvent): Promise<ContextEvent | null> {
    const rows = await this.database.db
      .insert(contextEvents)
      .values(input)
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  }

  async listByRun(
    runId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<ContextEvent[]> {
    return this.database.db
      .select()
      .from(contextEvents)
      .where(and(eq(contextEvents.runId, runId), eq(contextEvents.tenantId, tenantId)))
      .orderBy(asc(contextEvents.eventTs));
  }

  async listByRunFiltered(
    filter: ListByRunFilter,
  ): Promise<{ data: ContextEvent[]; total: number }> {
    const conditions: SQL[] = [
      eq(contextEvents.runId, filter.runId),
      eq(contextEvents.tenantId, filter.tenantId ?? DEFAULT_TENANT_ID),
    ];
    if (filter.eventType) conditions.push(eq(contextEvents.eventType, filter.eventType));
    const limit = filter.limit ?? 200;

    const data = await this.database.db
      .select()
      .from(contextEvents)
      .where(and(...conditions))
      .orderBy(asc(contextEvents.eventTs))
      .limit(limit);

    return { data, total: data.length };
  }

  async listFiltered(
    filter: ContextEventFilter,
  ): Promise<{ data: ContextEvent[]; total: number }> {
    const conditions: SQL[] = [
      eq(contextEvents.tenantId, filter.tenantId ?? DEFAULT_TENANT_ID),
    ];
    if (filter.runId) conditions.push(eq(contextEvents.runId, filter.runId));
    if (filter.eventType) conditions.push(eq(contextEvents.eventType, filter.eventType));
    if (filter.agentId) conditions.push(eq(contextEvents.agentId, filter.agentId));
    if (filter.registryAuthority)
      conditions.push(eq(contextEvents.registryAuthority, filter.registryAuthority));
    if (filter.ctxId) conditions.push(eq(contextEvents.ctxId, filter.ctxId));
    if (filter.lineageId) conditions.push(eq(contextEvents.lineageId, filter.lineageId));
    if (filter.afterTs) conditions.push(gt(contextEvents.eventTs, filter.afterTs));
    if (filter.beforeTs) conditions.push(lt(contextEvents.eventTs, filter.beforeTs));

    const where = and(...conditions);
    const limit = filter.limit ?? 500;

    const [data, totalResult] = await Promise.all([
      this.database.db
        .select()
        .from(contextEvents)
        .where(where)
        .orderBy(desc(contextEvents.eventTs))
        .limit(limit),
      this.database.db.select({ value: count() }).from(contextEvents).where(where),
    ]);

    return { data, total: Number(totalResult[0]?.value ?? 0) };
  }

  /**
   * Delete events older than `cutoffIso` (by event_ts) across all tenants.
   * Used by the retention sweeper. Returns the number of rows deleted.
   */
  async deleteBefore(cutoffIso: string): Promise<number> {
    const deleted = await this.database.db
      .delete(contextEvents)
      .where(lt(contextEvents.eventTs, cutoffIso))
      .returning({ id: contextEvents.id });
    return deleted.length;
  }

  async countByAgent(
    agentId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<number> {
    const result = await this.database.db
      .select({ value: count() })
      .from(contextEvents)
      .where(and(eq(contextEvents.agentId, agentId), eq(contextEvents.tenantId, tenantId)));
    return Number(result[0]?.value ?? 0);
  }
}
