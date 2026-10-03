/**
 * Token-issuance audit ledger.
 *
 * Every call to `TokenIssuer.issueToken` produces a ledger row — both
 * for successful mints (decision='mint') and for each validation
 * rejection point (decision='reject_*'). The row carries the actor
 * IP and a canonical decision detail so compliance audits can answer
 * questions like:
 *
 *   - how many tokens were issued for sub=X today?
 *   - which IPs failed signature validation most often last hour?
 *   - was JTI j-abc ever issued, and if so, when?
 *
 * Tamper evidence: rows are linked by a SHA-256 hash chain
 * (`prev_hash` → `entry_hash`). Each insert reads the most recent
 * row's `entry_hash` and folds it into this row's hash. A post-hoc
 * surgical edit to a row breaks the chain at audit time. This is a
 * foundation for a stronger Merkle commitment later; it isn't
 * tamper-proof on its own.
 *
 * Backends:
 *   - `postgres` — durable, queryable. The chain is computed under a
 *     transaction so concurrent inserts can't interleave.
 *   - `memory`   — in-process append-only array, lost on restart;
 *     used in tests and dev.
 *
 * Hot-path contract: `record()` returns synchronously and never
 * throws. Postgres writes are fire-and-forget so an audit failure
 * cannot break /auth/token. Operators monitor the warning logs
 * and the `verifyChain()` job for chain breaks.
 */
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../db/database.service';
import { issuanceLedger } from '../db/schema';
import { ShutdownFailures } from '../shutdown-failures';

export type IssuanceDecision =
  | 'mint'
  | 'reject_alg'
  | 'reject_nonce'
  | 'reject_agent_mismatch'
  | 'reject_expires_mismatch'
  | 'reject_unpinned'
  | 'reject_signature'
  | 'reject_internal';

export interface IssuanceLedgerEntry {
  jti?: string;
  sub?: string;
  iss?: string;
  iat?: number;
  exp?: number;
  signerIp?: string;
  decision: IssuanceDecision;
  decisionDetail?: string;
}

const ZERO_HASH = '0'.repeat(64);

@Injectable()
export class IssuanceLedgerService implements OnModuleDestroy {
  private readonly logger = new Logger(IssuanceLedgerService.name);

  // Memory-backed chain (always populated; in postgres mode it's a
  // local mirror used by tests / verifyChainMemory).
  private memoryChain: Array<{
    prevHash: string;
    entryHash: string;
    row: IssuanceLedgerEntry;
  }> = [];

