import { Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { REVOCATION_CONTEXT_TYPES } from '../contracts/revocation';
import { DatabaseService } from '../db/database.service';
import { ContextEvent, contextEvents, KeyRevocation, keyRevocations, NewKeyRevocation } from '../db/schema';

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
}
