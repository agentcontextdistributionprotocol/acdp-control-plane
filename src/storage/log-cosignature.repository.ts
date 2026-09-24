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
 * (tenant_id, witness_id, log_id, tree_size, root_hash) unique key (migration
 * 0019) — re-observing the same head for the same tenant keeps the first
 * cosignature (cosignatures are ephemeral per-observation evidence, §4; we
 * retain one per tuple).
 *
 * `list` and `coveredLogs` below deliberately take NO `tenantId` — this is
 * not an oversight. `GET /log/witness` and `/.well-known/acdp-witness.json`
 * (`src/witness/witness.controller.ts`) are RFC-ACDP-0015 §6.2 public feeds
 * for a SINGLE witness identity, this control plane's own `WITNESS_ID` — not
 * a tenant-scoped view. They are already scoped by the thing that matters
 * (`witnessId`), same as recording a cosignature is scoped by tenant via the
 * unique key above. Multiple tenants sharing one CP share one witness
 * identity and its public feed by design.
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
   *
   * Since re-minting on every observation (B1) makes this table carry one row
   * per SWEEP rather than one row per HEAD, the default view (`all` unset or
   * false) collapses to the LATEST cosignature per distinct
   * `(log_id, tree_size, root_hash)` tuple — the freshest attestation per
   * head, which is what a §8 consumer actually needs; the liveness
   * re-observations behind it would otherwise crowd out older heads within a
   * fixed-size page (B11). Pass `all: true` for the full per-tuple series
   * (the anti-backdating use — §8.1: an OLDER surviving cosignature for a
   * head is STRONGER evidence that the head existed early).
   *
   * Implementation note: PostgreSQL requires `DISTINCT ON`'s expressions to
   * be the LEADING `ORDER BY` expressions, so the inner query orders by the
   * tuple first and `witnessed_at DESC` last (one row per tuple: the
   * newest); the outer query re-sorts by `witnessed_at DESC` for the
   * "most-recent first" contract, and `limit` is applied OUT HERE so it
   * bounds the DEDUPLICATED set — applying it inside the `DISTINCT ON` would
   * silently truncate before dedup and reintroduce B11 in a subtler form.
   */
  async list(filter: {
    witnessId: string;
    logId?: string;
    treeSize?: number;
    limit?: number;
    all?: boolean;
  }): Promise<LogCosignature[]> {
    const conditions = [eq(logCosignatures.witnessId, filter.witnessId)];
    if (filter.logId !== undefined) {
      conditions.push(eq(logCosignatures.logId, filter.logId));
    }
    if (filter.treeSize !== undefined) {
      conditions.push(eq(logCosignatures.treeSize, filter.treeSize));
    }

    if (filter.all) {
      return this.database.db
        .select()
        .from(logCosignatures)
        .where(and(...conditions))
        .orderBy(desc(logCosignatures.witnessedAt), desc(logCosignatures.treeSize))
        .limit(filter.limit ?? 200);
    }

    const deduped = this.database.db
      .selectDistinctOn([logCosignatures.logId, logCosignatures.treeSize, logCosignatures.rootHash])
      .from(logCosignatures)
      .where(and(...conditions))
      .orderBy(
        logCosignatures.logId,
        logCosignatures.treeSize,
        logCosignatures.rootHash,
        desc(logCosignatures.witnessedAt),
      )
      .as('deduped');

    return this.database.db
      .select()
      .from(deduped)
      .orderBy(desc(deduped.witnessedAt), desc(deduped.treeSize))
      .limit(filter.limit ?? 50);
  }

  /**
   * Purge cosignatures beyond `keepPerHead`, per distinct
   * `(tenant_id, witness_id, log_id, tree_size, root_hash)` tuple, restricted
   * to rows older than `cutoffIso` — the retention sweep's mirror of
   * {@link record}'s unbounded-growth concern (B1 makes this a genuinely
   * append-EVERY-observation table). Keeps the newest `keepPerHead - 1` rows
   * AND the single OLDEST row per tuple unconditionally (§8.1: the oldest
   * surviving cosignature for a head is the strongest anti-backdating
   * evidence — never purge from the ends, only the middle). A row is deleted
   * only when it is BOTH past the TTL cutoff AND outside that kept set, so a
   * tuple with fewer than `keepPerHead` rows, or whose extra rows haven't
   * aged past the TTL yet, is left untouched.
   */
  async purgeOldPerTuple(cutoffIso: string, keepPerHead: number): Promise<number> {
    const result = await this.database.db.execute(sql`
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY tenant_id, witness_id, log_id, tree_size, root_hash
            ORDER BY witnessed_at DESC
          ) AS rn_desc,
          ROW_NUMBER() OVER (
            PARTITION BY tenant_id, witness_id, log_id, tree_size, root_hash
            ORDER BY witnessed_at ASC
          ) AS rn_asc
        FROM log_cosignatures
      )
      DELETE FROM log_cosignatures
      WHERE id IN (
        SELECT ranked.id FROM ranked
        JOIN log_cosignatures lc ON lc.id = ranked.id
        WHERE ranked.rn_desc > ${Math.max(keepPerHead - 1, 0)}
          AND ranked.rn_asc > 1
          AND lc.witnessed_at < ${cutoffIso}
      )
      RETURNING id
    `);
    return result.rows.length;
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
