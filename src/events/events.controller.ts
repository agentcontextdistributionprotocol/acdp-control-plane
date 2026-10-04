import {
  Controller,
  Get,
  MessageEvent,
  Query,
  Req,
  Sse,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { AppConfigService } from '../config/app-config.service';
import { ListEventsQueryDto } from '../dto/list-events-query.dto';
import { DrainState } from '../shutdown-drain';
import { ContextEventRepository } from '../storage/context-event.repository';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { tenantOf, TenantedRequest } from '../tenant/request-tenant';
import { createSseStream } from './sse-drain';
import { StreamHubService } from './stream-hub.service';

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(
    private readonly contextEventRepo: ContextEventRepository,
    private readonly streamHub: StreamHubService,
    private readonly config: AppConfigService,
    private readonly drain: DrainState,
    private readonly metrics: InstrumentationService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Cross-run event history with filters.' })
  async listEvents(
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: ListEventsQueryDto,
    @Req() req: TenantedRequest,
  ) {
    const limit = query.limit ?? 500;
    const result = await this.contextEventRepo.listFiltered({
      runId: query.runId,
      eventType: query.eventType,
      agentId: query.agentId,
      registryAuthority: query.registryAuthority,
      afterTs: query.afterTs,
      beforeTs: query.beforeTs,
      limit,
      tenantId: tenantOf(req),
    });
    // Keyset cursor: results are newest-first, so the oldest row's
    // timestamp is the cursor for the NEXT (older) page — pass it back as
    // `beforeTs`. Null when the page wasn't full (no more rows). Stable
    // under concurrent inserts, unlike offset pagination.
    const nextCursor =
      result.data.length === limit && result.data.length > 0
        ? result.data[result.data.length - 1].eventTs
        : null;
    return { ...result, limit, nextCursor };
  }

  @Sse('stream')
  @ApiOperation({
    summary: 'Global SSE feed — all events for the caller’s tenant, live.',
  })
  streamGlobal(@Req() req: TenantedRequest): Observable<MessageEvent> {
    const tenantId = tenantOf(req);
    // Hub feed + heartbeat + the #192 drain termination (`event: shutdown`).
    return createSseStream({
      source: () => this.streamHub.streamGlobal(tenantId),
      drain: this.drain,
      heartbeatMs: this.config.streamSseHeartbeatMs,
      retryMs: this.config.sseShutdownRetryMs,
      metrics: this.metrics,
    });
  }
}
