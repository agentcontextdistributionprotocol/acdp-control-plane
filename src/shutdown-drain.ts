import { Global, Injectable, Module } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { Observable, ReplaySubject } from 'rxjs';

/**
 * The phases of a shutdown (issue #192), in order. Monotone: there is no way back.
 *
 *   - `serving`  — normal operation.
 *   - `draining` — a signal arrived; `SHUTDOWN_DRAIN_DELAY_MS` is running (Phase 3).
 *     `/readyz` answers `503 SERVICE_DRAINING` (the health controller) so a load
 *     balancer deregisters this replica, every SSE stream ends with
 *     `event: shutdown`, and EVERYTHING ELSE KEEPS SERVING — a lagging LB still
 *     routes here for a moment, and those requests must not fail.
 *   - `closing`  — the delay is over (or was zero, or skipped by a second signal)
 *     and `app.close()` runs. The drain gate answers every new non-SSE request
 *     with `503 SERVICE_DRAINING`.
 *
 * With the delay unset (the default) `draining` lasts zero ticks: the handler
 * calls `begin()` and `beginClosing()` back to back, which is exactly the Phase 2
 * behaviour.
 */
export type DrainPhase = 'serving' | 'draining' | 'closing';

/**
 * The single "are we shutting down?" source (issue #192).
 *
 * `createShutdownHandler` calls {@link begin} FIRST on a shutdown signal, then
 * {@link beginClosing} once the optional drain delay is over, before `app.close()`
 * starts running destroy hooks. Long-lived surfaces (today: the two SSE routes,
 * via `src/events/sse-drain.ts`) subscribe to {@link drained$} — which fires at
 * the start of `draining` — and end themselves cleanly with an `event: shutdown`,
 * instead of waiting for the stream hub's `strategy.destroy()` — which runs at a
 * module-order-dependent point and behaves differently for the memory and Redis
 * strategies. New non-SSE requests that ARRIVE during `closing` are answered
 * `503 SERVICE_DRAINING` by the drain gate
 * (`src/middleware/drain-gate.middleware.ts`), which decides from the arrival
 * mark {@link createDrainArrivalMarker} stamps, never from the live phase.
 *
 * `drained$` REPLAYS: a subscriber that arrives after `begin()` (a client that
 * reconnects into the drain window) is told immediately.
 *
 * Like `ShutdownFailures`, it has no lifecycle hooks, so Nest's teardown never
 * touches it and it stays usable for the whole of `close()`. `src/bootstrap.ts`
 * resolves it ONCE, right after `NestFactory.create`, and never inside a lambda.
 */
@Injectable()
export class DrainState {
  private readonly subject = new ReplaySubject<void>(1);
  private current: DrainPhase = 'serving';
  private sseStreamsTerminated = 0;
  private drainRejections = 0;

  /** Enter `draining`. Idempotent: a second call (or a call once `closing`) is a no-op. */
  begin(): void {
    if (this.current !== 'serving') return;
    this.current = 'draining';
    this.subject.next();
    this.subject.complete();
  }

  /** Enter `closing` — from either earlier phase (entering `draining` first, so
   *  `drained$` still fires). Idempotent. */
  beginClosing(): void {
    this.begin();
    this.current = 'closing';
  }

  phase(): DrainPhase {
    return this.current;
  }

  /** True from `begin()` on — `draining` or `closing`. What SSE streams and
   *  `/readyz` key on. */
  isDraining(): boolean {
    return this.current !== 'serving';
  }

  /** Emits once (and completes) when the drain begins; replays to late subscribers. */
  get drained$(): Observable<void> {
    return this.subject.asObservable();
  }

  /** An SSE stream was ended with `event: shutdown` (`src/events/sse-drain.ts`). */
  noteSseTermination(): void {
    this.sseStreamsTerminated++;
  }

  /** The drain gate answered a new request with 503 SERVICE_DRAINING. */
  noteRejection(): void {
    this.drainRejections++;
  }

  /** Plain in-process tallies for the shutdown summary log line. Synchronous on
   *  purpose: prom-client's `get()` is async, and the shutdown path must never
   *  await anything it does not have to. */
  stats(): { sseStreamsTerminated: number; drainRejections: number } {
    return {
      sseStreamsTerminated: this.sseStreamsTerminated,
      drainRejections: this.drainRejections,
    };
  }
}

/**
 * Where the arrival marker stamps the drain phase onto a request. A symbol, so
 * no header, query or body field can ever spoof it.
 */
export const DRAIN_ARRIVAL: unique symbol = Symbol('acdp.drainArrival');

type MarkedRequest = { [DRAIN_ARRIVAL]?: DrainPhase };

/**
 * The drain phase the request's HEADERS arrived in, as stamped by
 * {@link createDrainArrivalMarker}; `undefined` when the marker never saw it.
 */
export function arrivalPhase(req: object): DrainPhase | undefined {
  return (req as MarkedRequest)[DRAIN_ARRIVAL];
}

/**
 * Whether the request's headers arrived once the close had begun (`closing`) —
 * the drain gate's ONLY input. A request that arrived while `serving` or during
 * the `draining` delay passes (the delay exists so a lagging load balancer's
 * traffic is still served). `false` when unmarked: a request the marker never
 * saw passes the gate (fail-open to serving, the pre-#192 behaviour), and the
 * integration spec proves the marker is installed.
 */
export function arrivedWhileClosing(req: object): boolean {
  return arrivalPhase(req) === 'closing';
}

/**
 * The arrival marker (#192 Phase 2, plan review #1). `src/bootstrap.ts`
 * registers it with `app.use(...)` BEFORE `app.useBodyParser`, so it runs as
 * soon as Node emits `request` — headers parsed, no body byte consumed yet.
 *
 * WHY IT IS SEPARATE FROM THE GATE. `useBodyParser` registers its parser on the
 * Express instance immediately, while module middleware (`AppModule.configure`)
 * is applied only at `init()`. A gate reading the LIVE phase in module middleware
 * would therefore decide after the body had been fully read, and 503 a POST whose
 * headers arrived before the close but whose body finished after it. The marker
 * records the phase at arrival (Phase 3); the gate (module middleware, after
 * correlation + request logging) turns a `closing` mark into an enveloped,
 * request-logged 503.
 *
 * It only stamps and calls `next()` — it never responds and never touches `res`,
 * so it changes no headers.
 */
export function createDrainArrivalMarker(
  drain: Pick<DrainState, 'phase'>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
    (req as unknown as MarkedRequest)[DRAIN_ARRIVAL] = drain.phase();
    next();
  };
}

/** Global so any long-lived surface can inject the drain signal without each
 *  feature module importing it. Sibling of `ShutdownFailuresModule`. */
@Global()
@Module({
  providers: [DrainState],
  exports: [DrainState],
})
export class DrainStateModule {}
