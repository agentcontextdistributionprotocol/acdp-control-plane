import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Req,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EnrollRegistryDto } from '../dto/enroll-registry.dto';
import { RegistryEnrollmentRepository } from '../storage/registry-enrollment.repository';
import { RegistryRepository } from '../storage/registry.repository';
import { tenantOf, TenantedRequest } from '../tenant/request-tenant';

@ApiTags('registries')
@Controller('registries')
export class RegistriesController {
  constructor(
    private readonly registryRepo: RegistryRepository,
    private readonly enrollmentRepo: RegistryEnrollmentRepository,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List known registries (this tenant) with event counts.' })
  async listRegistries(@Req() req: TenantedRequest) {
    const data = await this.registryRepo.list(tenantOf(req));
    return { data, total: data.length };
  }

  @Get('enrollments')
  @ApiOperation({ summary: 'List registry enrollments for this tenant.' })
  async listEnrollments(@Req() req: TenantedRequest) {
    const data = await this.enrollmentRepo.list(tenantOf(req));
    // Never echo secrets back.
    const sanitized = data.map(({ webhookSecret: _omit, ...rest }) => rest);
    return { data: sanitized, total: sanitized.length };
  }

  @Post('enroll')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Enroll (or update) a registry authority. Admin-only. Binds the authority ' +
      'to a tenant and pins an optional per-registry webhook secret + base URL.',
  })
  async enroll(
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    body: EnrollRegistryDto,
    @Req() req: TenantedRequest & { actorIsAdmin?: boolean },
  ) {
    if (!req.actorIsAdmin) {
      throw new ForbiddenException('registry enrollment is admin-only');
    }
    const row = await this.enrollmentRepo.upsert({
      authority: body.authority,
      tenantId: body.tenantId ?? tenantOf(req),
      baseUrl: body.baseUrl,
      registryDid: body.registryDid,
      webhookSecret: body.webhookSecret,
      enabled: body.enabled,
    });
    const { webhookSecret: _omit, ...sanitized } = row;
    return sanitized;
  }
}
