import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import {
  ContextEvent,
  contextEvents,
  NewReceiptAudit,
  ReceiptAudit,
  receiptAudits,
} from '../db/schema';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';

/** Per-run rollup surfaced on GET /runs/:runId as the `trust` member. */
export interface RunTrustSummary {
  audited: number;
  verified: number;
  /**
   * Receipts that verified against a *retired* registry key (RFC-ACDP-0010
   * §9 historically authorized) — cryptographically valid, but signed by a
   * key since rotated out of `assertionMethod`.
   */
  verifiedHistorical: number;
  structural: number;
  noReceipt: number;
  errors: number;
  /** Audit rows that found at least one discrepancy — the run's flags. */
  flagged: Array<{
    eventId: string;
    ctxId: string | null;
    status: string;
    discrepancies: string[];
  }>;
  /**
   * RFC-ACDP-0014 §7 (Phase 14): counts of audited events whose signer key
   * is independently known-revoked, broken out by classification —
   * `historically_authorized_pre_compromise` (§7 step 2) vs. the two
   * fail-closed reasons (§7 steps 3-4). Deliberately NOT folded into
   * `flagged` — a §7 verdict is not registry dishonesty (see
   * receipt-audit.service.ts's file header).
   */
  keyRevocationPreCompromise: number;
  keyRevocationRevokedAtOrAfter: number;
  keyRevocationRevokedTimeUnverifiable: number;
  /** One entry per audit row whose key_revocation_status <> 'none'. */
  revoked: Array<{
    eventId: string;
    ctxId: string | null;
    status: string;
    boundary: string | null;
    trustClass: string | null;
    sources: Array<{ ctxId: string; publisher: string }>;
  }>;
}

