import { Controller, ForbiddenException, Get, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { BanditRouter } from './bandit-router.service';

@ApiTags('routing')
@Controller('routing')
export class RoutingController {
  constructor(private readonly bandit: BanditRouter) {}

  @Get('stats')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Bandit routing arm posteriors (admin-only). Each arm is Beta(alpha, beta) ' +
      'for a (taskClass, agentDid) pair; mean = alpha / (alpha + beta).',
  })
  stats(@Req() req: Request & { actorIsAdmin?: boolean }) {
    if (!req.actorIsAdmin) {
      throw new ForbiddenException('routing stats are admin-only');
    }
    const arms = this.bandit.snapshot().map((a) => ({
      taskClass: a.taskClass,
      agentDid: a.agentDid,
      alpha: a.alpha,
      beta: a.beta,
      mean: a.alpha / (a.alpha + a.beta),
      observations: a.alpha + a.beta - 2, // priors are Beta(1,1)
    }));
    return { arms, total: arms.length };
  }
}
