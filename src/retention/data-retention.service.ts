/**
 * Data-retention sweeper (FEAT-CP-02 / CP-4.3).
 *
 * Without this, `context_events`, terminal `runs`, and delivered
 * `webhook_deliveries` grow unbounded. On an interval (config), this
 * service deletes rows older than the configured TTL. An advisory lock
 * makes multi-instance deployments safe — only one instance purges per
 * tick. Disabled by default (`DATA_RETENTION_ENABLED=false`).
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../db/database.service';
import { ContextEventRepository } from '../storage/context-event.repository';
import { RunRepository } from '../storage/run.repository';
import { WebhookDeliveryRepository } from '../webhooks/webhook-delivery.repository';

const ADVISORY_LOCK_KEY = 'acdp-cp-retention';

@Injectable()
export class DataRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DataRetentionService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly database: DatabaseService,
    private readonly contextEventRepo: ContextEventRepository,
    private readonly runRepo: RunRepository,
    private readonly deliveryRepo: WebhookDeliveryRepository,
  ) {}

  onModuleInit(): void {
    if (!this.config.dataRetentionEnabled) return;
    const intervalMs = this.config.dataRetentionIntervalHours * 60 * 60 * 1000;
    this.timer = setInterval(() => {
      void this.purge().catch((err) =>
        this.logger.warn(
          `retention purge failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
    this.logger.log(
      `data retention enabled: ttl=${this.config.dataRetentionTtlDays}d interval=${this.config.dataRetentionIntervalHours}h`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Delete everything older than the TTL. Guarded by an advisory lock so
   * concurrent instances don't double-purge. Returns per-table counts.
   */
  async purge(): Promise<{ events: number; runs: number; deliveries: number }> {
    const acquired = await this.database.tryAdvisoryLock(ADVISORY_LOCK_KEY);
    if (!acquired) {
      this.logger.debug('retention purge skipped — another instance holds the lock');
      return { events: 0, runs: 0, deliveries: 0 };
    }
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.config.dataRetentionTtlDays);
      const cutoffIso = cutoff.toISOString();

      // Order: runs (and webhook deliveries) before events isn't required —
      // there are no FK cascades between them — so each delete is independent.
      const runs = await this.runRepo.deleteTerminalBefore(cutoffIso);
      const deliveries = await this.deliveryRepo.deleteDeliveredBefore(cutoffIso);
      const events = await this.contextEventRepo.deleteBefore(cutoffIso);

      if (events || runs || deliveries) {
        this.logger.log(
          `retention purge: events=${events} runs=${runs} deliveries=${deliveries} cutoff=${cutoffIso}`,
        );
      }
      return { events, runs, deliveries };
    } finally {
      await this.database.advisoryUnlock(ADVISORY_LOCK_KEY);
    }
  }
}
