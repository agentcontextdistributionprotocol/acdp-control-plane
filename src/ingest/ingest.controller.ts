import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { CheckQuota } from '../quota/check-quota.decorator';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';
import { IngestService } from './ingest.service';

@ApiTags('ingest')
@Controller('ingest')
export class IngestController {
  constructor(private readonly ingestService: IngestService) {}

  @Post('acdp')
  @HttpCode(204)
  @Public()
  @CheckQuota('publish')
  @ApiOperation({
    summary: 'Receive an ACDP webhook event from a registry. Authenticated by HMAC-SHA256.',
  })
  async receiveWebhook(
    @Req() req: RawBodyRequest<Request> & { tenantId?: string },
    @Headers('x-acdp-signature') signature: string,
    @Headers('x-run-id') runId?: string,
    @Headers('x-tenant-id') tenantIdHeader?: string,
    @Headers('origin') origin?: string,
    @Headers('x-acdp-event-id') eventId?: string,
  ): Promise<void> {
    const body = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    // Tenant resolution priority: AuthGuard-pinned (when the endpoint
    // isn't @Public) → X-Tenant-Id header (upstream registry tags) →
    // DEFAULT_TENANT_ID. This endpoint IS @Public so AuthGuard
    // doesn't set tenantId; the header is the production path.
    const tenantId =
      req.tenantId || tenantIdHeader?.trim() || DEFAULT_TENANT_ID;
    // Origin is a fallback source for the registry's base URL when the
    // payload omits registry_base_url — lets the federation proxy reach it.
    // X-ACDP-Event-Id (REG-P2-6) is the registry's retry-stable dedup id.
    await this.ingestService.handle(
      body,
      signature,
      runId,
      tenantId,
      origin?.trim(),
      eventId?.trim(),
    );
  }

  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Liveness check for registry configuration tests.' })
  health() {
    return { ok: true };
  }
}
