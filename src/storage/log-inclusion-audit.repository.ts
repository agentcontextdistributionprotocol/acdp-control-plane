import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import {
  ContextEvent,
  contextEvents,
  LogInclusionAudit,
  logInclusionAudits,
  NewLogInclusionAudit,
} from '../db/schema';

/**
 * Storage for the receipt ↔ transparency-log inclusion cross-check
 * (RFC-ACDP-0012 §9.1). Mirrors ReceiptAuditRepository: one sealed verdict
 * row per audited event (PK = event id, on-conflict-do-nothing), kept in a
 * PARALLEL table so the receipt verdict and the log verdict stay independent
 * results (§9.3) — a later log verdict never mutates a receipt verdict row.
 */
@Injectable()
export class LogInclusionAuditRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Record a verdict. Idempotent — a racing sweep keeps the first verdict. */
  async record(input: NewLogInclusionAudit): Promise<LogInclusionAudit | null> {
    const rows = await this.database.db
      .insert(logInclusionAudits)
      .values(input)
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  }

  /**
   * context_published events newer than `sinceIso` that carried a
   * registry_receipt (receipt_present — leaves bind receipt hashes, §4, so
   * receipt-less publishes have no leaf to reconstruct) and have no inclusion
   * verdict yet, oldest-first, across all tenants (background sweep; each
   * verdict row carries the event's own tenant).
   */
  async findUnauditedReceiptPublishes(
    sinceIso: string,
    limit: number,
  ): Promise<ContextEvent[]> {
    const rows = await this.database.db
      .select({ event: contextEvents })
      .from(contextEvents)
      .leftJoin(logInclusionAudits, eq(logInclusionAudits.eventId, contextEvents.id))
      .where(
        and(
          eq(contextEvents.eventType, 'context_published'),
          eq(contextEvents.receiptPresent, true),
          gt(contextEvents.createdAt, sinceIso),
          isNull(logInclusionAudits.eventId),
        ),
      )
      .orderBy(contextEvents.createdAt)
      .limit(limit);
    return rows.map((r) => r.event);
  }
}
