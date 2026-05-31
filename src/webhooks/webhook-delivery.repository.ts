import { Injectable } from '@nestjs/common';
import { and, eq, isNull, lt, lte, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../db/database.service';
import { WebhookDelivery, webhookDeliveries } from '../db/schema';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';

export interface CreateDeliveryInput {
  webhookId: string;
  event: string;
  runId: string;
  payload: Record<string, unknown>;
  tenantId?: string;
}

@Injectable()
export class WebhookDeliveryRepository {
  constructor(private readonly database: DatabaseService) {}

  async create(input: CreateDeliveryInput): Promise<WebhookDelivery> {
    const id = randomUUID();
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
    const now = new Date().toISOString();
    await this.database.db.insert(webhookDeliveries).values({
      id,
      tenantId,
      webhookId: input.webhookId,
      event: input.event,
      runId: input.runId,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      createdAt: now,
    });
    const rows = await this.database.db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.tenantId, tenantId)))
      .limit(1);
    return rows[0];
  }

  async markDelivered(
    id: string,
    responseStatus: number,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.database.db
      .update(webhookDeliveries)
      .set({
        status: 'delivered',
        responseStatus,
        lastAttemptAt: now,
        deliveredAt: now,
      })
      .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.tenantId, tenantId)));
  }

  async markFailed(
    id: string,
    attempt: number,
    errorMessage: string,
    responseStatus?: number,
    tenantId: string = DEFAULT_TENANT_ID,
    nextAttemptAt: string | null = null,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.database.db
      .update(webhookDeliveries)
      .set({
        status: attempt >= 3 ? 'failed' : 'pending',
        attempts: attempt,
        lastAttemptAt: now,
        errorMessage,
        responseStatus,
        nextAttemptAt,
      })
      .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.tenantId, tenantId)));
  }

  async listPending(tenantId: string = DEFAULT_TENANT_ID): Promise<WebhookDelivery[]> {
    const nowIso = new Date().toISOString();
    return this.database.db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.status, 'pending'),
          eq(webhookDeliveries.tenantId, tenantId),
          this.dueClause(nowIso),
        ),
      );
  }

  /** All pending, currently-due deliveries across every tenant — for the retry scheduler. */
  async listAllPending(): Promise<WebhookDelivery[]> {
    const nowIso = new Date().toISOString();
    return this.database.db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.status, 'pending'), this.dueClause(nowIso)));
  }

  /**
   * A delivery is "due" when it has no scheduled next attempt (legacy rows /
   * normal backoff) or its `next_attempt_at` has already passed — used to
   * defer rows behind an upstream 429 `Retry-After`.
   */
  private dueClause(nowIso: string) {
    return or(
      isNull(webhookDeliveries.nextAttemptAt),
      lte(webhookDeliveries.nextAttemptAt, nowIso),
    );
  }

  /**
   * Delete delivered deliveries older than `cutoffIso` (by created_at)
   * across all tenants — retention sweep. Returns rows deleted.
   */
  async deleteDeliveredBefore(cutoffIso: string): Promise<number> {
    const deleted = await this.database.db
      .delete(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.status, 'delivered'),
          lt(webhookDeliveries.createdAt, cutoffIso),
        ),
      )
      .returning({ id: webhookDeliveries.id });
    return deleted.length;
  }

  async listByWebhookId(
    webhookId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<WebhookDelivery[]> {
    return this.database.db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.webhookId, webhookId), eq(webhookDeliveries.tenantId, tenantId)));
  }
}
