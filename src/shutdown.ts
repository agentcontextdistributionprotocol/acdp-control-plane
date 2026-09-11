import { Logger } from '@nestjs/common';

/** The signals we terminate on. SIGHUP is deliberately not handled: under a
 *  terminal it means "the terminal went away", and Node's default there is fine. */
export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/** Everything the handler touches, injected so the sequencing can be tested
 *  without spawning a process or standing up a real Nest application. */
export interface ShutdownDeps {
  /** Closes the Nest application — runs every `OnModuleDestroy` hook. */
  close: () => Promise<void>;
  /** Flushes OpenTelemetry. Started before Nest exists, so it is shut down
   *  outside the Nest lifecycle too. */
  stopTelemetry: () => Promise<void>;
  exit: (code: number) => void;
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
 *      tell a clean shutdown from a crash.
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal?: string) => Promise<void> {
  const logger = deps.logger ?? new Logger('Shutdown');
  let inFlight: Promise<void> | undefined;

  const run = async (signal?: string): Promise<void> => {
    logger.log(`received ${signal ?? 'shutdown'}, closing gracefully`);
    let failed = false;

    try {
      await deps.close();
    } catch (err) {
      failed = true;
      logger.error(
        `error closing the application: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }

    // Deliberately outside the catch above: telemetry must be flushed even when
    // the close failed. Its own failure must not mask the close result either.
    try {
      await deps.stopTelemetry();
    } catch (err) {
      failed = true;
      logger.error(
        `error stopping telemetry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    deps.exit(failed ? 1 : 0);
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
    const listener = (): void => void handler(signal);
    proc.on(signal, listener);
    return [signal, listener] as const;
  });
  return () => listeners.forEach(([signal, listener]) => proc.off(signal, listener));
}
