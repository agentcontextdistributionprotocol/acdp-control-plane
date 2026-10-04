import { Logger } from '@nestjs/common';

/**
 * The signals we terminate on.
 *
 * Deliberately NOT handled, and why — `enableShutdownHooks()` registered all
 * eleven of Nest's `ShutdownSignal` values, so dropping any of them is a real
 * behaviour change rather than an oversight:
 *   - the fault signals (SIGSEGV, SIGABRT, SIGILL, SIGTRAP, SIGBUS, SIGFPE) —
 *     trapping these masks a genuine crash and risks running destroy hooks on a
 *     corrupted process. Letting Node die is correct.
 *   - SIGHUP — under a terminal this means "the terminal went away"; Node's
 *     default is fine.
 *   - SIGUSR2 — used by nodemon and by Node's own inspector. Claiming it can
 *     break both, and this service is not run under nodemon.
 * SIGQUIT IS handled: `docker kill -s QUIT` and ctrl-\ are ordinary ways to stop
 * a container, and they should drain the pool like any other stop.
 */
export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGQUIT'] as const;

/**
 * How long the graceful close may take before we stop waiting and force the exit.
 *
 * This is not optional politeness. `app.close()` disposes the HTTP server, and
 * `http.Server.close()` waits for every ACTIVE connection to finish — so a single
 * in-flight request holds shutdown open indefinitely. Without a deadline the
 * process never exits, the orchestrator SIGKILLs it after its grace period, and
 * the result is exit 137: the same "looks like a crash" signature this module was
 * written to eliminate, reached by a slower route. Ten seconds sits inside the
 * common 30s termination grace period, leaving room for the forced path below.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * How often the idle-socket reaper ticks during a close (issue #192).
 *
 * `http.Server.close()` closes only the connections that are idle AT THAT MOMENT.
 * A socket that goes idle later — every SSE stream once the drain has ended it,
 * and every request that finishes during the close — is otherwise reaped only by
 * `keepAliveTimeout` + `keepAliveTimeoutBuffer` (~6 s on Node 26), which made every
 * shutdown with an SSE client take ~6 s and, with a deadline below that, exit 1
 * for nothing dropped. Measured: polling every 100 ms brings that to ~0.1 s.
 */
export const DEFAULT_REAP_INTERVAL_MS = 100;
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/** Everything the handler touches, injected so the sequencing can be tested
 *  without spawning a process or standing up a real Nest application. */
