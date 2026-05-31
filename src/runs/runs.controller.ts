import {
  Body,
  Controller,
  Get,
  HttpCode,
  MessageEvent,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Sse,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { AppConfigService } from '../config/app-config.service';
import { LineageDag } from '../contracts/acdp';
import { ListEventsQueryDto } from '../dto/list-events-query.dto';
import { ListRunsQueryDto } from '../dto/list-runs-query.dto';
import { RunCompleteDto } from '../dto/run-complete.dto';
import { StreamHubService } from '../events/stream-hub.service';
import { CheckPolicy } from '../policy/check-policy.decorator';
import { ContextEventRepository } from '../storage/context-event.repository';
import { LineageEdgeRepository } from '../storage/lineage-edge.repository';
import { tenantOf, TenantedRequest } from '../tenant/request-tenant';
import { RunsService } from './runs.service';

@ApiTags('runs')
@Controller('runs')
export class RunsController {
  constructor(
    private readonly runsService: RunsService,
    private readonly contextEventRepo: ContextEventRepository,
    private readonly lineageRepo: LineageEdgeRepository,
    private readonly streamHub: StreamHubService,
    private readonly config: AppConfigService,
  ) {}

  @Get()
  @CheckPolicy('run.read')
  @ApiOperation({ summary: 'List runs with optional filtering and pagination.' })
  async listRuns(
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: ListRunsQueryDto,
    @Req() req: TenantedRequest,
  ) {
    return this.runsService.list({
      status: query.status,
      scenarioId: query.scenarioId,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
      tenantId: tenantOf(req),
    });
  }

  @Get(':runId')
  @CheckPolicy('run.read')
  @ApiOperation({ summary: 'Fetch a single run.' })
  async getRun(@Param('runId') runId: string, @Req() req: TenantedRequest) {
    return this.runsService.getOrThrow(runId, tenantOf(req));
  }

  @Get(':runId/lineage')
  @CheckPolicy('run.read')
  @ApiOperation({
    summary: 'DAG of contexts produced in this run (nodes + directed edges).',
  })
  async getLineage(
    @Param('runId') runId: string,
    @Req() req: TenantedRequest,
  ): Promise<LineageDag> {
    const tenantId = tenantOf(req);
    const [events, edges] = await Promise.all([
      this.contextEventRepo.listByRun(runId, tenantId),
      this.lineageRepo.listByRun(runId, tenantId),
    ]);
    const nodes = events
      .filter((e) => e.eventType === 'context_published')
      .map((e, i) => ({
        ctxId: e.ctxId,
        agentId: e.agentId,
        contextType: e.contextType,
        visibility: e.visibility,
        registryAuthority: e.registryAuthority,
        step: i + 1,
      }));
    return {
      runId,
      nodes,
      edges: edges.map((e) => ({ from: e.fromCtxId, to: e.toCtxId })),
    };
  }

  @Get(':runId/events')
  @CheckPolicy('run.read')
  @ApiOperation({ summary: 'List context events for a run.' })
  async getRunEvents(
    @Param('runId') runId: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: ListEventsQueryDto,
    @Req() req: TenantedRequest,
  ) {
    return this.contextEventRepo.listByRunFiltered({
      runId,
      eventType: query.eventType,
      limit: query.limit ?? 200,
      tenantId: tenantOf(req),
    });
  }

  @Sse(':runId/events/stream')
  @CheckPolicy('run.read')
  @ApiOperation({ summary: 'Live SSE stream of events for a run.' })
  async streamRunEvents(
    @Param('runId') runId: string,
    @Req() req: TenantedRequest,
  ): Promise<Observable<MessageEvent>> {
    const tenantId = tenantOf(req);
    // 404 if a leaked runId belongs to another tenant. We allow subscribing
    // to a not-yet-created run (a caller watching its own run before the
    // first event arrives); the per-run feed is itself tenant-scoped below,
    // so no cross-tenant events can ever reach this subscriber.
    if (await this.runsService.existsForOtherTenant(runId, tenantId)) {
      throw new NotFoundException(`run ${runId} not found`);
    }
    const heartbeatMs = this.config.streamSseHeartbeatMs;

    return new Observable<MessageEvent>((subscriber) => {
      const sub = this.streamHub.streamRun(runId, tenantId).subscribe({
        next: (event) =>
          subscriber.next({ type: event.type, data: event } as MessageEvent),
        error: (err) => subscriber.error(err),
        complete: () => subscriber.complete(),
      });

      const heartbeat = setInterval(() => {
        subscriber.next({
          type: 'heartbeat',
          data: { ts: new Date().toISOString() },
        } as MessageEvent);
      }, heartbeatMs);
      if (typeof heartbeat === 'object' && 'unref' in heartbeat) heartbeat.unref();

      return () => {
        clearInterval(heartbeat);
        sub.unsubscribe();
      };
    });
  }

  @Post(':runId/complete')
  @HttpCode(204)
  @CheckPolicy('run.start')
  @ApiOperation({ summary: 'Playground notifies that the run is complete.' })
  async markComplete(
    @Param('runId') runId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    body: RunCompleteDto,
    @Req() req: TenantedRequest,
  ): Promise<void> {
    await this.runsService.markComplete(runId, body.status, body.result, tenantOf(req));
  }
}