  // Serialize the postgres path so concurrent records don't interleave
  // their hash-chain computation. Without this, two `recordPostgres`
  // tasks could both read the same `prev_hash` and emit conflicting
  // chains.
  private postgresQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: AppConfigService,
    private readonly db: DatabaseService,
    @Optional() private readonly shutdownFailures?: ShutdownFailures,
  ) {}

  /**
   * Record one decision synchronously (memory write happens inline).
   * On postgres, the DB write is queued and awaited internally;
   * failures are logged but never surface to the caller.
   */
  record(entry: IssuanceLedgerEntry): void {
    // Memory path always runs — fast, reliable, and gives a snapshot
    // for tests that don't want to wait for the DB queue to drain.
    this.recordMemory(entry);

    if (this.config.authPersistence === 'postgres') {
      this.postgresQueue = this.postgresQueue
        .then(() => this.recordPostgres(entry))
        .catch((e) => {
          this.logger.warn(
            `issuance ledger postgres write failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        });
    }
  }

  /**
   * Wait for any in-flight postgres writes to settle. Used by tests
   * and by graceful shutdown so the audit trail isn't truncated.
   */
  async drain(): Promise<void> {
    await this.postgresQueue;
  }

  async onModuleDestroy(): Promise<void> {
    // Tracked so a failed final drain (an unwritten audit-trail entry) fails
    // the exit code (#155). drain() itself never rejects today — each queued
    // write already catches and logs — so this guards future changes.
    if (this.shutdownFailures) {
      await this.shutdownFailures.track('issuance ledger drain', () => this.drain());
    } else {
      await this.drain();
    }
  }

  /**
   * Verify the entire chain.
   *
   * Returns the index of the first broken row, or -1 if intact.
   * O(n) — call from a compliance job, not the hot path.
   */
  async verifyChain(): Promise<{ ok: boolean; firstBroken: number; total: number }> {
    await this.drain();
    if (this.config.authPersistence === 'postgres') {
      return this.verifyChainPostgres();
    }
    return this.verifyChainMemory();
  }

  // ── postgres ─────────────────────────────────────────────────────────

  private async recordPostgres(entry: IssuanceLedgerEntry): Promise<void> {
    // Transaction so the chain head can't race with a concurrent
    // insert. Application-level queue (`postgresQueue`) already
    // serializes our own writes; the transaction guards against
    // outside writers (e.g. backfills).
    await this.db.db.transaction(async (tx) => {
      const last = await tx.execute(
        sql`SELECT entry_hash FROM issuance_ledger
            ORDER BY created_at DESC, id DESC LIMIT 1`,
      );
      const prevHash =
        (last.rows[0] as { entry_hash: string | null } | undefined)?.entry_hash ??
        ZERO_HASH;
      const entryHash = computeEntryHash(prevHash, entry);
      await tx.insert(issuanceLedger).values({
        jti: entry.jti,
        sub: entry.sub,
        iss: entry.iss,
        iat: entry.iat,
        exp: entry.exp,
        signerIp: entry.signerIp,
        decision: entry.decision,
        decisionDetail: entry.decisionDetail,
        prevHash,
        entryHash,
      });
    });
  }

  private async verifyChainPostgres(): Promise<{
    ok: boolean;
    firstBroken: number;
    total: number;
  }> {
    const rows = (
      await this.db.db.execute(
        sql`SELECT prev_hash, entry_hash, jti, sub, iss, iat, exp, signer_ip,
                    decision, decision_detail
              FROM issuance_ledger
              ORDER BY created_at ASC, id ASC`,
      )
    ).rows as Array<{
      prev_hash: string | null;
      entry_hash: string | null;
      jti: string | null;
      sub: string | null;
      iss: string | null;
      iat: string | number | null;
      exp: string | number | null;
      signer_ip: string | null;
      decision: string;
      decision_detail: string | null;
    }>;
    let prev = ZERO_HASH;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.prev_hash !== null && r.prev_hash !== prev) {
        return { ok: false, firstBroken: i, total: rows.length };
      }
      const recomputed = computeEntryHash(prev, {
        jti: r.jti ?? undefined,
        sub: r.sub ?? undefined,
        iss: r.iss ?? undefined,
        iat: r.iat === null ? undefined : Number(r.iat),
        exp: r.exp === null ? undefined : Number(r.exp),
        signerIp: r.signer_ip ?? undefined,
        decision: r.decision as IssuanceDecision,
        decisionDetail: r.decision_detail ?? undefined,
      });
      if (r.entry_hash !== null && r.entry_hash !== recomputed) {
        return { ok: false, firstBroken: i, total: rows.length };
      }
      prev = r.entry_hash ?? recomputed;
    }
    return { ok: true, firstBroken: -1, total: rows.length };
  }

  // ── memory ───────────────────────────────────────────────────────────

  private recordMemory(entry: IssuanceLedgerEntry): void {
    const prevHash =
      this.memoryChain[this.memoryChain.length - 1]?.entryHash ?? ZERO_HASH;
    const entryHash = computeEntryHash(prevHash, entry);
    this.memoryChain.push({ prevHash, entryHash, row: entry });
  }

  private verifyChainMemory(): { ok: boolean; firstBroken: number; total: number } {
    let prev = ZERO_HASH;
    for (let i = 0; i < this.memoryChain.length; i++) {
      const entry = this.memoryChain[i];
      if (entry.prevHash !== prev) {
        return { ok: false, firstBroken: i, total: this.memoryChain.length };
      }
      const recomputed = computeEntryHash(prev, entry.row);
      if (entry.entryHash !== recomputed) {
        return { ok: false, firstBroken: i, total: this.memoryChain.length };
      }
      prev = entry.entryHash;
    }
    return { ok: true, firstBroken: -1, total: this.memoryChain.length };
  }

  /** Snapshot of the memory chain — for tests. */
  __snapshot(): ReadonlyArray<{
    prevHash: string;
    entryHash: string;
    row: IssuanceLedgerEntry;
  }> {
    return this.memoryChain.slice();
  }

  /** Visible only for tampering tests; do not call from production code. */
  __tamper(index: number, mutate: (row: IssuanceLedgerEntry) => void): void {
    if (this.memoryChain[index]) mutate(this.memoryChain[index].row);
  }
}

/**
 * Canonical hash input for one ledger row.
 *
 * Fields are joined by the ASCII unit-separator (U+001F) — invalid
 * in JTI / DID / claim values — so concatenation ambiguities like
 * `("a","bc") == ("ab","c")` cannot collapse to the same hash.
 */
function computeEntryHash(prevHash: string, e: IssuanceLedgerEntry): string {
  const SEP = '';
  const canonical = [
    prevHash,
    e.decision,
    e.jti ?? '',
    e.sub ?? '',
    e.iss ?? '',
    e.iat === undefined ? '' : String(e.iat),
    e.exp === undefined ? '' : String(e.exp),
    e.signerIp ?? '',
    e.decisionDetail ?? '',
  ].join(SEP);
  return createHash('sha256').update(canonical).digest('hex');
}
