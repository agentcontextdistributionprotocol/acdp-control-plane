import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import {
  LogWitnessCheckpoint,
  logWitnessCheckpoints,
  LogWitnessCursor,
  logWitnessCursors,
  NewLogWitnessCheckpoint,
} from '../db/schema';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';

/**
 * Storage for the transparency-log checkpoint witness (RFC-ACDP-0012).
 *
 * `log_witness_checkpoints` is append-only evidence: every distinct
 * (log_id, tree_size, root_hash) head this control plane has witnessed,
 * verbatim. `log_witness_cursors` is the per-(tenant, registry) sweep state;
 * the cursor fields (`logId`, `lastWitnessedSize`, `lastRootHash`) advance
 * ONLY through {@link advanceCursor} — alert and failure updates leave them
 * untouched so the retained pre-failure root stays available as the §9.2
 * `first_root` and as post-incident evidence.
 */
@Injectable()
export class LogWitnessRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Record a witnessed checkpoint. Idempotent on the (log_id, tree_size,
   * root_hash) unique key — re-witnessing the same head keeps the first row and
   * returns null (the evidence row, incl. its first-sight quorum, is
   * append-once). The RFC-ACDP-0015 §8 quorum fields are set from the INSERT
   * values on the first observation; a later refresh as the registry aggregates
   * more cosignatures goes through {@link updateQuorum}.
   */
  async recordCheckpoint(input: NewLogWitnessCheckpoint): Promise<LogWitnessCheckpoint | null> {
    const rows = await this.database.db
      .insert(logWitnessCheckpoints)
      .values(input)
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Refresh the RFC-ACDP-0015 §8 quorum trust signal on an already-recorded
   * head (called on a re-observation, where the registry may have aggregated
   * more cosignatures for the same tuple since we first saw it). A no-op when
   * the head is not yet recorded.
   */
  async updateQuorum(
    logId: string,
    treeSize: number,
    rootHash: string,
    witnessedCount: number,
    meetsQuorum: boolean,
  ): Promise<void> {
    await this.database.db
      .update(logWitnessCheckpoints)
      .set({ witnessedCount, meetsQuorum })
      .where(
        and(
          eq(logWitnessCheckpoints.logId, logId),
          eq(logWitnessCheckpoints.treeSize, treeSize),
          eq(logWitnessCheckpoints.rootHash, rootHash),
        ),
      );
  }

  /** Latest witnessed checkpoints for an authority, newest first. */
  async latestForAuthority(
    tenantId: string,
    authority: string,
    limit = 20,
  ): Promise<LogWitnessCheckpoint[]> {
    return this.database.db
      .select()
      .from(logWitnessCheckpoints)
      .where(
        and(
          eq(logWitnessCheckpoints.tenantId, tenantId),
          eq(logWitnessCheckpoints.registryAuthority, authority),
        ),
      )
      .orderBy(desc(logWitnessCheckpoints.witnessedAt), desc(logWitnessCheckpoints.treeSize))
      .limit(limit);
  }

  /**
   * A witnessed checkpoint at exactly (log_id, tree_size), if any — the
   * inclusion cross-check compares a proof's embedded checkpoint root
   * against what THIS witness saw at the same size (equivocation detector).
   */
  async findByLogIdAndSize(
    logId: string,
    treeSize: number,
  ): Promise<LogWitnessCheckpoint | null> {
    const rows = await this.database.db
      .select()
      .from(logWitnessCheckpoints)
      .where(
        and(
          eq(logWitnessCheckpoints.logId, logId),
          eq(logWitnessCheckpoints.treeSize, treeSize),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async getCursor(
    tenantId: string = DEFAULT_TENANT_ID,
    authority: string,
  ): Promise<LogWitnessCursor | null> {
    const rows = await this.database.db
      .select()
      .from(logWitnessCursors)
      .where(
        and(
          eq(logWitnessCursors.tenantId, tenantId),
          eq(logWitnessCursors.registryAuthority, authority),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Alerted cursors for a tenant — the operator alert feed. By default returns
   * only the UNACKNOWLEDGED ones (`alerted AND acknowledged_at IS NULL`): a
   * durable, pollable worklist of dishonesty detections that survives a failed
   * SSE/webhook fan-out. Pass `{ includeAcknowledged: true }` for the full set.
   */
  async listAlerted(
    tenantId: string = DEFAULT_TENANT_ID,
    opts: { includeAcknowledged?: boolean } = {},
  ): Promise<LogWitnessCursor[]> {
    const conditions = [
      eq(logWitnessCursors.tenantId, tenantId),
      eq(logWitnessCursors.alerted, true),
    ];
    if (!opts.includeAcknowledged) {
      conditions.push(isNull(logWitnessCursors.acknowledgedAt));
    }
    return this.database.db
      .select()
      .from(logWitnessCursors)
      .where(and(...conditions))
      .orderBy(desc(logWitnessCursors.lastAlertAt));
  }

  /**
   * Operator acknowledgement of an alerted cursor — records who saw it and when
   * WITHOUT touching the retained head or the `alerted` flag (which still
   * auto-clears only on resolution). Returns the updated cursor, or null if the
   * cursor is not currently alerted (nothing to acknowledge).
   */
  async acknowledgeAlert(
    tenantId: string,
    authority: string,
    acknowledgedBy: string,
  ): Promise<LogWitnessCursor | null> {
    const now = new Date().toISOString();
    const rows = await this.database.db
      .update(logWitnessCursors)
      .set({ acknowledgedAt: now, acknowledgedBy, updatedAt: now })
      .where(
        and(
          eq(logWitnessCursors.tenantId, tenantId),
          eq(logWitnessCursors.registryAuthority, authority),
          eq(logWitnessCursors.alerted, true),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Full-success cursor advance: sets the retained head, clears alert state
   * and the environmental-failure counter.
   */
  async advanceCursor(input: {
    tenantId: string;
    authority: string;
    logId: string;
    treeSize: number;
    rootHash: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.database.db
      .insert(logWitnessCursors)
      .values({
        registryAuthority: input.authority,
        tenantId: input.tenantId,
        logId: input.logId,
        lastWitnessedSize: input.treeSize,
        lastRootHash: input.rootHash,
        consecutiveFailures: 0,
        alerted: false,
        lastAlertReason: null,
        lastAlertDetail: null,
        acknowledgedAt: null,
        acknowledgedBy: null,
        lastSuccessAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [logWitnessCursors.tenantId, logWitnessCursors.registryAuthority],
        set: {
          logId: input.logId,
          lastWitnessedSize: input.treeSize,
          lastRootHash: input.rootHash,
          consecutiveFailures: 0,
          alerted: false,
          lastAlertReason: null,
          lastAlertDetail: null,
          // Resolution clears any acknowledgement — a fresh alert on the same
          // authority later is a new, unacknowledged detection.
          acknowledgedAt: null,
          acknowledgedBy: null,
          lastSuccessAt: now,
          updatedAt: now,
        },
      });
  }

  /**
   * Mark the cursor alerted. NEVER touches the retained head fields — the
   * pre-failure root is the evidence anchor. Returns the PREVIOUS alert
   * state so the caller can gate emission on the transition.
   */
  async markAlert(input: {
    tenantId: string;
    authority: string;
    reason: string;
    detail: Record<string, unknown>;
  }): Promise<{ wasAlerted: boolean; previousReason: string | null }> {
    const existing = await this.getCursor(input.tenantId, input.authority);
    const now = new Date().toISOString();
    // A NEW distinct alert reason is a fresh detection — reset any prior
    // acknowledgement so it resurfaces on the unacknowledged worklist. A
    // persisting alert (same reason) keeps its ack (no re-spam).
    const reasonChanged = (existing?.lastAlertReason ?? null) !== input.reason;
    const ackReset = reasonChanged
      ? { acknowledgedAt: null as string | null, acknowledgedBy: null as string | null }
      : {};
    await this.database.db
      .insert(logWitnessCursors)
      .values({
        registryAuthority: input.authority,
        tenantId: input.tenantId,
        alerted: true,
        lastAlertReason: input.reason,
        lastAlertDetail: input.detail,
        lastAlertAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [logWitnessCursors.tenantId, logWitnessCursors.registryAuthority],
        set: {
          alerted: true,
          lastAlertReason: input.reason,
          lastAlertDetail: input.detail,
          lastAlertAt: now,
          updatedAt: now,
          ...ackReset,
        },
      });
    return {
      wasAlerted: existing?.alerted ?? false,
      previousReason: existing?.lastAlertReason ?? null,
    };
  }

  /**
   * Record an environmental (transport/resolution) failure. Never touches
   * the retained head or the alert fields.
   */
  async markFailure(tenantId: string, authority: string): Promise<void> {
    const existing = await this.getCursor(tenantId, authority);
    const now = new Date().toISOString();
    await this.database.db
      .insert(logWitnessCursors)
      .values({
        registryAuthority: authority,
        tenantId,
        consecutiveFailures: 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [logWitnessCursors.tenantId, logWitnessCursors.registryAuthority],
        set: {
          consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
          updatedAt: now,
        },
      });
  }
}
