import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../db/database.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { DrainState } from '../shutdown-drain';
import { ReadinessService } from './readiness.service';

/**
 * Probe-only controller. `@Public()` (no auth) at CLASS level. `@SkipThrottle()`
 * (no per-IP rate limit, issue #210) is applied to `/readyz` ONLY for now: a
 * probe from a load-balancer fleet or a shared-NAT monitor must never read as
 * "unready" because it was 429'd, and `/readyz` is safe to unthrottle because
 * it goes through `ReadinessService` (cache + single-flight: at most one DB
 * query per `READINESS_CACHE_MS`). `/healthz` still runs an uncached query per
 * request until #210 Phase 2 makes it pure liveness, so it stays throttled.
 * Do NOT unthrottle a route here whose cost is not bounded the same way.
 */
@ApiTags('health')
@Controller()
@Public()
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfigService,
    private readonly drain: DrainState,
    private readonly readiness: ReadinessService,
  ) {}

  @Get('healthz')
  @ApiOperation({ summary: 'Liveness probe.' })
  async healthz() {
    let dbOk = true;
    try {
      await this.database.pool.query('SELECT 1');
    } catch {
      dbOk = false;
    }
    const ok = dbOk && !this.database.hasFatalError;
    return { ok, service: 'acdp-control-plane', version: this.config.clientVersion };
  }

  /**
   * Readiness = `!draining && deps ok`, evaluated DRAIN-FIRST, in this one code
   * path (issue #192 Phase 3; `plans/graceful-drain-192.md` plan review #8).
   *
   * Once a shutdown signal has arrived (`DrainState` phase `draining` or
   * `closing`) the probe answers `503 SERVICE_DRAINING` WITHOUT consulting
   * readiness — no cache lookup, no DB query: the pool is about to end, a cached
   * `ready` must never mask a drain, and a load balancer only needs to know to
   * stop routing here. With `SHUTDOWN_DRAIN_DELAY_MS` set, this is the signal
   * that deregisters the replica while every other route keeps serving. The
   * drain gate deliberately has no readiness special case: in `closing` its
   * generic 503 covers this route too.
   *
   * While serving, `ReadinessService` decides (issue #210): 200
   * `{ ok, database, checks }`, or 503 `DEPENDENCY_UNAVAILABLE` in the standard
   * error envelope with the legacy `ok:false` / `database:"unhealthy"` keys in
   * `error.details` — never the driver's error text. Both arms (and the drain
   * arm) are `Cache-Control: no-store` (registry #205 parity). No `Retry-After`
   * on the dependency arm: a DB outage has no known duration.
   */
  @SkipThrottle()
  @Get('readyz')
  @ApiOperation({
    summary: 'Readiness probe (shutdown drain, then Postgres): 200 when ready, 503 when not.',
  })
  async readyz(@Res({ passthrough: true }) res: Response) {
    // Set before anything can throw: the filter writes status + body onto this
    // response and keeps the headers already on it.
    res.setHeader('Cache-Control', 'no-store');
    if (this.drain.isDraining()) {
      // Same envelope and Retry-After as the drain gate's 503 (but no Connection: close — see ASSUMPTIONS).
      res.setHeader('Retry-After', String(this.config.shutdownDrainRetryAfterSeconds));
      throw new AppException(
        ErrorCode.SERVICE_DRAINING,
        'This instance is shutting down and no longer ready; route to another replica.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const verdict = await this.readiness.evaluate();
    if (!verdict.ready) {
      throw new AppException(
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        'Not ready: database unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
        { ok: false, database: 'unhealthy', checks: verdict.checks },
      );
    }
    return { ok: true, database: 'ok', checks: verdict.checks };
  }
}
