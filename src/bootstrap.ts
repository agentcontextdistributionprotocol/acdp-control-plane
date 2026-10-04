import 'reflect-metadata';
import { Logger, Type, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { PinoLogger } from './common/pino-logger';
import { applyTrustProxy } from './common/trust-proxy';
import { AppConfigService } from './config/app-config.service';
import { runMigrations } from './db/migrate';
import { GlobalExceptionFilter } from './errors/exception.filter';
import { createShutdownHandler, registerShutdownHandlers, trackOpenConnections } from './shutdown';
import { createDrainArrivalMarker, DrainState } from './shutdown-drain';
import { ShutdownFailures } from './shutdown-failures';
import { InstrumentationService } from './telemetry/instrumentation.service';
import { startTelemetry, stopTelemetry } from './telemetry/telemetry';

/**
 * Boot the control plane: migrations, telemetry, the Nest app, Swagger, and the
 * process-level shutdown handler.
 *
 * Lives outside `main.ts` so a test entrypoint (`test/fixtures/`) can boot a
 * root module that wraps `AppModule` through exactly this wiring. The shutdown
 * exit-code contract can only be observed in a real process, and production
 * code must not carry a fault-injection knob (issue #155).
 */
export async function bootstrap(rootModule: Type<unknown> = AppModule): Promise<void> {
  const config = new AppConfigService();

  // Run database migrations before NestJS bootstraps
  await runMigrations(config.databaseUrl);

  await startTelemetry({
    enabled: config.otelEnabled,
    serviceName: config.otelServiceName,
    otlpEndpoint: config.otelExporterOtlpEndpoint || undefined,
  });

  const pinoLogger = new PinoLogger(config.logLevel, config.isDevelopment);
  const app = await NestFactory.create<NestExpressApplication>(rootModule, {
    cors: false,
    logger: pinoLogger,
    rawBody: true,
  });

  // Resolved ONCE, here, before any signal can arrive (#192) — the same pattern
  // as ShutdownFailures below: no container lookup ever happens during teardown.
  // DrainState has no lifecycle hooks, so it outlives close(). The HTTP server is
  // created in the NestApplication constructor, so it is the one listen() uses.
  const drainState = app.get(DrainState);
  const server = app.getHttpServer() as {
    listening: boolean;
    closeIdleConnections?: () => void;
    closeAllConnections?: () => void;
  } & Parameters<typeof trackOpenConnections>[0];
  // Synchronous open-socket count for the forced-shutdown log (#192), attached
  // before listen() so no socket is missed.
  const openConnections = trackOpenConnections(server);
  // Metrics for the shutdown path, resolved once for the same reason as above.
  const instrumentation = app.get(InstrumentationService);

  // Opt-in reverse-proxy trust (TRUST_PROXY, parsed and validated by
  // AppConfigService at construction above). Unset leaves Express's default.
  // Set before any middleware so every req.ip reader sees the same value.
  applyTrustProxy(app, config.trustProxy);

  // The drain ARRIVAL MARKER (#192 Phase 2). It must be registered BEFORE the
  // body parsers below: Express runs it as soon as Node emits `request` (headers
  // parsed, no body byte consumed), so it records the drain PHASE the request
  // ARRIVED in (Phase 3: serving / draining / closing; only `closing` is gated). The drain gate (module middleware, applied only at
  // init(), i.e. after the parsers) decides from this mark alone — a request
  // whose headers arrived before SIGTERM but whose body finishes after it must
  // run to completion, not get 503. It never responds and sets no header.
  app.use(createDrainArrivalMarker(drainState));

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

  // Resolved now, not inside the handler: the collector must be read AFTER
  // close() has torn the container down. It has no lifecycle hooks, so it
  // outlives the close. NestJS 12 swallows destroy-hook rejections, so this is
  // the only way a failed teardown still exits 1 (issue #155).
  const shutdownFailures = app.get(ShutdownFailures);

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
      hookFailed: () => shutdownFailures.any(),
      exit: (code) => process.exit(code),
      timeoutMs: config.shutdownTimeoutMs,
      // #192: raise the drain before close() so every SSE stream ends with
      // `event: shutdown`, then reap sockets that go idle during the close —
      // only once the listener is closed (see ShutdownDeps.listenerClosed).
      beginDrain: () => drainState.begin(),
      // #192 Phase 3: the opt-in pre-close delay (`draining`: /readyz 503s, the
      // rest serves), then `closing` (the drain gate 503s new requests).
      drainDelayMs: config.shutdownDrainDelayMs,
      beginClosing: () => drainState.beginClosing(),
      listenerClosed: () => !server.listening,
      reapIdleConnections: () => server.closeIdleConnections?.(),
      // Last resort when the graceful close overruns its deadline: an in-flight
      // request otherwise holds http.Server.close() open indefinitely.
      forceCloseConnections: () => server.closeAllConnections?.(),
      // #192: how many sockets that cut (counted synchronously), plus the drain
      // tallies for the `shutdown drain complete` summary line.
      openConnections,
      recordForcedConnections: (count) =>
        instrumentation.shutdownForcedConnectionsTotal.inc(count),
      drainStats: () => drainState.stats(),
    }),
  );
}

/** Log a failed boot and exit 1. Shared by `main.ts` and test entrypoints. */
export function reportBootstrapFailure(err: unknown): never {
  new Logger('Bootstrap').error(
    { msg: 'bootstrap failed', error: err instanceof Error ? err.message : String(err) },
    err instanceof Error ? err.stack : undefined,
  );
  process.exit(1);
}
