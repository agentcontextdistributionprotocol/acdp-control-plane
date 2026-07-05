import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
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
   * root_hash) unique key — re-witnessing the same head keeps the first row.
   */
  async recordCheckpoint(input: NewLogWitnessCheckpoint): Promise<LogWitnessCheckpoint | null> {
    const rows = await this.database.db
      .insert(logWitnessCheckpoints)
      .values(input)
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
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

  /** All alerted cursors for a tenant — the dashboard alert tile. */
  async listAlerted(tenantId: string = DEFAULT_TENANT_ID): Promise<LogWitnessCursor[]> {
    return this.database.db
      .select()
      .from(logWitnessCursors)
      .where(and(eq(logWitnessCursors.tenantId, tenantId), eq(logWitnessCursors.alerted, true)));
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
