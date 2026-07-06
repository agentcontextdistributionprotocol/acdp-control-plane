import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { LogCosignature, logCosignatures, NewLogCosignature } from '../db/schema';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';

/**
 * Storage for transparency-log witness cosignatures (RFC-ACDP-0015).
 *
 * `log_cosignatures` is the cosign layer sitting beside the detect-only
 * `log_witness_checkpoints`: only checkpoints that PASSED the §7 obligation
 * (signature + consistency) get a row here. Idempotent on the
 * (witness_id, log_id, tree_size, root_hash) unique key — re-observing the same
 * head keeps the first cosignature (cosignatures are ephemeral per-observation
 * evidence, §4; we retain one per tuple).
 */
@Injectable()
export class LogCosignatureRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Persist a minted cosignature. Idempotent on (witness_id, log_id, tree_size,
   * root_hash) — a re-observation of the same head keeps the first row and
   * returns null.
   */
  async record(input: NewLogCosignature): Promise<LogCosignature | null> {
    const rows = await this.database.db
      .insert(logCosignatures)
      .values(input)
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  }

  /**
   * This witness's cosignatures, most-recent first (RFC-ACDP-0015 §6.2),
   * OPTIONALLY filtered by `logId` and/or exact `treeSize`.
   */
  async list(filter: {
    witnessId: string;
    logId?: string;
    treeSize?: number;
    limit?: number;
  }): Promise<LogCosignature[]> {
    const conditions = [eq(logCosignatures.witnessId, filter.witnessId)];
    if (filter.logId !== undefined) {
      conditions.push(eq(logCosignatures.logId, filter.logId));
    }
    if (filter.treeSize !== undefined) {
      conditions.push(eq(logCosignatures.treeSize, filter.treeSize));
    }
    return this.database.db
      .select()
      .from(logCosignatures)
      .where(and(...conditions))
      .orderBy(desc(logCosignatures.witnessedAt), desc(logCosignatures.treeSize))
      .limit(filter.limit ?? 50);
  }

  /**
   * Distinct log_ids this witness has cosigned — the advisory `covered_logs`
   * for the §9 capabilities document.
   */
  async coveredLogs(witnessId: string): Promise<string[]> {
    const rows = await this.database.db
      .selectDistinct({ logId: logCosignatures.logId })
      .from(logCosignatures)
      .where(eq(logCosignatures.witnessId, witnessId))
      .orderBy(logCosignatures.logId);
    return rows.map((r) => r.logId);
  }

  /** Count of cosignatures held for a tenant — the dashboard tile. */
  async countForTenant(tenantId: string = DEFAULT_TENANT_ID): Promise<number> {
    const rows = await this.database.db
      .select({ n: sql<number>`count(*)::int` })
      .from(logCosignatures)
      .where(eq(logCosignatures.tenantId, tenantId));
    return rows[0]?.n ?? 0;
  }
}
