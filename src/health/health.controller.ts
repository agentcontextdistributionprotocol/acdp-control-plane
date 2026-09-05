import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../db/database.service';

@ApiTags('health')
@Controller()
@Public()
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfigService,
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

  @Get('readyz')
  @ApiOperation({ summary: 'Readiness probe (Postgres connectivity).' })
  async readyz() {
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
