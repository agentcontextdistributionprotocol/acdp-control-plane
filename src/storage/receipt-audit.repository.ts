import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
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
}
