import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { assertAdmin } from '../auth/admin';
import { InstrumentationService } from '../telemetry/instrumentation.service';

/**
 * Prometheus exposition. Admin-only: the counters are tenant-free but still
 * operational intelligence (pool saturation, rejection reasons, audit and
 * witness verdict counts), so the route is NOT `@Public()`. `AuthGuard`
 * answers 401 without a valid key; `assertAdmin` answers 403 `ADMIN_REQUIRED`
 * for any principal that isn't an `AUTH_ADMIN_API_KEYS` key (JWT callers are
 * never admin). A scraper sends `Authorization: Bearer <admin key>`.
 */
@ApiExcludeController()
@Controller()
export class MetricsController {
  constructor(private readonly instrumentation: InstrumentationService) {}

  @Get('metrics')
  async getMetrics(
    @Req() req: Request & { actorIsAdmin?: boolean },
    @Res() res: Response,
  ): Promise<void> {
    assertAdmin(req, 'metrics are admin-only');
    const metrics = await this.instrumentation.getMetrics();
    res.set('Content-Type', this.instrumentation.getContentType());
    res.end(metrics);
  }
}
