import { Global, Injectable, Module } from '@nestjs/common';
import { Observable, ReplaySubject } from 'rxjs';

/**
 * The single "are we shutting down?" source (issue #192).
 *
 * `createShutdownHandler` calls {@link begin} FIRST on a shutdown signal, before
 * `app.close()` starts running destroy hooks. Long-lived surfaces (today: the two
 * SSE routes, via `src/events/sse-drain.ts`) subscribe to {@link drained$} and end
 * themselves cleanly with an `event: shutdown`, instead of waiting for the stream
 * hub's `strategy.destroy()` — which runs at a module-order-dependent point and
 * behaves differently for the memory and Redis strategies.
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
}

/** Global so any long-lived surface can inject the drain signal without each
 *  feature module importing it. Sibling of `ShutdownFailuresModule`. */
@Global()
@Module({
  providers: [DrainState],
  exports: [DrainState],
})
export class DrainStateModule {}
