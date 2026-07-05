import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  MessageEvent,
  NotFoundException,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Sse,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { Public } from '../auth/public.decorator';
import { AppConfigService } from '../config/app-config.service';
import { ACDP_EVENT_CONTEXT_PUBLISHED, LineageDag } from '../contracts/acdp';
import { ListEventsQueryDto } from '../dto/list-events-query.dto';
import { ListRunsQueryDto } from '../dto/list-runs-query.dto';
import { RunCompleteDto } from '../dto/run-complete.dto';
import { RunStartedDto } from '../dto/run-started.dto';
import { StreamHubService } from '../events/stream-hub.service';
import { verifyWebhookSignature } from '../ingest/hmac';
import { CheckPolicy } from '../policy/check-policy.decorator';
import { ContextEventRepository } from '../storage/context-event.repository';
import { ContextLifecycleRepository } from '../storage/context-lifecycle.repository';
import { LineageEdgeRepository } from '../storage/lineage-edge.repository';
import {
  assertNotReservedTenant,
  tenantOf,
  TenantedRequest,
} from '../tenant/request-tenant';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';
import { RunsService } from './runs.service';

@ApiTags('runs')
@Controller('runs')
export class RunsController {
  constructor(
    private readonly runsService: RunsService,
    private readonly contextEventRepo: ContextEventRepository,
    private readonly lineageRepo: LineageEdgeRepository,
    private readonly lifecycleRepo: ContextLifecycleRepository,
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
  @ApiOperation({
    summary:
      'Fetch a single run. Includes a `trust` member (receipt-audit verdicts + discrepancy flags) once audit mode has examined the run; null otherwise.',
  })
  async getRun(@Param('runId') runId: string, @Req() req: TenantedRequest) {
    return this.runsService.getDetail(runId, tenantOf(req));
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
    const published = events.filter(
      (e) => e.eventType === ACDP_EVENT_CONTEXT_PUBLISHED,
    );
    // ACDP 0.3.0 (RFC-ACDP-0013): retraction is mark-not-delete — the node
    // stays in the DAG, flagged with its CURRENT lifecycle state.
    const retractedSet = await this.lifecycleRepo.retractedSetOf(
      published.map((e) => e.ctxId).filter((id): id is string => id !== null),
      tenantId,
    );
    const nodes = published.map((e, i) => ({
      ctxId: e.ctxId,
      agentId: e.agentId,
      contextType: e.contextType,
      visibility: e.visibility,
      registryAuthority: e.registryAuthority,
      step: i + 1,
      retracted: e.ctxId !== null && retractedSet.has(e.ctxId),
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

  @Post('started')
  @Public()
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Playground notifies that a run has started (records scenario attribution). Authenticated by HMAC-SHA256.',
  })
  async markStarted(
    @Req() req: RawBodyRequest<Request>,
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    body: RunStartedDto,
    @Headers('x-acdp-signature') signature?: string,
    @Headers('x-tenant-id') tenantHeader?: string,
  ): Promise<void> {
    this.verifyWebhookOrThrow(req, signature);
    await this.runsService.recordStart(
      body.run_id,
      body.scenario_id,
      body.started_at,
      body.inputs,
      this.tenantFromHeader(tenantHeader),
    );
  }

  @Post(':runId/complete')
  @Public()
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Playground notifies that the run is complete. Authenticated by HMAC-SHA256.',
  })
  async markComplete(
    @Req() req: RawBodyRequest<Request>,
    @Param('runId') runId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    body: RunCompleteDto,
    @Headers('x-acdp-signature') signature?: string,
    @Headers('x-tenant-id') tenantHeader?: string,
  ): Promise<void> {
    this.verifyWebhookOrThrow(req, signature);
    await this.runsService.markComplete(
      runId,
      body.status,
      body.result,
      this.tenantFromHeader(tenantHeader),
    );
  }

  // The playground authenticates run-notify calls the same way it signs
  // registry webhooks it forwards to /ingest/acdp: an HMAC-SHA256 of the raw
  // body in `X-ACDP-Signature`, with NO bearer token. These routes are
  // therefore `@Public()` (skipping the api-key AuthGuard) and verify the
  // shared WEBHOOK_SECRET here, mirroring IngestController.
  private verifyWebhookOrThrow(
    req: RawBodyRequest<Request>,
    signature?: string,
  ): void {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    if (!verifyWebhookSignature(raw, signature ?? '', this.config.webhookSecret)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
  }

  // Tenant attribution for HMAC-authenticated notifications: the playground
  // stamps `X-Tenant-Id` for tenant-bound scenarios; everything else lands in
  // the default bucket. `default` may never be asserted explicitly (reserved).
  private tenantFromHeader(tenantHeader?: string): string {
    const tenant = tenantHeader?.trim();
    if (!tenant) return DEFAULT_TENANT_ID;
    assertNotReservedTenant(tenant, 'X-Tenant-Id header');
    return tenant;
  }
}
