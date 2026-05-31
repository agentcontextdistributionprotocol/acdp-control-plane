import { Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, inArray, lt, ne, sql, SQL } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { Run, runs } from '../db/schema';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';

export interface ListRunsOptions {
  status?: string;
  scenarioId?: string;
  limit: number;
  offset: number;
  /** Required when reading from a multi-tenant deployment. */
  tenantId?: string;
}

@Injectable()
export class RunRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Upsert a run record from an incoming event. New runs are created in
   * 'running' state; existing runs get their contexts_count and registries
   * updated.
   *
   * Multi-tenant note: `tenantId` defaults to `DEFAULT_TENANT_ID` so
   * existing single-tenant callers don't have to thread it through;
   * the AuthGuard pins it on the request for new flows.
   */
  async upsertFromEvent(
    runId: string,
    scenarioId: string,
    registryAuthority: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<void> {
    const existing = await this.database.db
      .select()
      .from(runs)
      .where(and(eq(runs.runId, runId), eq(runs.tenantId, tenantId)))
      .limit(1);

    if (existing.length === 0) {
      await this.database.db.insert(runs).values({
        runId,
        tenantId,
        scenarioId,
        status: 'running',
        contextsCount: 1,
        registries: registryAuthority ? [registryAuthority] : [],
      });
      return;
    }

    const current = existing[0];
    const updatedRegistries =
      !registryAuthority || current.registries.includes(registryAuthority)
        ? current.registries
        : [...current.registries, registryAuthority];

    await this.database.db
      .update(runs)
      .set({
        contextsCount: sql`${runs.contextsCount} + 1`,
        registries: updatedRegistries,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(runs.runId, runId), eq(runs.tenantId, tenantId)));
  }

  async markComplete(
    runId: string,
    status: string,
    result?: Record<string, unknown>,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<Run> {
    const now = new Date().toISOString();
    await this.database.db
      .update(runs)
      .set({
        status,
        completedAt: now,
        result: result ?? null,
        updatedAt: now,
      })
      .where(and(eq(runs.runId, runId), eq(runs.tenantId, tenantId)));
    return this.findByIdOrThrow(runId, tenantId);
  }

  async findById(runId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<Run | null> {
    const rows = await this.database.db
      .select()
      .from(runs)
      .where(and(eq(runs.runId, runId), eq(runs.tenantId, tenantId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findByIdOrThrow(runId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<Run> {
    const row = await this.findById(runId, tenantId);
    if (!row) throw new NotFoundException(`run ${runId} not found`);
    return row;
  }

  /**
   * Delete terminal (completed/failed/cancelled) runs whose completion
   * predates `cutoffIso`. Tenant-agnostic — the retention sweeper purges
   * across all tenants. Returns the number of rows deleted.
   */
  async deleteTerminalBefore(cutoffIso: string): Promise<number> {
    const deleted = await this.database.db
      .delete(runs)
      .where(
        and(
          inArray(runs.status, ['completed', 'failed', 'cancelled']),
          lt(runs.completedAt, cutoffIso),
        ),
      )
      .returning({ runId: runs.runId });
    return deleted.length;
  }

  /**
   * True if `runId` exists under a tenant other than `tenantId`. Used to
   * reject cross-tenant SSE subscriptions with 404 while still allowing a
   * caller to subscribe to its own run before the first event creates it.
   */
  async existsForOtherTenant(
    runId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<boolean> {
    const rows = await this.database.db
      .select({ runId: runs.runId })
      .from(runs)
      .where(and(eq(runs.runId, runId), ne(runs.tenantId, tenantId)))
      .limit(1);
    return rows.length > 0;
  }

  async list(opts: ListRunsOptions): Promise<{ data: Run[]; total: number }> {
    const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
    const conditions: SQL[] = [eq(runs.tenantId, tenantId)];
    if (opts.status) conditions.push(eq(runs.status, opts.status));
    if (opts.scenarioId) conditions.push(eq(runs.scenarioId, opts.scenarioId));

    const where = and(...conditions);

    const [data, totalResult] = await Promise.all([
      this.database.db
        .select()
        .from(runs)
        .where(where)
        .orderBy(desc(runs.startedAt))
        .limit(opts.limit)
        .offset(opts.offset),
      this.database.db.select({ value: count() }).from(runs).where(where),
    ]);

    return { data, total: Number(totalResult[0]?.value ?? 0) };
  }
}
