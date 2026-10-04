/**
 * Test-only entrypoint for the drain-gate contract (issue #192, Phase 2).
 *
 * It boots the real `AppModule` through the same `bootstrap()` wiring as
 * `src/main.ts`, and wraps the real `StreamHubService.onModuleDestroy` so that,
 * AFTER the real hub teardown, it stalls for a FIXED {@link STALL_MS} (a plain
 * `setTimeout`, never load-dependent). Every destroy hook runs before Nest's
 * `dispose()` → `httpAdapter.close()` (`nest-application-context.js`
 * `runShutdownSequence`), so the HTTP listener is guaranteed to stay open — and
 * keep accepting connections — for the whole stall. That is the window in which
 * the drain gate is observable: without it the listener closes ~5 ms after
 * SIGTERM and every probe is simply refused.
 *
 * It lives under `test/` so production code carries no fault-injection knob.
 */
import '../../src/load-env';
import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { bootstrap, reportBootstrapFailure } from '../../src/bootstrap';
import { StreamHubService } from '../../src/events/stream-hub.service';

/** The fixed stall. The spec's +100 ms probes and +1000 ms body completion
 *  must fall well inside it. */
export const STALL_MS = 1500;

@Injectable()
class StallAfterHubTeardown implements OnModuleInit {
  constructor(private readonly moduleRef: ModuleRef) {}

  onModuleInit(): void {
    const hub = this.moduleRef.get(StreamHubService, { strict: false });
    const realDestroy = hub.onModuleDestroy.bind(hub);
    hub.onModuleDestroy = async () => {
      await realDestroy();
      await new Promise((resolve) => setTimeout(resolve, STALL_MS));
    };
  }
}

@Module({ imports: [AppModule], providers: [StallAfterHubTeardown] })
class SlowTeardownModule {}

bootstrap(SlowTeardownModule).catch(reportBootstrapFailure);
