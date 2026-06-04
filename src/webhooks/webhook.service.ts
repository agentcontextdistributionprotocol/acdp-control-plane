import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { SsrfPolicy } from '../auth/did-web/ssrf-guard';
import { parseRetryAfterMs } from '../common/retry-after';
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
  /**
   * SSRF gate for outbound delivery. Subscriber URLs are attacker-supplied
   * (any authenticated tenant can register one), so every delivery is gated
   * by the same policy as the federation proxy. Default-secure; the policy
   * is injectable so tests can stub DNS resolution.
   */
  private readonly ssrf: SsrfPolicy;

  constructor(
    private readonly webhookRepository: WebhookRepository,
    private readonly deliveryRepository: WebhookDeliveryRepository,
    private readonly instrumentation: InstrumentationService,
    private readonly config: AppConfigService,
    @Optional() ssrf?: SsrfPolicy,
  ) {
    this.ssrf =
      ssrf ??
      new SsrfPolicy({
        allowHttp: config.webhookSsrfAllowHttp,
        allowLoopback: config.webhookSsrfAllowLoopback,
      });
  }

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
    this.assertSafeUrl(input.url);
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
    if (fields.url !== undefined) this.assertSafeUrl(fields.url);
    return this.webhookRepository.update(id, fields, tenantId);
  }

  /**
   * Synchronous scheme + IP-literal gate run at subscription time so an
   * obviously-unsafe URL (http://, IP literal) is rejected up front. The
   * full DNS-resolution gate runs again at delivery time in
   * {@link guardDeliveryUrl} — a hostname can rebind between registration
   * and delivery, so registration validation alone is not sufficient.
   */
  private assertSafeUrl(url: string): void {
    try {
      this.ssrf.checkUrl(url);
    } catch (e) {
      throw new BadRequestException(
        `webhook URL rejected by SSRF policy: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
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

  /**
   * Run the full SSRF gate (scheme + IP-literal, then DNS-resolve every
   * address) against a delivery URL. Returns an error message string on a
   * policy violation, or null when the URL is safe to fetch.
   */
  private async guardDeliveryUrl(url: string): Promise<string | null> {
    try {
      this.ssrf.checkUrl(url);
      const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
      await this.ssrf.checkResolvedHost(host);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
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

    // SSRF gate: subscriber URLs are attacker-supplied. Re-resolve and
    // range-check at delivery time (closes the DNS-rebind window left open
    // by registration-time validation). A policy violation is a PERMANENT
    // failure — never retry it into the internal network.
    const ssrfError = await this.guardDeliveryUrl(url);
    if (ssrfError) {
      await this.recordFailure(
        deliveryId,
        url,
        startAttempt + 1,
        maxAttempts,
        `SSRF policy: ${ssrfError}`,
        undefined,
        tenantId,
      );
      return;
    }

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
          // Never auto-follow redirects: a subscriber could 302 us at an
          // internal target the SSRF gate above already cleared the original
          // host for. A 3xx is treated as a delivery failure below.
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });

        // Subscriber back-pressure: honor a 429 `Retry-After` by scheduling
        // the next attempt no sooner than the hint, then defer to the retry
        // sweep instead of blocking inline. Falls through to normal backoff
        // when the header is absent or unparseable.
        if (response.status === 429 && attempt < maxAttempts) {
          const retryAfter = response.headers.get('retry-after');
          const delayMs = parseRetryAfterMs(retryAfter);
          if (delayMs !== null) {
            const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
            this.logger.warn(
              `webhook delivery to ${url} got 429 (attempt ${attempt}/${maxAttempts}); ` +
                `deferring next attempt until ${nextAttemptAt} (Retry-After: ${retryAfter})`,
            );
            await this.deliveryRepository.markFailed(
              deliveryId,
              attempt,
              `webhook returned 429 (Retry-After: ${retryAfter})`,
              response.status,
              tenantId,
              nextAttemptAt,
            );
            return;
          }
        }

        if (response.ok) {
          await this.deliveryRepository.markDelivered(deliveryId, response.status, tenantId);
          this.instrumentation.webhookDeliveriesTotal.inc({ status: 'delivered' });
          return;
        }

        // Non-2xx (including a 429 with no usable Retry-After) → ordinary
        // failure path: record it and fall through to the inline backoff.
        await this.recordFailure(
          deliveryId,
          url,
          attempt,
          maxAttempts,
          `webhook returned ${response.status}`,
          response.status,
          tenantId,
        );
      } catch (error) {
        // Transport/timeout error (no HTTP response at all).
        const errorMessage = error instanceof Error ? error.message : String(error);
        await this.recordFailure(
          deliveryId,
          url,
          attempt,
          maxAttempts,
          errorMessage,
          undefined,
          tenantId,
        );
      }

      if (attempt < maxAttempts) {
        const backoffMs = 1000 * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  /** Record a failed delivery attempt and emit the terminal-failure metric on exhaustion. */
  private async recordFailure(
    deliveryId: string,
    url: string,
    attempt: number,
    maxAttempts: number,
    errorMessage: string,
    responseStatus: number | undefined,
    tenantId: string,
  ): Promise<void> {
    this.logger.warn(
      `webhook delivery to ${url} failed (attempt ${attempt}/${maxAttempts}): ${errorMessage}`,
    );
    await this.deliveryRepository.markFailed(
      deliveryId,
      attempt,
      errorMessage,
      responseStatus,
      tenantId,
    );
    if (attempt >= maxAttempts) {
      this.instrumentation.webhookDeliveriesTotal.inc({ status: 'failed' });
    }
  }
}
