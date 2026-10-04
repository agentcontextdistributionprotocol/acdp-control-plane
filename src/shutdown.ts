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
 *   1. **Idempotent** — a second signal while shutdown is in flight is ignored,
 *      rather than starting a second pass over the destroy hooks.
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

  const run = async (signal?: string): Promise<void> => {
    let failed = false;

    // Outside every try below, so it cannot itself reject the memoized promise.
    try {
      logger.log({ msg: 'received signal, closing gracefully', signal: signal ?? 'shutdown' });
    } catch {
      // A logger that throws must not abort the shutdown it is narrating.
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

    if (timedOut) {
      failed = true;
      logger.error({
        msg:
          'graceful close timed out — forcing shutdown. In-flight ' +
          'requests are being dropped; a hung close usually means an open ' +
          'connection (SSE, keep-alive) or a destroy hook that never settles.',
        timeoutMs,
      });
      try {
        deps.forceCloseConnections?.();
      } catch {
        // Best effort: we are already on the forced path.
      }
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
    inFlight ??= run(signal);
    return inFlight;
  };
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