export interface ShutdownDeps {
  /**
   * Closes the Nest application — runs every `OnModuleDestroy`,
   * `BeforeApplicationShutdown` and `OnApplicationShutdown` hook.
   *
   * The signal is threaded through because `app.close(signal)` forwards it to
   * `callBeforeShutdownHook`/`callShutdownHook`. Dropping it would hand a future
   * `OnApplicationShutdown` implementer `undefined` where `enableShutdownHooks()`
   * would have given it `'SIGTERM'` — a silent regression in the one interface
   * this module took responsibility for.
   */
  close: (signal?: string) => Promise<void>;
  /** Flushes OpenTelemetry. Started before Nest exists, so it is shut down
   *  outside the Nest lifecycle too. */
  stopTelemetry: () => Promise<void>;
  exit: (code: number) => void;
  /**
   * Drop lingering sockets when the graceful close overruns `timeoutMs`. Wired to
   * `http.Server.closeAllConnections()`; optional so the handler stays testable
   * and usable without an HTTP server.
   */
  forceCloseConnections?: () => void;
  /**
   * Reports whether any destroy hook failed during `close()`. Wired to
   * `ShutdownFailures.any()` (`src/shutdown-failures.ts`).
   *
   * NestJS 12 runs destroy hooks under `Promise.allSettled` and only LOGS a
   * rejection, so `close()` resolves even when e.g. `pool.end()` throws. Without
   * this input, a failed teardown would exit 0 (issue #155). Optional so the
   * handler stays usable without a Nest app.
   */
  hookFailed?: () => boolean;
  /**
   * Enter the drain (issue #192). Called FIRST — before `close()` runs any destroy
   * hook — so every SSE stream ends with `event: shutdown` regardless of module
   * destroy order or stream-hub strategy. Wired to `DrainState.begin()`. A throw
   * is logged and does not change the exit code.
   */
  beginDrain?: () => void;
  /**
   * Whether the HTTP listener has stopped accepting connections — wired to
   * `!server.listening`, which flips when Nest's `dispose()` calls
   * `httpServer.close()`. The reaper is GATED on this: `closeIdleConnections()`
   * also destroys a freshly accepted socket that has not sent its request line
   * yet, so reaping while the listener is open would reset brand-new connections.
   * Once it is closed no socket can be accepted, so the reaper only ever hits
   * sockets that went idle. Absent → the reaper never runs (fail-safe).
   */
  listenerClosed?: () => boolean;
  /**
   * Close every connection with no request in flight — wired to
   * `http.Server.closeIdleConnections()`. It never touches a socket with an
   * active request, so in-flight requests keep their full grace. Polled every
   * {@link reapIntervalMs} from drain start until `close()` settles or the
   * deadline fires, but only once {@link listenerClosed} reports true. A throw is
   * swallowed (best effort, like `forceCloseConnections`).
   */
  reapIdleConnections?: () => void;
  /** Defaults to {@link DEFAULT_REAP_INTERVAL_MS}. */
  reapIntervalMs?: number;
  /**
   * How many sockets the HTTP server holds open right now — read SYNCHRONOUSLY on
   * the forced path, just before {@link forceCloseConnections}, so the overrun log
   * can say how many connections it cut (#192, plan review #7). Wired to a live
   * `connection`/`close` counter in `bootstrap.ts`, deliberately NOT
   * `server.getConnections()`: that one is callback-async, and the forced path
   * must never wait on anything. A throw is reported as `forcedConnections: null`.
   */
  openConnections?: () => number;
  /** Told the forced-connection count (wired to
   *  `acdp_shutdown_forced_connections_total`). Best effort; a throw is swallowed. */
  recordForcedConnections?: (count: number) => void;
  /** Drain tallies for the `shutdown drain complete` summary line — wired to
   *  `DrainState.stats()`. Synchronous; a throw only drops the fields. */
  drainStats?: () => { sseStreamsTerminated: number; drainRejections: number };
  /** Clock for `drainMs`; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Leave the `draining` phase and enter `closing` (issue #192 Phase 3) — wired to
   * `DrainState.beginClosing()`. Called after the drain delay (immediately when
   * there is none), just before `close()`: from here on the drain gate 503s new
   * non-SSE requests. A throw is logged and does not change the exit code.
   */
  beginClosing?: () => void;
  /**
   * The opt-in pre-close drain delay, `SHUTDOWN_DRAIN_DELAY_MS` (issue #192
   * Phase 3). After {@link beginDrain} the handler waits this long — `/readyz`
   * already 503 so a load balancer deregisters the replica, every other route
   * still serving — before {@link beginClosing} and `close()`. 0 / absent skips
   * the wait entirely (the pre-Phase-3 timing). The wait is `unref()`'d and is
   * cut short by a second signal. It is NOT covered by {@link timeoutMs}, which
   * bounds only `close()`: the worst case is delay + timeout.
   */
  drainDelayMs?: number;
  /** Defaults to {@link DEFAULT_SHUTDOWN_TIMEOUT_MS}. */
  timeoutMs?: number;
  logger?: Pick<Logger, 'error' | 'log'>;
}

