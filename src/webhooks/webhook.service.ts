import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { WebhookDeliveryRepository } from './webhook-delivery.repository';
import { WebhookRepository } from './webhook.repository';

export interface WebhookPayload {
  event: string;
  runId: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

@Injectable()
export class WebhookService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookService.name);
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly webhookRepository: WebhookRepository,
    private readonly deliveryRepository: WebhookDeliveryRepository,
    private readonly instrumentation: InstrumentationService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.config.webhookRetryIntervalMs;
    if (intervalMs <= 0) return; // disabled
    this.retryTimer = setInterval(() => {
      void this.retryAllPending().catch((err) =>
        this.logger.warn(
          `webhook retry sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, intervalMs);
    // Don't keep the process (or test runner) alive on this timer.
    if (typeof this.retryTimer === 'object' && 'unref' in this.retryTimer) {
      this.retryTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.retryTimer !== null) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  async register(
    input: { url: string; events: string[]; secret: string },
    tenantId: string = DEFAULT_TENANT_ID,
  ) {
    return this.webhookRepository.create({ ...input, tenantId });
  }

  async list(tenantId: string = DEFAULT_TENANT_ID) {
    return this.webhookRepository.list(tenantId);
  }

  async update(
    id: string,
    fields: { url?: string; events?: string[]; secret?: string; active?: boolean },
    tenantId: string = DEFAULT_TENANT_ID,
  ) {
    return this.webhookRepository.update(id, fields, tenantId);
  }

  async remove(id: string, tenantId: string = DEFAULT_TENANT_ID) {
    return this.webhookRepository.delete(id, tenantId);
  }

  /**
   * Fire an event to all matching webhooks for `tenantId`. Callers
   * fire-and-forget (`void webhookService.fireEvent(...)`). Errors are
   * swallowed and logged so they don't surface as unhandled rejections.
   */
  async fireEvent(
    payload: WebhookPayload,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<void> {
    try {
      const active = await this.webhookRepository.listActive(tenantId);
      const matching = active.filter(
        (wh) => wh.events.length === 0 || wh.events.includes(payload.event),
      );

      for (const webhook of matching) {
        const delivery = await this.deliveryRepository.create({
          webhookId: webhook.id,
          event: payload.event,
          runId: payload.runId,
          payload: payload as unknown as Record<string, unknown>,
          tenantId,
        });
        void this.deliverWithTracking(
          delivery.id,
          webhook.url,
          webhook.secret,
          payload,
          tenantId,
        );
      }
    } catch (err) {
      this.logger.warn(
        `fireEvent(${payload.event}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Retry pending deliveries across ALL tenants — the scheduler entry point.
   * Each delivery row carries its own tenantId, so per-tenant scoping is
   * preserved when looking up the subscription and recording the result.
   */
  async retryAllPending(): Promise<number> {
    const pending = await this.deliveryRepository.listAllPending();
    let retried = 0;
    for (const delivery of pending) {
      const webhook = await this.webhookRepository.findById(
        delivery.webhookId,
        delivery.tenantId,
      );
      if (!webhook) continue;
      void this.deliverWithTracking(
        delivery.id,
        webhook.url,
        webhook.secret,
        delivery.payload as unknown as WebhookPayload,
        delivery.tenantId,
        delivery.attempts,
      );
      retried++;
    }
    return retried;
  }

  async retryPending(tenantId: string = DEFAULT_TENANT_ID): Promise<number> {
    const pending = await this.deliveryRepository.listPending(tenantId);
    let retried = 0;
    for (const delivery of pending) {
      const webhook = await this.webhookRepository.findById(
        delivery.webhookId,
        tenantId,
      );
      if (!webhook) continue;
      void this.deliverWithTracking(
        delivery.id,
        webhook.url,
        webhook.secret,
        delivery.payload as unknown as WebhookPayload,
        tenantId,
        delivery.attempts,
      );
      retried++;
    }
    return retried;
  }

  private async deliverWithTracking(
    deliveryId: string,
    url: string,
    secret: string,
    payload: WebhookPayload,
    tenantId: string,
    startAttempt = 0,
  ): Promise<void> {
    const maxAttempts = 3;
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', secret).update(body).digest('hex');

    for (let attempt = startAttempt + 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-ACDP-Signature': `sha256=${signature}`,
            'X-ACDP-Event': payload.event,
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          throw new Error(`webhook returned ${response.status}`);
        }

        await this.deliveryRepository.markDelivered(deliveryId, response.status, tenantId);
        this.instrumentation.webhookDeliveriesTotal.inc({ status: 'delivered' });
        return;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `webhook delivery to ${url} failed (attempt ${attempt}/${maxAttempts}): ${errorMessage}`,
        );
        await this.deliveryRepository.markFailed(
          deliveryId,
          attempt,
          errorMessage,
          undefined,
          tenantId,
        );
        if (attempt >= maxAttempts) {
          this.instrumentation.webhookDeliveriesTotal.inc({ status: 'failed' });
        }
        if (attempt < maxAttempts) {
          const backoffMs = 1000 * 2 ** (attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }
  }
}