@Injectable()
export class ReceiptAuditRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Record an audit verdict. Idempotent: the PK is the audited event id, so
   * a sweep racing another instance (or re-running after a crash between
   * SELECT and INSERT) silently keeps the first verdict.
   */
  async record(input: NewReceiptAudit): Promise<ReceiptAudit | null> {
    const rows = await this.database.db
      .insert(receiptAudits)
      .values(input)
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  }

  /**
   * context_published events newer than `sinceIso` (by arrival time) that
   * have no audit verdict yet, oldest-first, across all tenants — the sweep
   * is a background process like retention; each verdict row carries the
   * event's own tenant.
   *
   * Deliberately publish-only: the registry's ACDP 0.3.0 lifecycle events
   * (`context_retracted` / `context_republished`) carry NO registry_receipt
   * on the wire (acdp-registry-types `WebhookEvent`: only the
   * ContextPublished variant has the field), so there is nothing to audit on
   * them. TODO(ACDP 0.3.0 Tier 3): widen this filter if registries start
   * minting receipts for lifecycle transitions.
   */
  async findUnauditedPublishes(sinceIso: string, limit: number): Promise<ContextEvent[]> {
    const rows = await this.database.db
      .select({ event: contextEvents })
      .from(contextEvents)
      .leftJoin(receiptAudits, eq(receiptAudits.eventId, contextEvents.id))
      .where(
        and(
          eq(contextEvents.eventType, 'context_published'),
          gt(contextEvents.createdAt, sinceIso),
          isNull(receiptAudits.eventId),
        ),
      )
      .orderBy(contextEvents.createdAt)
      .limit(limit);
    return rows.map((r) => r.event);
  }

  async summarizeByRun(
    runId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<RunTrustSummary | null> {
    const rows = await this.database.db
      .select()
      .from(receiptAudits)
      .where(and(eq(receiptAudits.runId, runId), eq(receiptAudits.tenantId, tenantId)))
      .orderBy(receiptAudits.checkedAt)
      .limit(500);
    if (rows.length === 0) return null;

    const byStatus = (s: string) => rows.filter((r) => r.status === s).length;
    const byRevocationStatus = (s: string) =>
      rows.filter((r) => r.keyRevocationStatus === s).length;
    return {
      audited: rows.length,
      verified: byStatus('verified'),
      verifiedHistorical: byStatus('verified_historical'),
      structural: byStatus('structural'),
      noReceipt: byStatus('no_receipt'),
      errors: byStatus('error'),
      // Only true trust flags. `error` verdicts carry `unverified:` notes in
      // their discrepancies column — environmental, not dishonesty signals.
      flagged: rows
        .filter((r) => r.status === 'discrepancy')
        .map((r) => ({
          eventId: r.eventId,
          ctxId: r.ctxId,
          status: r.status,
          discrepancies: r.discrepancies,
        })),
      keyRevocationPreCompromise: byRevocationStatus('pre_compromise'),
      keyRevocationRevokedAtOrAfter: byRevocationStatus('revoked_at_or_after'),
      keyRevocationRevokedTimeUnverifiable: byRevocationStatus('revoked_time_unverifiable'),
      revoked: rows
        .filter((r) => r.keyRevocationStatus !== 'none')
        .map((r) => ({
          eventId: r.eventId,
          ctxId: r.ctxId,
          status: r.keyRevocationStatus,
          boundary: r.compromiseBoundary,
          trustClass: r.keyRevocationTrustClass,
          sources: r.keyRevocationSources,
        })),
    };
  }

  /** Delete audit rows older than `cutoffIso` — retention sweep companion. */
  async deleteBefore(cutoffIso: string): Promise<number> {
    const deleted = await this.database.db
      .delete(receiptAudits)
      .where(sql`${receiptAudits.checkedAt} < ${cutoffIso}`)
      .returning({ eventId: receiptAudits.eventId });
    return deleted.length;
  }

  /**
   * RFC-ACDP-0014 §7 retroactive re-audit (Phase 15). `receipt_audits` rows
   * for `tenantId` whose event's `key_fingerprint` is `fingerprint` and that
   * are still eligible for amendment, bounded by `limit`.
   *
   * A row is eligible if EITHER: it has never been amended for any
   * revocation fact on this fingerprint (`key_revocation_status = 'none'`),
   * OR its currently-stored `compromise_boundary` is later (less severe)
   * than `globalMinBoundaryIso` — the caller passes the min `compromised_since`
   * across the FULL current fact set for this fingerprint, so a SECOND,
   * earlier-dated revocation discovered after a first amendment still pulls
   * an already-amended row back into the candidate pool. This predicate is
   * deliberately over-inclusive (it ignores per-row registry scope, unlike
   * `amendKeyRevocation`'s WHERE) — the real, scope-filtered tightening
   * decision is made per row by the caller and enforced again, precisely,
   * in `amendKeyRevocation`'s own WHERE clause; a row pulled in here that
   * turns out not to actually tighten just no-ops there.
   * `globalMinBoundaryIso: null` (no revocation on this fingerprint has ever
   * been observed with a resolvable boundary) restricts to the `'none'`
   * branch only, since there is nothing to compare against.
   *
   * Deliberately unbounded by recency (no `checked_at` / `event_arrived_at`
   * filter): this is the whole point of the phase — `findUnauditedPublishes`
   * excludes anything already audited and only looks back
   * `RECEIPT_AUDIT_LOOKBACK_HOURS`, so a row sealed long ago, or long outside
   * that window, is exactly the kind of row a conservatively-early
   * `compromised_since` (RFC-ACDP-0014 §4) needs to reach.
   *
   * No `ORDER BY`: an explicit sort here forced a Merge Join across the full
   * tenant/fingerprint row set even once every row is already amended
   * (verified via `EXPLAIN (ANALYZE, BUFFERS)` against 200k seeded rows —
   * ~190ms and ~505k buffer hits to return zero rows, every sweep, forever,
   * for a high-volume revoked fingerprint). Unordered, the planner can drive
   * off `ce_key_fingerprint_idx` and probe `receipt_audits` by its `event_id`
   * primary key instead. Self-advancing without a cursor either way: an
   * amended row's `key_revocation_status` (and, once tightened,
   * `compromise_boundary`) leaves the eligible set, so the next call — the
   * next sweep pass, per `ReceiptAuditService.reauditForFingerprint` —
   * naturally excludes it.
   *
   * `context_events.key_fingerprint` is the REGISTRY-CLAIMED fingerprint at
   * publish time, not the independently-resolved signer the §7 verdict
   * itself is keyed on — correct here because this is CANDIDATE SELECTION,
   * not the verdict: a claim/resolved mismatch is already flagged
   * separately as `key_fingerprint_mismatch`, and using the claimed value
   * can only pull in an extra candidate (harmless — its own re-audited
   * classification still uses the real per-row inputs), never misclassify
   * one. It CAN, however, drop a real one: an event whose claimed
   * `key_fingerprint` was never populated (most historical rows predate
   * ACDP 0.2.0, or a registry that never advertised the field) is
   * permanently unreachable by this fan-out no matter how the fact set
   * changes — accepted and documented as a limitation (ASSUMPTIONS.md /
   * docs/ARCHITECTURE.md), not fixed here, since closing it would need a
   * backfilled, independently-resolved-signer column, a real schema change
   * out of scope for this phase.
   */
  async findRevocationAmendmentCandidates(
    tenantId: string,
    fingerprint: string,
    globalMinBoundaryIso: string | null,
    limit: number,
  ): Promise<RevocationAmendmentCandidate[]> {
    const eligible =
      globalMinBoundaryIso === null
        ? eq(receiptAudits.keyRevocationStatus, 'none')
        : or(
            eq(receiptAudits.keyRevocationStatus, 'none'),
            gt(receiptAudits.compromiseBoundary, globalMinBoundaryIso),
          );
    const rows = await this.database.db
      .select({
        eventId: receiptAudits.eventId,
        status: receiptAudits.status,
        receiptCreatedAt: receiptAudits.receiptCreatedAt,
        registryAuthority: contextEvents.registryAuthority,
      })
      .from(receiptAudits)
      .innerJoin(contextEvents, eq(contextEvents.id, receiptAudits.eventId))
      .where(
        and(
          eq(receiptAudits.tenantId, tenantId),
          eq(contextEvents.tenantId, tenantId),
          eq(contextEvents.keyFingerprint, fingerprint),
          eligible,
        ),
      )
      .limit(limit);
    return rows;
  }

  /**
   * Amend ONLY the 4 §7 revocation columns on one already-sealed
   * `receipt_audits` row — never `status`, `discrepancies`, `skew_ms`,
   * `receipt_created_at`, `event_arrived_at`, or `checked_at`: the SET list
   * literally cannot reach them, so there is nothing to prove byte-identical
   * beyond "this statement doesn't mention them."
   *
   * Monotone by the WHERE clause, not just caller discipline: a row matches
   * only on its FIRST amendment (`key_revocation_status = 'none'`) or when
   * `amendment.boundary` is strictly EARLIER (more severe) than the
   * currently-stored `compromise_boundary` — so a second, later call with an
   * equal or later boundary is a no-op, and the column can only ever move
   * earlier, never later. `key_revocation_status <> 'none'` implies
   * `compromise_boundary IS NOT NULL` (schema.ts), so the `gt` comparison is
   * always well-defined once that branch is reached.
   *
   * Idempotent: a second call carrying the same (or a less severe) boundary
   * for an already-amended row matches zero rows and returns `false`.
   */
  async amendKeyRevocation(
    tenantId: string,
    eventId: string,
    amendment: RevocationAmendment,
  ): Promise<boolean> {
    const rows = await this.database.db
      .update(receiptAudits)
      .set({
        keyRevocationStatus: amendment.status,
        keyRevocationTrustClass: amendment.trustClass,
        compromiseBoundary: amendment.boundary,
        keyRevocationSources: amendment.sources,
      })
      .where(
        and(
          eq(receiptAudits.eventId, eventId),
          eq(receiptAudits.tenantId, tenantId),
          or(
            eq(receiptAudits.keyRevocationStatus, 'none'),
            gt(receiptAudits.compromiseBoundary, amendment.boundary),
          ),
        ),
      )
      .returning({ eventId: receiptAudits.eventId });
    return rows.length > 0;
  }
}

/** One `findRevocationAmendmentCandidates` row — see that method's doc. */
export interface RevocationAmendmentCandidate {
  eventId: string;
  status: string;
  receiptCreatedAt: string | null;
  registryAuthority: string;
}

/** The 4 columns `amendKeyRevocation` writes — never `'none'` (see its doc). */
export interface RevocationAmendment {
  status: 'pre_compromise' | 'revoked_at_or_after' | 'revoked_time_unverifiable';
  trustClass: 'producer_signed' | 'registry_attested';
  boundary: string;
  sources: Array<{ ctxId: string; publisher: string }>;
}
