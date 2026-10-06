import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateWebhookDto, UpdateWebhookDto } from '../dto/webhook.dto';
import { tenantOf, TenantedRequest } from '../tenant/request-tenant';
import { WebhookService } from './webhook.service';

/**
 * The subscription's HMAC signing secret is write-only: it is supplied at
 * create/update and used for delivery, but never returned (#230) — any
 * principal in the tenant, including a read-only federated token, could
 * otherwise read it and forge CP-signed deliveries.
 */
export function toPublicWebhook<T extends { secret?: unknown }>(row: T): Omit<T, 'secret'>;
export function toPublicWebhook<T extends { secret?: unknown }>(row: T | null): Omit<T, 'secret'> | null;
export function toPublicWebhook<T extends { secret?: unknown }>(row: T | null): Omit<T, 'secret'> | null {
  if (row === null) return null;
  const { secret: _secret, ...rest } = row;
  return rest;
}

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post()
  @ApiOperation({ summary: 'Register a new outbound webhook subscription.' })
  @ApiBody({ type: CreateWebhookDto })
  async createWebhook(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    body: CreateWebhookDto,
    @Req() req: TenantedRequest,
  ) {
    return toPublicWebhook(
      await this.webhookService.register(
        {
          url: body.url,
          events: body.events ?? [],
          secret: body.secret,
        },
        tenantOf(req),
      ),
    );
  }

  @Get()
  @ApiOperation({ summary: 'List all outbound webhook subscriptions.' })
  async listWebhooks(@Req() req: TenantedRequest) {
    return (await this.webhookService.list(tenantOf(req))).map((w) => toPublicWebhook(w));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a webhook subscription.' })
  @ApiBody({ type: UpdateWebhookDto })
  async updateWebhook(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    body: UpdateWebhookDto,
    @Req() req: TenantedRequest,
  ) {
    return toPublicWebhook(await this.webhookService.update(id, body, tenantOf(req)));
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a webhook subscription.' })
  async deleteWebhook(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: TenantedRequest,
  ) {
    return this.webhookService.remove(id, tenantOf(req));
  }
}
