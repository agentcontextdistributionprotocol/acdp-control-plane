import { Controller, Get, NotFoundException, Param, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AgentRepository } from '../storage/agent.repository';
import { tenantOf, TenantedRequest } from '../tenant/request-tenant';

@ApiTags('agents')
@Controller('agents')
export class AgentsController {
  constructor(private readonly agentRepo: AgentRepository) {}

  @Get()
  @ApiOperation({ summary: 'List known agents (observed DIDs) for this tenant.' })
  async listAgents(@Req() req: TenantedRequest) {
    const agents = await this.agentRepo.list(200, tenantOf(req));
    return { data: agents, total: agents.length };
  }

  // `*did` catches the full DID path. NestJS 11 / path-to-regexp v6+ uses
  // this syntax in place of the older `:did(.*)` regex form.
  @Get('*did')
  @ApiOperation({ summary: 'Agent detail + context count.' })
  async getAgent(
    @Param('did') didParts: string[] | string,
    @Req() req: TenantedRequest,
  ) {
    const did = Array.isArray(didParts) ? didParts.join('/') : didParts;
    const agent = await this.agentRepo.findByDid(did, tenantOf(req));
    if (!agent) throw new NotFoundException(`agent ${did} not found`);
    return agent;
  }
}
