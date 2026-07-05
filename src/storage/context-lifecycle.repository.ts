import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { contextLifecycle } from '../db/schema';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';

export interface LifecycleTransitionInput {
  ctxId: string;
  tenantId?: string;
  lineageId?: string;
  /** true = retract, false = republish. */
  retracted: boolean;
  /** The lifecycle event's own timestamp (ISO) — the idempotence guard. */
  at: string;
  /** DID of the party performing the transition. */
  actor?: string;
  reason?: string;
}

/**
 * Current retract/republish state per context (ACDP 0.3.0, RFC-ACDP-0013).
 *
 * A projection, not a log: the full lifecycle history stays in
 * `context_events` (and in the registry's `registry_state.lifecycle_events`);
 * this table answers only "is ctx X currently retracted, and since when".
 */
@Injectable()
export class ContextLifecycleRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Apply a retract/republish transition. Idempotent and out-of-order safe:
   * the row only moves when the incoming event is at least as new as the
   * last applied one (`last_event_at <= excluded.last_event_at`) —
   * re-applying the same event is a no-op state-wise, and a stale
   * retransmission arriving after a newer transition is ignored.
   */
  async applyTransition(input: LifecycleTransitionInput): Promise<void> {
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
    await this.database.db
      .insert(contextLifecycle)
      .values({
        ctxId: input.ctxId,
        tenantId,
        lineageId: input.lineageId ?? null,
        retracted: input.retracted,
        retractedAt: input.retracted ? input.at : null,
        republishedAt: input.retracted ? null : input.at,
        actor: input.actor ?? null,
        reason: input.reason ?? null,
        lastEventAt: input.at,
      })
      .onConflictDoUpdate({
        target: [contextLifecycle.tenantId, contextLifecycle.ctxId],
        set: {
          retracted: input.retracted,
          // Only the timestamp of the transition being applied moves; the
          // other one keeps its previous value (last-of-each-kind).
          ...(input.retracted
            ? { retractedAt: input.at }
            : { republishedAt: input.at }),
          lineageId: sql`coalesce(excluded.lineage_id, ${contextLifecycle.lineageId})`,
          actor: input.actor ?? null,
          reason: input.reason ?? null,
          lastEventAt: input.at,
          updatedAt: sql`now()`,
        },
        setWhere: sql`${contextLifecycle.lastEventAt} <= excluded.last_event_at`,
      });
  }

  /**
   * Of the given ctx ids, the subset that is CURRENTLY retracted.
   * Contexts with no lifecycle row are simply live (never retracted).
   */
  async retractedSetOf(
    ctxIds: string[],
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<Set<string>> {
    if (ctxIds.length === 0) return new Set();
    const rows = await this.database.db
      .select({ ctxId: contextLifecycle.ctxId })
      .from(contextLifecycle)
      .where(
        and(
          eq(contextLifecycle.tenantId, tenantId),
          eq(contextLifecycle.retracted, true),
          inArray(contextLifecycle.ctxId, ctxIds),
        ),
      );
    return new Set(rows.map((r) => r.ctxId));
  }
}
