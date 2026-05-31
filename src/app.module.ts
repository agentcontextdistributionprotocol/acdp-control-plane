import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { AgentsController } from './agents/agents.controller';
import { CapabilityController } from './agents/capability.controller';
import { CapabilityRepository } from './agents/capability.repository';
import { CapabilityService } from './agents/capability.service';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { PinnedKeysAdminController } from './auth/pinned-keys-admin.controller';
import { PinnedKeysService } from './auth/pinned-keys.service';
import { ThrottleByUserGuard } from './auth/throttle-by-user.guard';
import { AppConfigService } from './config/app-config.service';
import { ConfigModule } from './config/config.module';
import { ContextsController } from './contexts/contexts.controller';
import { SafeFederationClient } from './contexts/safe-federation-client';
import { DashboardController } from './dashboard/dashboard.controller';
import { DashboardService } from './dashboard/dashboard.service';
import { DatabaseModule } from './db/database.module';
import { DomainPacksModule } from './domain-packs/domain-packs.module';
import { EventsController } from './events/events.controller';
import { MemoryStreamHubStrategy } from './events/memory-stream-hub.strategy';
import { RedisStreamHubStrategy } from './events/redis-stream-hub.strategy';
import { STREAM_HUB_STRATEGY } from './events/stream-hub.interface';
import { StreamHubService } from './events/stream-hub.service';
import { HealthController } from './health/health.controller';
import { IngestController } from './ingest/ingest.controller';
import { IngestService } from './ingest/ingest.service';
import { MetricsController } from './metrics/metrics.controller';
import { CorrelationIdMiddleware } from './middleware/correlation-id.middleware';
import { RequestLoggerMiddleware } from './middleware/request-logger.middleware';
import { PolicyModule } from './policy/policy.module';
import { PolicyGuard } from './policy/policy.guard';
import { QuotaModule } from './quota/quota.module';
import { QuotaGuard } from './quota/quota.guard';
import { EventProcessorService } from './processor/event-processor.service';
import { RegistriesController } from './registries/registries.controller';
import { RunsController } from './runs/runs.controller';
import { RunsService } from './runs/runs.service';
import { AgentRepository } from './storage/agent.repository';
import { ContextEventRepository } from './storage/context-event.repository';
import { LineageEdgeRepository } from './storage/lineage-edge.repository';
import { DataRetentionService } from './retention/data-retention.service';
import { BanditRouter } from './routing/bandit-router.service';
import { RoutingController } from './routing/routing.controller';
import { RegistryEnrollmentRepository } from './storage/registry-enrollment.repository';
import { RegistryRepository } from './storage/registry.repository';
import { RunRepository } from './storage/run.repository';
import { InstrumentationService } from './telemetry/instrumentation.service';
import { WebhookController } from './webhooks/webhook.controller';
import { WebhookDeliveryRepository } from './webhooks/webhook-delivery.repository';
import { WebhookRepository } from './webhooks/webhook.repository';
import { WebhookService } from './webhooks/webhook.service';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AuthModule.forRoot(),
    PolicyModule,
    QuotaModule,
    // DomainPacksModule is @Global() so IngestService + the GET
    // /domain-packs controller can share one registry instance. Boot
    // fails fast if DOMAIN_PACKS names an unknown pack.
    DomainPacksModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => [
        { ttl: config.throttleTtlMs, limit: config.throttleLimit },
      ],
    }),
  ],
  controllers: [
    IngestController,
    RunsController,
    EventsController,
    ContextsController,
    AgentsController,
    CapabilityController,
    RegistriesController,
    DashboardController,
    WebhookController,
    RoutingController,
    HealthController,
    MetricsController,
    // Admin: pinned-key directory reload. Mounted at AppModule level
    // because the underlying PinnedKeysService is registered globally
    // here (not in AuthModule), and the endpoint is useful even when
    // TOKEN_ISSUANCE_ENABLED=false (capability declarations still
    // depend on the pinned-key directory).
    PinnedKeysAdminController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ThrottleByUserGuard },
    // PolicyGuard runs AFTER AuthGuard so subjectDid/tenantId are
    // populated. Handlers without @CheckPolicy() pass through.
    { provide: APP_GUARD, useClass: PolicyGuard },
    // QuotaGuard runs LAST in the guard chain so we don't burn a
    // counter increment on requests that would have been denied by
    // auth/policy anyway. Handlers without @CheckQuota() pass through.
    { provide: APP_GUARD, useClass: QuotaGuard },

    {
      provide: STREAM_HUB_STRATEGY,
      useFactory: (config: AppConfigService) => {
        if (config.streamHubStrategy === 'redis' && config.redisUrl) {
          return new RedisStreamHubStrategy(config.redisUrl);
        }
        return new MemoryStreamHubStrategy();
      },
      inject: [AppConfigService],
    },
    StreamHubService,

    // Pinned-key directory is @Global() so both AuthModule (TokenIssuer)
    // and AgentsModule (CapabilityService) can inject the same instance.
    // Registering it here unconditionally means capability declarations
    // work even when TOKEN_ISSUANCE_ENABLED is off (the agent still
    // needs to prove they own the DID before declaring caps for it).
    PinnedKeysService,

    // Repositories
    ContextEventRepository,
    RunRepository,
    LineageEdgeRepository,
    AgentRepository,
    CapabilityRepository,
    CapabilityService,
    RegistryRepository,
    RegistryEnrollmentRepository,
    WebhookRepository,
    WebhookDeliveryRepository,

    // Services
    SafeFederationClient,
    InstrumentationService,
    EventProcessorService,
    IngestService,
    RunsService,
    DashboardService,
    WebhookService,
    DataRetentionService,
    {
      provide: BanditRouter,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new BanditRouter({ explorationFraction: config.banditExplorationFraction }),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware, RequestLoggerMiddleware).forRoutes('*');
  }
}
