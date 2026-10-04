import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../db/database.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { DrainState } from '../shutdown-drain';

@ApiTags('health')
@Controller()
@Public()
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfigService,
    private readonly drain: DrainState,
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
   * `closing`) the probe answers `503 SERVICE_DRAINING` WITHOUT querying the
   * database — the pool is about to end, and a load balancer only needs to know
   * to stop routing here. With `SHUTDOWN_DRAIN_DELAY_MS` set, this is the signal
   * that deregisters the replica while every other route keeps serving. The
   * drain gate deliberately has no readiness special case: in `closing` its
   * generic 503 covers this route too.
   *
   * The dependency check below runs only while serving. (`plans/readyz-db-down-fix.md`,
   * issue #210, rebases its non-200-on-DB-down rule onto THIS method, after the
   * drain check — never as a second readiness path.)
   */
  @Get('readyz')
  @ApiOperation({ summary: 'Readiness probe (shutdown drain, then Postgres connectivity).' })
  async readyz(@Res({ passthrough: true }) res: Response) {
    if (this.drain.isDraining()) {
      // Same envelope and Retry-After as the drain gate's 503 (but no Connection: close — see ASSUMPTIONS) (set before throwing; the filter
      // writes status + body onto this response and keeps them).
      res.setHeader('Retry-After', String(this.config.shutdownDrainRetryAfterSeconds));
      throw new AppException(
        ErrorCode.SERVICE_DRAINING,
        'This instance is shutting down and no longer ready; route to another replica.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    let dbOk = false;
    try {
      const result = await this.database.pool.query('SELECT 1 AS ok');
      dbOk = Boolean(result.rows[0]?.ok);
    } catch {
      dbOk = false;
    }
    return { ok: dbOk, database: dbOk ? 'ok' : 'unhealthy' };
  }
}