/**
 * Build the process-level shutdown handler.
 *
 * WHY THIS IS NOT INLINE IN `main.ts`, AND WHY `enableShutdownHooks()` IS GONE.
 *
 * `main.ts` used to call BOTH `app.enableShutdownHooks()` — which makes Nest
 * register its own SIGTERM/SIGINT listeners that call `close()` — AND
 * `process.on('SIGTERM', …)` with a handler that also called `app.close()`. Node
 * runs every listener registered for a signal, and
 * `NestApplicationContext.close()` has NO idempotency guard: it invokes
 * `callDestroyHook()` unconditionally. (The `receivedSignal` flag that does exist
 * lives inside Nest's own `listenToShutdownSignals` closure and only suppresses a
 * second *signal*, not a programmatic `close()`.)
 *
 * So a single SIGTERM ran every `OnModuleDestroy` twice. `DatabaseService` calls
 * `pool.end()`, and `pg` rejects the second call with "Called end on pool more
 * than once". The old handler had no `try/catch`, so that rejection was unhandled
 * and killed the process mid-shutdown. Measured: **exit code 1** on every
 * intentional stop, and `stopTelemetry()` never ran — so the telemetry that would
 * explain the non-zero exit was exactly what got dropped. Under an orchestrator
 * every rolling deploy looked like a crash.
 *
 * Nothing in `src/` implements `OnApplicationShutdown` or
 * `BeforeApplicationShutdown`, so `enableShutdownHooks()` contributed *only* those
 * duplicate listeners — `app.close()` already runs the destroy hooks and the
 * shutdown hooks by itself. Removing it loses no behaviour.
 *
 * Three properties this handler guarantees, each of which was broken:
 *   1. **Idempotent** — a second signal while shutdown is in flight never starts
 *      a second pass over the destroy hooks. Its one effect (#192 Phase 3) is to
 *      skip whatever remains of the opt-in drain delay.
 *   2. **Error-contained** — a throwing hook cannot prevent the remaining steps.
 *      `stopTelemetry()` runs even if `close()` rejects, because a failed shutdown
 *      is precisely when you want the traces flushed.
 *   3. **Deterministic exit** — an intentional stop exits 0, so an orchestrator can
 *      tell a clean shutdown from a crash; a failed teardown (a rejected close, a
 *      failed destroy hook reported via `hookFailed`, an overrun, or a telemetry
 *      flush error) exits 1.
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal?: string) => Promise<void> {
  const logger = deps.logger ?? new Logger('Shutdown');
  let inFlight: Promise<void> | undefined;
  // Ends the pending drain delay early; set only while that delay is running.
  let skipDelay: (() => void) | undefined;

  const run = async (signal?: string): Promise<void> => {
    let failed = false;
    const now = deps.now ?? Date.now;
    const drainStartedAt = now();

    // Outside every try below, so it cannot itself reject the memoized promise.
    try {
      logger.log({ msg: 'received signal, closing gracefully', signal: signal ?? 'shutdown' });
    } catch {
      // A logger that throws must not abort the shutdown it is narrating.
    }

    // Drain first (#192): before any destroy hook runs, so the SSE streams end
    // with `event: shutdown` at a module-order-independent point. Contained, like
    // every other step: a failed drain must not abort the close.
    try {
      deps.beginDrain?.();
    } catch (err) {
      try {
        logger.error({
          msg: 'could not begin the shutdown drain — closing anyway',
          error: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // A throwing logger must not abort the shutdown.
      }
    }

    // The opt-in drain delay (#192 Phase 3): `/readyz` is already 503 (the
    // health controller reads the `draining` phase) and SSE streams have ended,
    // but every other route keeps serving while the load balancer deregisters
    // this replica. Cancellable — a second signal skips the rest (see the
    // returned handler) — and `unref()`'d so the timer never holds the loop
    // open by itself. Skipped entirely at 0: no timer, no extra tick.
    const delayMs = deps.drainDelayMs ?? 0;
    let delayWaitedMs = 0;
    if (delayMs > 0) {
      try {
        logger.log({ msg: 'draining before close — readiness now 503', configuredDelayMs: delayMs });
      } catch {
        // A throwing logger must not abort the shutdown.
      }
      const delayStartedAt = now();
      await new Promise<void>((resolve) => {
        // `finish` reads `timer` only when called — by the timer itself or by a
        // second signal — both strictly after the assignment below.
        const finish = (): void => {
          clearTimeout(timer);
          skipDelay = undefined;
          resolve();
        };
        const timer = setTimeout(finish, delayMs);
        timer.unref?.();
        skipDelay = finish;
      });
      delayWaitedMs = now() - delayStartedAt;
    }

    // Enter `closing`: from here the drain gate 503s new non-SSE requests.
    try {
      deps.beginClosing?.();
    } catch (err) {
      try {
        logger.error({
          msg: 'could not enter the closing phase — closing anyway',
          error: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // A throwing logger must not abort the shutdown.
      }
    }

    // Reap sockets that go idle DURING the close (#192; see
    // DEFAULT_REAP_INTERVAL_MS). Started now, but each tick only reaps once the
    // listener is closed (see ShutdownDeps.listenerClosed). `unref()` so it never
    // holds the loop open; cleared after the race below on BOTH paths.
    let reaper: NodeJS.Timeout | undefined;
    let reaperErrorLogged = false;
    if (deps.reapIdleConnections) {
      const reap = deps.reapIdleConnections;
      reaper = setInterval(() => {
        try {
          if (deps.listenerClosed?.() === true) reap();
        } catch (err) {
          // Best effort: the deadline + forceCloseConnections still bound the close.
          // Log once so a probe that throws every tick is visible rather than a
          // silent return to the old ~6 s / exit-1 shutdown.
          if (!reaperErrorLogged) {
            reaperErrorLogged = true;
            try {
              logger.error({
                msg: 'idle-socket reaper failed — relying on the shutdown deadline',
                error: err instanceof Error ? err.message : String(err),
              });
            } catch {
              // A throwing logger must not abort the shutdown.
            }
          }
        }
      }, deps.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS);
      reaper.unref?.();
    }

    const closePhase = (async () => {
      try {
        await deps.close(signal);
      } catch (err) {
        failed = true;
        logger.error(
          {
            msg: 'error closing the application',
            error: err instanceof Error ? err.message : String(err),
          },
          err instanceof Error ? err.stack : undefined,
        );
      }
    })();

    // Race the close against a deadline. `unref()` so the timer itself never
    // keeps the process alive — if the close finishes first there is nothing
    // left holding the loop open, and we must not be the thing that does.
    const timeoutMs = deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
      timer.unref?.();
    });

    await Promise.race([closePhase, deadline]);
    if (timer) clearTimeout(timer);
    if (reaper) clearInterval(reaper);

    // 0 on a clean close: nothing was cut. On the forced path, the sockets still
    // open just before closeAllConnections() — or null when that count could not
    // be read (never awaited; see ShutdownDeps.openConnections).
    let forcedConnections: number | null = 0;
    if (timedOut) {
      failed = true;
      forcedConnections = null;
      try {
        if (deps.openConnections) forcedConnections = deps.openConnections();
      } catch {
        // Unknown, not zero: report null rather than claim nothing was cut.
      }
      try {
        logger.error({
          msg: 'graceful close timed out — forcing shutdown',
          detail:
            'In-flight requests are being dropped; a hung close usually means an ' +
            'open connection (SSE, keep-alive) or a destroy hook that never settles.',
          timeoutMs,
          forcedConnections,
        });
      } catch {
        // A throwing logger must not abort the forced path.
      }
      try {
        if (forcedConnections !== null) deps.recordForcedConnections?.(forcedConnections);
      } catch {
        // Best effort: metrics on a dying process.
      }
      try {
        deps.forceCloseConnections?.();
      } catch {
        // Best effort: we are already on the forced path.
      }
    }

    // One structured summary line per shutdown (#192) — the primary drain
    // signal, since a dying process's counters are rarely scraped.
    try {
      let stats: { sseStreamsTerminated: number; drainRejections: number } | undefined;
      try {
        stats = deps.drainStats?.();
      } catch {
        stats = undefined;
      }
      logger.log({
        msg: 'shutdown drain complete',
        drainMs: now() - drainStartedAt,
        drainDelayMs: delayWaitedMs,
        sseStreamsTerminated: stats?.sseStreamsTerminated ?? null,
        drainRejections: stats?.drainRejections ?? null,
        forcedConnections,
      });
    } catch {
      // A throwing logger must not abort the shutdown.
    }

    // A hook that failed inside close() but did not reject it (NestJS 12
    // semantics). Read after the race, so a hook that failed before an overrun
    // is still counted. A throwing probe counts as a failure: we cannot vouch
    // for a clean teardown we were unable to check.
    try {
      if (deps.hookFailed?.()) {
        failed = true;
        logger.error('one or more destroy hooks failed during close — exiting 1');
      }
    } catch {
      failed = true;
      try {
        logger.error('could not check destroy-hook failures — exiting 1');
      } catch {
        // A throwing logger must not abort the shutdown.
      }
    }

    // Deliberately outside the close handling: telemetry must be flushed even
    // when the close failed or overran, because that is exactly when the traces
    // explaining it matter.
    try {
      await deps.stopTelemetry();
    } catch (err) {
      failed = true;
      logger.error({
        msg: 'error stopping telemetry',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      deps.exit(failed ? 1 : 0);
    } catch {
      // `exit` throwing would reject the memoized promise and surface as an
      // unhandled rejection — the original #158 failure mode by another route.
    }
  };

  return (signal?: string): Promise<void> => {
    // Return the SAME promise rather than starting a second pass. A container
    // that sends SIGTERM and then SIGKILL, or a developer pressing ctrl-c twice,
    // must not re-enter the destroy hooks.
    if (inFlight) {
      // #192 Phase 3 (plan review #9): a second signal DURING the drain delay
      // skips the rest of it, so close() starts now — ctrl-c twice in dev. It
      // never restarts the delay and never re-enters close(); after the delay
      // it is the plain no-op it always was.
      if (skipDelay) {
        try {
          logger.log({ msg: 'second signal — skipping drain delay', signal: signal ?? 'shutdown' });
        } catch {
          // A throwing logger must not stop the skip.
        }
        skipDelay();
      }
      return inFlight;
    }
    inFlight = run(signal);
    return inFlight;
  };
}

/**
 * A synchronous live count of the server's open sockets (#192, plan review #7),
 * for {@link ShutdownDeps.openConnections}. `server.getConnections()` delivers its
 * count in a callback, and the forced shutdown path must never wait on one.
 * Attach before `listen()` so no socket is missed.
 */
export function trackOpenConnections(server: {
  on(event: 'connection', listener: (socket: { once(event: 'close', l: () => void): unknown }) => void): unknown;
}): () => number {
  let open = 0;
  server.on('connection', (socket) => {
    open++;
    socket.once('close', () => {
      open--;
    });
  });
  return () => open;
}

/** Register the handler on every shutdown signal. Returns an unregister function
 *  so a test (or an embedder) can detach without leaking listeners. */
export function registerShutdownHandlers(
  handler: (signal?: string) => Promise<void>,
  proc: Pick<NodeJS.Process, 'on' | 'off'> = process,
): () => void {
  const listeners = SHUTDOWN_SIGNALS.map((signal) => {
    // `.catch()` rather than `void`: `void` discards the value but does NOT mark
    // the promise handled, so a rejection would still become an unhandledRejection
    // and kill the process mid-shutdown.
    const listener = (): void => {
      handler(signal).catch(() => undefined);
    };
    proc.on(signal, listener);
    return [signal, listener] as const;
  });
  return () => listeners.forEach(([signal, listener]) => proc.off(signal, listener));
}
