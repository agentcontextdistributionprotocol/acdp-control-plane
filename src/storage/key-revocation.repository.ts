import { Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { REVOCATION_CONTEXT_TYPES } from '../contracts/revocation';
import { DatabaseService } from '../db/database.service';
import {
  ContextEvent,
  contextEvents,
  KeyRevocation,
  keyRevocationLineageCursors,
  keyRevocations,
  NewKeyRevocation,
} from '../db/schema';

const REVOCATION_TYPES = [...REVOCATION_CONTEXT_TYPES];

/**
 * `key_revocations` is VERIFIED FACTS, PERMANENT, RETENTION-EXEMPT
 * (RFC-ACDP-0014 §4: "there is no un-revoking a key"). Deliberately no
 * `deleteBefore`/purge method here — see the migration 0022 header and
 * CLAUDE.md. `DataRetentionService` must never be extended to touch this
 * table.
 */
@Injectable()
export class KeyRevocationRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Record a verified revocation fact. Idempotent: the PK is
   * `(tenant_id, ctx_id)`, so a sweep racing another instance (or
   * re-observing the same webhook across two registries) silently keeps the
   * first-recorded fact.
   */
  async record(input: NewKeyRevocation): Promise<KeyRevocation | null> {
    const rows = await this.database.db
      .insert(keyRevocations)
      .values(input)
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  }

  /**
   * `context_events` rows newer than `sinceIso`, of either RFC-ACDP-0014
   * context-type spelling, that have no verified fact yet — oldest-first,
   * across all tenants (the sweep is a background process like receipt
   * audit; each fact row carries the event's own tenant).
   *
   * A body that fails verification (permanently or transiently) is never
   * written here, so it naturally keeps being re-selected as a candidate on
   * every sweep until it either verifies or ages out of `sinceIso` — an
   * accepted cost given revocations are rare by construction (see the
   * plan's Edge cases & failure modes / Scale note).
   */
  async findCandidates(sinceIso: string, limit: number): Promise<ContextEvent[]> {
    const rows = await this.database.db
      .select({ event: contextEvents })
      .from(contextEvents)
      .leftJoin(
        keyRevocations,
        and(eq(keyRevocations.ctxId, contextEvents.ctxId), eq(keyRevocations.tenantId, contextEvents.tenantId)),
      )
      .where(
        and(
          inArray(contextEvents.contextType, REVOCATION_TYPES),
          gt(contextEvents.createdAt, sinceIso),
          isNull(keyRevocations.ctxId),
        ),
      )
      .orderBy(contextEvents.createdAt)
      .limit(limit);
    return rows.map((r) => r.event);
  }

  /** All verified revocations naming `fingerprint`, across its full known lineage set. */
  async findByFingerprint(fingerprint: string, tenantId: string): Promise<KeyRevocation[]> {
    return this.database.db
      .select()
      .from(keyRevocations)
      .where(and(eq(keyRevocations.tenantId, tenantId), eq(keyRevocations.revokedKeyFingerprint, fingerprint)));
  }

  /**
   * Every distinct `(tenant_id, revoked_key_fingerprint)` pair with at least
   * one verified fact — RFC-ACDP-0014 §7 retroactive re-audit (Phase 15)
   * iterates this every `RevocationAuditService.sweep()` pass (not only
   * when a fact is freshly recorded) so a fingerprint whose amendment
   * fan-out exceeds one batch converges over subsequent sweeps. Covered by
   * `kr_fingerprint_idx` (`(tenant_id, revoked_key_fingerprint)`) as an
   * index-only scan. Revocations are rare by construction (see this file's
   * header), so this list is expected to stay small.
   */
  async distinctFingerprints(): Promise<Array<{ tenantId: string; fingerprint: string }>> {
    const rows = await this.database.db
      .selectDistinct({
        tenantId: keyRevocations.tenantId,
        fingerprint: keyRevocations.revokedKeyFingerprint,
      })
      .from(keyRevocations);
    return rows;
  }

  /**
   * How many verified facts we already hold for `lineageId` — used to decide
   * whether a lineage walk is REQUIRED regardless of cursor freshness (a
   * cached "walked" marker backed by zero facts is exactly the state that
   * must never suppress a walk — migration 0022's header, and the Phase 13
   * plan's "cursor semantics" test).
   */
  async countByLineage(tenantId: string, lineageId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(keyRevocations)
      .where(and(eq(keyRevocations.tenantId, tenantId), eq(keyRevocations.lineageId, lineageId)));
    return row?.count ?? 0;
  }

  /**
   * Whether a fresh (within `ttlMs`) "lineage L fully walked from registry
   * R" marker exists — `false` if missing or stale. A freshness marker
   * only — see `countByLineage` above for why its presence alone is never
   * sufficient to skip a walk.
   */
  async findFreshLineageCursor(
    tenantId: string,
    lineageId: string,
    registryAuthority: string,
    ttlMs: number,
  ): Promise<boolean> {
    const rows = await this.database.db
      .select({ walkedAt: keyRevocationLineageCursors.walkedAt })
      .from(keyRevocationLineageCursors)
      .where(
        and(
          eq(keyRevocationLineageCursors.tenantId, tenantId),
          eq(keyRevocationLineageCursors.lineageId, lineageId),
          eq(keyRevocationLineageCursors.registryAuthority, registryAuthority),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return false;
    return Date.now() - new Date(row.walkedAt).getTime() < ttlMs;
  }

  /** Record "lineage L fully walked from registry R at now" — only ever called after a COMPLETE, successful walk. */
  async recordLineageWalk(tenantId: string, lineageId: string, registryAuthority: string): Promise<void> {
    await this.database.db
      .insert(keyRevocationLineageCursors)
      .values({ tenantId, lineageId, registryAuthority })
      .onConflictDoUpdate({
        target: [
          keyRevocationLineageCursors.tenantId,
          keyRevocationLineageCursors.lineageId,
          keyRevocationLineageCursors.registryAuthority,
        ],
        set: { walkedAt: new Date().toISOString() },
      });
  }

  /**
   * Delete a lineage's freshness marker. Not called anywhere yet — this
   * phase never deletes a fact row — but migration 0022's header makes the
   * invariant explicit ("must be independently deletable... whenever fact
   * rows for that lineage are"), so the method exists alongside the facts
   * table it mirrors rather than being bolted on under time pressure later.
   */
  async deleteLineageCursor(tenantId: string, lineageId: string, registryAuthority: string): Promise<void> {
    await this.database.db
      .delete(keyRevocationLineageCursors)
      .where(
        and(
          eq(keyRevocationLineageCursors.tenantId, tenantId),
          eq(keyRevocationLineageCursors.lineageId, lineageId),
          eq(keyRevocationLineageCursors.registryAuthority, registryAuthority),
        ),
      );
  }
}
