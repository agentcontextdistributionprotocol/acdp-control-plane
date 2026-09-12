import 'dotenv/config';
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { PinoLogger } from './common/pino-logger';
import { AppConfigService } from './config/app-config.service';
import { runMigrations } from './db/migrate';
import { GlobalExceptionFilter } from './errors/exception.filter';
import { createShutdownHandler, registerShutdownHandlers } from './shutdown';
import { startTelemetry, stopTelemetry } from './telemetry/telemetry';

async function bootstrap() {
  const config = new AppConfigService();

  // Run database migrations before NestJS bootstraps
  await runMigrations(config.databaseUrl);

  await startTelemetry({
    enabled: config.otelEnabled,
    serviceName: config.otelServiceName,
    otlpEndpoint: config.otelExporterOtlpEndpoint || undefined,
  });

  const pinoLogger = new PinoLogger(config.logLevel, config.isDevelopment);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: false,
    logger: pinoLogger,
    rawBody: true,
  });

  // Align the framework body-parser limit with INGEST_MAX_BODY_BYTES. Without
  // this, Express's ~100 kB default rejects legitimate registry webhooks before
  // they reach the HMAC check — the registry's own max_payload_bytes is 1 MB, so
  // the CP must accept the same ceiling. `useBodyParser` preserves the rawBody
  // capture (rawBody: true above) that the ingest HMAC verification depends on.
  const bodyLimit = config.ingestMaxBodyBytes;
  app.useBodyParser('json', { limit: bodyLimit });
  app.useBodyParser('urlencoded', { limit: bodyLimit, extended: true });

  app.use(helmet());
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableCors({ origin: config.corsOrigin, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  if (config.swaggerEnabled) {
    const swagger = new DocumentBuilder()
      .setTitle('ACDP Control Plane')
      .setDescription(
        'Control plane for the Agent Context Distribution Protocol — ingests registry events, ' +
          'correlates runs, broadcasts SSE, and acts as an IdP for federated bearer tokens.',
      )
      .setVersion(config.clientVersion)
      .addBearerAuth()
      .addTag('auth', 'Challenge / token issuance (IdP for federated registries).')
      .addTag('agents', 'Agent registry and capability discovery.')
      .addTag('contexts', 'Context lineage browsing.')
      .addTag('runs', 'Run lifecycle.')
      .addTag('ingest', 'Webhook ingestion from registries.')
      .build();
    const document = SwaggerModule.createDocument(app, swagger);
    SwaggerModule.setup(config.swaggerPath, app, document);
  }

  // NOTE: `app.enableShutdownHooks()` is deliberately NOT called. It registers
  // Nest's own SIGTERM/SIGINT listeners, which would run the destroy hooks a
  // SECOND time alongside the handler below — `pool.end()` then throws "Called
  // end on pool more than once" and the process dies mid-shutdown with exit 1.
  // `app.close()` already runs the destroy and shutdown hooks on its own, and
  // nothing in src/ implements OnApplicationShutdown, so nothing is lost.
  // See src/shutdown.ts and issue #158.
  await app.listen(config.port, config.host);

  registerShutdownHandlers(
    createShutdownHandler({
      // Thread the signal through. `NestApplicationContext.close(signal)`
      // forwards it to callBeforeShutdownHook/callShutdownHook at runtime, but
      // @nestjs/common's public interface still declares `close(): Promise<void>`
      // — hence the cast. Without it a future OnApplicationShutdown implementer
      // would receive `undefined` where `enableShutdownHooks()` gave it
      // 'SIGTERM', which is the one behaviour removing that call would otherwise
      // have cost us. Drop the cast if/when the published types catch up.
      close: (signal) =>
        (app.close as (signal?: string) => Promise<void>)(signal),
      stopTelemetry,
      exit: (code) => process.exit(code),
      timeoutMs: config.shutdownTimeoutMs,
      // Last resort when the graceful close overruns its deadline: an in-flight
      // request otherwise holds http.Server.close() open indefinitely.
      forceCloseConnections: () => {
        const server = app.getHttpServer() as { closeAllConnections?: () => void };
        server.closeAllConnections?.();
      },
    }),
  );
}

bootstrap().catch((err) => {
  new Logger('Bootstrap').error(
    `bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
    err instanceof Error ? err.stack : undefined,
  );
  process.exit(1);
});
