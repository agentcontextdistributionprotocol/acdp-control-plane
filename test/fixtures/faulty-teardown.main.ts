/**
 * Test-only entrypoint for the shutdown exit-code contract (issue #155).
 *
 * It boots the real `AppModule` through the same `bootstrap()` wiring as
 * `src/main.ts`, and adds one provider that sabotages the real
 * `DatabaseService` teardown: `pool.end()` closes the pool, then rejects. The
 * failure therefore travels the production path, through
 * `DatabaseService.onModuleDestroy` and Nest's destroy-hook runner. Under
 * NestJS 12 that runner logs the rejection and does NOT reject `app.close()`,
 * which is the regression the `ShutdownFailures` collector closes.
 *
 * It lives under `test/` so production code carries no fault-injection knob.
 */
import '../../src/load-env';
import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { bootstrap, reportBootstrapFailure } from '../../src/bootstrap';
import { DatabaseService } from '../../src/db/database.service';

@Injectable()
class SabotagePoolEnd implements OnModuleInit {
  constructor(private readonly database: DatabaseService) {}

  onModuleInit(): void {
    const pool = this.database.pool;
    const realEnd = pool.end.bind(pool);
    (pool as { end: () => Promise<void> }).end = async () => {
      await realEnd();
      throw new Error('injected teardown failure (test fixture)');
    };
  }
}

@Module({ imports: [AppModule], providers: [SabotagePoolEnd] })
class FaultyTeardownModule {}

bootstrap(FaultyTeardownModule).catch(reportBootstrapFailure);
