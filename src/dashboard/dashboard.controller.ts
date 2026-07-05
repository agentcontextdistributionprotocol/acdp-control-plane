import { Controller, Get, Query, Req, ValidationPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DashboardOverviewQueryDto } from '../dto/dashboard-overview.dto';
import { tenantOf, TenantedRequest } from '../tenant/request-tenant';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  @ApiOperation({
    summary:
      'KPIs and chart data: totalRuns, totalContexts, totalRetracted, totalContextsLive, totalAgents, recentRuns, byScenario, byRegistry.',
  })
  async getOverview(
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: DashboardOverviewQueryDto,
    @Req() req: TenantedRequest,
  ) {
    return this.dashboardService.getOverview({
      window: query.window ?? '24h',
      tenantId: tenantOf(req),
    });
  }
}
