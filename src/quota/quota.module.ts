/**
 * Quota module — registers parsed `TENANT_QUOTAS` config and a quota
 * store (Redis when `REDIS_URL` is set, in-memory otherwise) so the
 * `QuotaGuard` (mounted as APP_GUARD by AppModule) can enforce
 * per-tenant rate limits.
 *
 * The store is **optional** by design. When `TENANT_QUOTAS` is empty
 * (single-tenant / dev deployments) the parsed config has no tenants
 * and the guard short-circuits on every request — no Redis traffic
 * even when a Redis URL is configured.
 */
import { Global, Inject, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ConfigModule } from '../config/config.module';
import { parseQuotaConfig, type ParsedQuotaConfig } from './quota-config';
import {
  QUOTA_CONFIG,
  QUOTA_STORE,
  QuotaGuard,
} from './quota.guard';
import {
  InMemoryQuotaStore,
  QuotaStore,
  RedisQuotaStore,
} from './quota-store';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: QUOTA_CONFIG,
      useFactory: (config: AppConfigService) =>
        parseQuotaConfig(config.tenantQuotasRaw),
      inject: [AppConfigService],
    },
    {
      provide: QUOTA_STORE,
      useFactory: async (
        config: AppConfigService,
        quotaConfig: ParsedQuotaConfig,
      ): Promise<QuotaStore> => {
        const logger = new Logger('QuotaStoreFactory');
        // Use Redis when BOTH (a) tenants are actually configured and
        // (b) the operator has set REDIS_URL. Single-process dev gets
        // the in-memory backend — correct for one replica, observable
        // and bound to process lifetime.
        //
        // Condition (a) was documented in this module's docblock ("no Redis
        // traffic even when a Redis URL is configured") and in the comment
        // above, but was NEVER IMPLEMENTED — the factory checked only (b), so
        // setting REDIS_URL alone opened a real connection that nothing used,
        // because QuotaGuard short-circuits when no tenants are configured.
        // That is not merely wasteful: the client is long-lived and kept
        // Node's event loop alive, so any process that set REDIS_URL without
        // TENANT_QUOTAS would not exit. Found when adding REDIS_URL to CI's
        // integration job hung the suite AFTER it printed all-green.
        if (config.redisUrl && quotaConfig.byTenant.size > 0) {
          try {
            // `ioredis` is already a dep (used by RedisStreamHubStrategy).
            // We type the import minimally — the RedisQuotaStore only
            // needs `.eval()` so we don't pull in the full @types signature.
            const { default: Redis } = await import('ioredis');
            const client = new Redis(config.redisUrl);
            client.on('error', (e: Error) =>
              logger.warn(`redis quota error: ${e.message}`),
            );
            logger.log('Quota store: redis');
            return new RedisQuotaStore(
              client as unknown as ConstructorParameters<typeof RedisQuotaStore>[0],
              logger,
            );
          } catch (e) {
            logger.warn(
              `ioredis import failed, falling back to in-memory quotas: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        }
        logger.log('Quota store: in-memory');
        return new InMemoryQuotaStore();
      },
      inject: [AppConfigService, QUOTA_CONFIG],
    },
    QuotaGuard,
  ],
  exports: [QUOTA_CONFIG, QUOTA_STORE, QuotaGuard],
})
export class QuotaModule implements OnModuleDestroy {
  constructor(@Inject(QUOTA_STORE) private readonly store: QuotaStore) {}

  /**
   * Close the quota store on shutdown. `RedisQuotaStore` holds a long-lived
   * ioredis client which keeps Node's event loop alive; without this a
   * quota-configured process never exits cleanly. `InMemoryQuotaStore` has no
   * `close`, hence the capability check rather than a wider interface — the
   * `QuotaStore` contract deliberately stays minimal.
   */
  async onModuleDestroy(): Promise<void> {
    const closable = this.store as QuotaStore & { close?: () => Promise<void> };
    if (typeof closable.close === 'function') {
      await closable.close();
    }
  }
}
