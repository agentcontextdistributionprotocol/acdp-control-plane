import { Global, Injectable, Logger, Module } from '@nestjs/common';

/** One teardown step that failed during `app.close()`. */
export interface ShutdownFailure {
  readonly name: string;
  readonly error: unknown;
}

/**
 * Collects destroy-hook failures so the process exit code can report them.
 *
 * WHY THIS EXISTS (issue #155). In NestJS 12, `app.close()` runs each hierarchy
 * level's `onModuleDestroy` hooks under `Promise.allSettled` and passes any
 * rejection to `Logger.error`. The module-class hook is handled the same way,
 * inside a try/catch. So a failing teardown, such as `pool.end()` throwing,
 * no longer rejects `close()`. Before this collector, `createShutdownHandler`
 * learned of a failure only from that rejection, so a broken shutdown on
 * Nest 12 exited 0. Under Nest 11 it exited 1. An orchestrator could no longer
 * tell a broken shutdown from a clean one.
 *
 * Each destroy hook that releases an EXTERNAL resource (a pg pool, a Redis
 * client, a durable write queue) runs its teardown through {@link track}.
 * `track` records the failure here and rethrows it, so Nest's own logging, and
 * a `close()` rejection on frameworks that still propagate one, are unchanged.
 * `main.ts` reads {@link any} after `close()` settles. Hooks that only clear
 * in-process timers or caches are not tracked: they cannot fail in a way an
 * operator needs to see in the exit code.
 *
 * The instance has no lifecycle hooks of its own, so Nest's teardown never
 * touches it. It stays readable after `close()` has resolved.
 */
@Injectable()
export class ShutdownFailures {
  private readonly logger = new Logger(ShutdownFailures.name);
  private readonly failures: ShutdownFailure[] = [];

  record(name: string, error: unknown): void {
    this.failures.push({ name, error });
    try {
      this.logger.error({
        msg: `shutdown step failed: ${name}`,
        step: name,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Recording must never fail because the logger did.
    }
  }

  /** Run one teardown step. A throw or rejection is recorded, then rethrown. */
  async track(name: string, step: () => unknown): Promise<void> {
    try {
      await step();
    } catch (err) {
      this.record(name, err);
      throw err;
    }
  }

  any(): boolean {
    return this.failures.length > 0;
  }

  list(): readonly ShutdownFailure[] {
    return this.failures;
  }
}

/** Global so every resource-owning provider can inject the collector without
 *  each feature module having to import it. */
@Global()
@Module({
  providers: [ShutdownFailures],
  exports: [ShutdownFailures],
})
export class ShutdownFailuresModule {}
