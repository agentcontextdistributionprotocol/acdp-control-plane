import { HttpStatus, Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { AppConfigService } from '../config/app-config.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { arrivedWhileClosing, DrainState } from '../shutdown-drain';
import { InstrumentationService } from '../telemetry/instrumentation.service';

/**
 * The two SSE routes. Case-insensitive with an optional trailing slash, because
 * Express routes `/Events/Stream/` to the same handler — the exemption must match
 * exactly what reaches the SSE controllers (plan Round 2 #3).
 */
const SSE_ROUTES: readonly RegExp[] = [/^\/runs\/[^/]+\/events\/stream\/?$/i, /^\/events\/stream\/?$/i];

/**
 * The request's path as the CLIENT sent it, from `req.originalUrl`.
 *
 * NOT `req.path`: Nest mounts `forRoutes('*')` middleware so that Express strips
 * the matched prefix from `req.url`, and inside this middleware `req.path` reads
 * `/` (measured — the integration spec's SSE probes got 503 with `req.path`).
 * `originalUrl` is never rewritten. Absolute-form request targets
 * (`GET http://host/events/stream`) are reduced to their path, as Express's own
 * routing does.
 */
export function requestPath(req: Pick<Request, 'originalUrl'>): string {
  const target = (req.originalUrl ?? '').split('?', 1)[0] ?? '';
  return target.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '') || '/';
}

/** Whether this is a request the SSE exemption covers: `GET` on an SSE route. */
export function isSseRequest(req: Pick<Request, 'method' | 'originalUrl'>): boolean {
  if (req.method !== 'GET') return false;
  const path = requestPath(req);
  return SSE_ROUTES.some((re) => re.test(path));
}

/**
 * The drain gate (issue #192, Phase 2). Registered in `AppModule.configure()`
 * AFTER `CorrelationIdMiddleware` and `RequestLoggerMiddleware`, so its 503
 * carries an `X-Request-Id` and gets a request-log line — and, being middleware,
 * it runs before every `APP_GUARD`: a draining 503 costs no `ThrottleByUserGuard`
 * budget and no `QuotaGuard` increment, and `@Public()` is irrelevant.
 *
 * It decides ONLY from the arrival mark (`arrivedWhileClosing`, stamped by the
 * marker `src/bootstrap.ts` installs before the body parsers), never from the
 * live `DrainState.phase()`. A request whose headers arrived before the close
 * therefore passes even if its body completes after it — the regression the
 * split exists to prevent (see `createDrainArrivalMarker`).
 *
 * Phases (#192 Phase 3): during `draining` — the opt-in `SHUTDOWN_DRAIN_DELAY_MS`
 * window — the gate passes EVERYTHING: that window exists so a load balancer
 * that has not yet deregistered this replica still gets its requests served.
 * Readiness during `draining` is the health controller's job (readiness → 503),
 * the ONE readiness mechanism; this gate has no route check for it. Only a
 * request arriving in `closing` is rejected.
 *
 * Exempt: `GET` on the two SSE routes. A non-2xx kills `EventSource` for good
 * (`readyState` CLOSED, no retry), so a new SSE request instead takes the
 * subscribe-after-drain path: `200` + `event: shutdown` + `retry:` + end, and the
 * browser reconnects to a live replica. (The guards still run after this gate,
 * so e.g. a JWT revocation lookup after `pool.end()` can still fail an SSE
 * reconnect — a residual risk bounded to the last moments of the close.)
 *
 * Everything else that arrived during `closing` — both health probes included,
 * with no route special-casing — gets
 * `503 SERVICE_DRAINING` with `Retry-After` and `Connection: close`, through
 * `GlobalExceptionFilter` (so the JSON envelope, `application/acdp+json`, and the
 * helmet + CORS headers registered ahead of module middleware are all present).
 * A CORS preflight never gets here: `cors()` ends it with 204 itself.
 *
 * Nest's own `return503OnClosing` is deliberately NOT used: its bare `text/html`
 * 503 bypasses all of the above and 503s SSE reconnects too
 * (`plans/archive/graceful-drain-192.md`).
 */
@Injectable()
export class DrainGateMiddleware implements NestMiddleware {
  constructor(
    private readonly drain: DrainState,
    private readonly config: AppConfigService,
    private readonly instrumentation: InstrumentationService,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (!arrivedWhileClosing(req) || isSseRequest(req)) {
      next();
      return;
    }
    this.drain.noteRejection();
    this.instrumentation.shutdownDrainRejectionsTotal.inc();
    // Set BEFORE throwing: the filter writes status + body onto this same
    // response, so headers already on it survive, but it would not add them.
    res.setHeader('Retry-After', String(this.config.shutdownDrainRetryAfterSeconds));
    // Node closes the socket after this response, so a keep-alive client
    // reconnects — through the load balancer, to a live replica.
    res.setHeader('Connection', 'close');
    throw new AppException(
      ErrorCode.SERVICE_DRAINING,
      'This instance is shutting down; retry the request (another replica will serve it).',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
