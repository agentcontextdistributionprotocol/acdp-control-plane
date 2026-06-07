import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import * as promClient from 'prom-client';
import { AppModule } from '../../src/app.module';
import { AppConfigService } from '../../src/config/app-config.service';
import { runMigrations } from '../../src/db/migrate';
import { DatabaseService } from '../../src/db/database.service';
import { GlobalExceptionFilter } from '../../src/errors/exception.filter';
import { TestClient } from './test-client';
import { truncateAll, TEST_DB_URL } from './test-db';

export interface TestAppContext {
  app: INestApplication;
  url: string;
  client: TestClient;
  module: TestingModule;
  cleanup: () => Promise<void>;
}

export interface TestAppOptions {
  /** When set, HMAC verification is enabled with this secret (matches WEBHOOK_SECRET). */
  webhookSecret?: string;
  /** API key for AUTH. Defaults to 'test-key'. */
  apiKey?: string;
  /**
   * Multi-tenant API-key mapping. When provided, sets TENANT_API_KEYS
   * AND replaces apiKey/AUTH_API_KEYS with the union of all keys.
   * Format: `[{tenantId, apiKey}, ...]`. See
   * `src/tenant/tenant-context.ts::parseTenantApiKeys` for wire format.
   */
  tenantApiKeys?: Array<{ tenantId: string; apiKey: string }>;
  /**
   * Domain packs to activate. Sets DOMAIN_PACKS env var for the duration
   * of this app. Empty / undefined → packs disabled (default). Used by
   * the domain-packs integration test; other suites should leave this
   * alone so they don't trip the context-type gate.
   */
  domainPacks?: string;
  /**
   * Admin api key. When provided, joins the AUTH_API_KEYS union AND
   * sets AUTH_ADMIN_API_KEYS so the AuthGuard flags requests carrying
   * this key as `actorIsAdmin = true`. Used by admin-only endpoint
   * tests (revocation feed, pinned-keys reload).
   */
  adminApiKey?: string;
  /**
   * Force strict tenant mode (AUTH_REQUIRE_TENANT=true). Auto-enabled whenever
   * `tenantApiKeys` is set, because the app now fails startup if tenant
   * bindings exist without strict mode (multi-tenant fail-fast). Set
   * explicitly for the rare strict-mode-without-bindings case.
   */
  requireTenant?: boolean;
}

/**
 * Boot a real NestJS application for integration testing.
 *
 * Migrations run before the app is created. The app listens on a random
 * port; tests reach it via `ctx.client` (typed HTTP) or `ctx.url`.
 */
export async function createTestApp(opts: TestAppOptions = {}): Promise<TestAppContext> {
  const apiKey = opts.apiKey ?? 'test-key';
  const webhookSecret = opts.webhookSecret ?? '';
  const tenantApiKeys = opts.tenantApiKeys ?? [];

  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.NODE_ENV = 'development';
  // When tenantApiKeys is set, AUTH_API_KEYS is the union of all keys
  // (the AuthGuard validates against this list); TENANT_API_KEYS maps
  // each key to its tenant.
  if (tenantApiKeys.length > 0) {
    process.env.AUTH_API_KEYS = tenantApiKeys.map((t) => t.apiKey).join(',');
    process.env.TENANT_API_KEYS = tenantApiKeys
      .map((t) => `${t.tenantId}:${t.apiKey}`)
      .join(',');
  } else {
    process.env.AUTH_API_KEYS = apiKey;
    delete process.env.TENANT_API_KEYS;
  }
  // Tenant bindings require strict mode or the app fails startup (multi-tenant
  // fail-fast). Auto-enable it for any multi-tenant test app; allow an explicit
  // opt-in otherwise. Clear it when neither applies so env doesn't leak across
  // suites (process.env is mutated in place).
  if (tenantApiKeys.length > 0 || opts.requireTenant) {
    process.env.AUTH_REQUIRE_TENANT = 'true';
  } else {
    delete process.env.AUTH_REQUIRE_TENANT;
  }
  if (opts.adminApiKey) {
    // Union the admin key into AUTH_API_KEYS so AuthGuard accepts it,
    // then mark it as admin via AUTH_ADMIN_API_KEYS.
    const existing = process.env.AUTH_API_KEYS ?? '';
    const set = new Set(
      existing.split(',').map((s) => s.trim()).filter(Boolean),
    );
    set.add(opts.adminApiKey);
    process.env.AUTH_API_KEYS = Array.from(set).join(',');
    process.env.AUTH_ADMIN_API_KEYS = opts.adminApiKey;
  } else {
    delete process.env.AUTH_ADMIN_API_KEYS;
  }
  process.env.WEBHOOK_SECRET = webhookSecret;
  process.env.OTEL_ENABLED = 'false';
  process.env.LOG_LEVEL = 'warn';
  process.env.PLAYGROUND_URL = '';
  process.env.STREAM_SSE_HEARTBEAT_MS = '60000';
  if (opts.domainPacks) {
    process.env.DOMAIN_PACKS = opts.domainPacks;
  } else {
    delete process.env.DOMAIN_PACKS;
  }

  // Clear Prometheus registry — prevents duplicate-metric errors across suites.
  promClient.register.clear();

  await runMigrations(TEST_DB_URL);

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  // Mirror main.ts: raise the body-parser limit to INGEST_MAX_BODY_BYTES so the
  // harness exercises the same ingest ceiling as production.
  const config = app.get(AppConfigService);
  app.useBodyParser('json', { limit: config.ingestMaxBodyBytes });
  app.useBodyParser('urlencoded', {
    limit: config.ingestMaxBodyBytes,
    extended: true,
  });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableCors({ origin: '*', credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  await app.listen(0);
  const url = await app.getUrl();
  const client = new TestClient(url, apiKey);

  const cleanup = async () => {
    const db = moduleRef.get(DatabaseService);
    await truncateAll(db.pool);
  };

  return { app, url, client, module: moduleRef, cleanup };
}
