import { Global, Injectable, Module } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { Observable, ReplaySubject } from 'rxjs';

/**
 * The single "are we shutting down?" source (issue #192).
 *
 * `createShutdownHandler` calls {@link begin} FIRST on a shutdown signal, before
 * `app.close()` starts running destroy hooks. Long-lived surfaces (today: the two
 * SSE routes, via `src/events/sse-drain.ts`) subscribe to {@link drained$} and end
 * themselves cleanly with an `event: shutdown`, instead of waiting for the stream
 * hub's `strategy.destroy()` — which runs at a module-order-dependent point and
 * behaves differently for the memory and Redis strategies. New non-SSE requests
 * are answered `503 SERVICE_DRAINING` by the drain gate
 * (`src/middleware/drain-gate.middleware.ts`), which decides from the ARRIVAL mark
 * {@link createDrainArrivalMarker} stamps, never from the live flag.
 *
 * `drained$` REPLAYS: a subscriber that arrives after `begin()` (a client that
 * reconnects into the drain window) is told immediately. Draining is monotone —
 * there is no way back to serving.
 *
 * Like `ShutdownFailures`, it has no lifecycle hooks, so Nest's teardown never
 * touches it and it stays usable for the whole of `close()`. `src/bootstrap.ts`
 * resolves it ONCE, right after `NestFactory.create`, and never inside a lambda.
 */
@Injectable()
export class DrainState {
  private readonly subject = new ReplaySubject<void>(1);
  private draining = false;
  private sseStreamsTerminated = 0;
  private drainRejections = 0;

  /** Enter the drain. Idempotent: a second call is a no-op. */
  begin(): void {
    if (this.draining) return;
    this.draining = true;
    this.subject.next();
    this.subject.complete();
  }

  isDraining(): boolean {
    return this.draining;
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
 * Where the arrival marker stamps the drain state onto a request. A symbol, so
 * no header, query or body field can ever spoof it.
 */
export const DRAIN_ARRIVAL: unique symbol = Symbol('acdp.drainArrival');

type MarkedRequest = { [DRAIN_ARRIVAL]?: boolean };

/**
 * Whether the request's HEADERS arrived after the drain began, as stamped by
 * {@link createDrainArrivalMarker}. `false` when unmarked: a request the marker
 * never saw passes the gate (fail-open to serving, the pre-#192 behaviour), and
 * the integration spec proves the marker is installed.
 */
export function arrivedDuringDrain(req: object): boolean {
  return (req as MarkedRequest)[DRAIN_ARRIVAL] === true;
}

/**
 * The arrival marker (#192 Phase 2, plan review #1). `src/bootstrap.ts`
 * registers it with `app.use(...)` BEFORE `app.useBodyParser`, so it runs as
 * soon as Node emits `request` — headers parsed, no body byte consumed yet.
 *
 * WHY IT IS SEPARATE FROM THE GATE. `useBodyParser` registers its parser on the
 * Express instance immediately, while module middleware (`AppModule.configure`)
 * is applied only at `init()`. A gate reading the LIVE flag in module middleware
 * would therefore decide after the body had been fully read, and 503 a POST whose
 * headers arrived before SIGTERM but whose body finished after it. The marker
 * records the state at arrival; the gate (module middleware, after correlation +
 * request logging) turns the mark into an enveloped, request-logged 503.
 *
 * It only stamps and calls `next()` — it never responds and never touches `res`,
 * so it changes no headers.
 */
export function createDrainArrivalMarker(
  drain: Pick<DrainState, 'isDraining'>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
    (req as unknown as MarkedRequest)[DRAIN_ARRIVAL] = drain.isDraining();
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
