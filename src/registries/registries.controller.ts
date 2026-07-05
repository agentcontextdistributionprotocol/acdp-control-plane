import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
  Param,
  Post,
  Req,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EnrollRegistryDto } from '../dto/enroll-registry.dto';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { LogWitnessRepository } from '../storage/log-witness.repository';
import { RegistryEnrollmentRepository } from '../storage/registry-enrollment.repository';
import { RegistryRepository } from '../storage/registry.repository';
import {
  assertNotReservedTenant,
  tenantOf,
  TenantedRequest,
} from '../tenant/request-tenant';

@ApiTags('registries')
@Controller('registries')
export class RegistriesController {
  constructor(
    private readonly registryRepo: RegistryRepository,
    private readonly enrollmentRepo: RegistryEnrollmentRepository,
    private readonly logWitnessRepo: LogWitnessRepository,
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

  @Get(':authority/log-witness')
  @ApiOperation({
    summary:
      'Transparency-log witness state for a registry (RFC-ACDP-0012): the ' +
      'latest witnessed checkpoints (signed tree heads, retained as evidence) ' +
      'plus the cursor/alert state — root rewrites, split views, tree-size ' +
      'regressions, and log resets surface here.',
  })
  async logWitness(@Param('authority') authority: string, @Req() req: TenantedRequest) {
    const tenantId = tenantOf(req);
    const [cursor, checkpoints] = await Promise.all([
      this.logWitnessRepo.getCursor(tenantId, authority),
      this.logWitnessRepo.latestForAuthority(tenantId, authority, 20),
    ]);
    if (!cursor && checkpoints.length === 0) {
      throw new AppException(
        ErrorCode.REGISTRY_NOT_FOUND,
        `no transparency-log witness state for '${authority}'`,
        HttpStatus.NOT_FOUND,
      );
    }
    return {
      authority,
      logId: cursor?.logId ?? null,
      lastWitnessedSize: cursor?.lastWitnessedSize ?? null,
      lastRootHash: cursor?.lastRootHash ?? null,
      lastSuccessAt: cursor?.lastSuccessAt ?? null,
      consecutiveFailures: cursor?.consecutiveFailures ?? 0,
      alert: {
        alerted: cursor?.alerted ?? false,
        reason: cursor?.lastAlertReason ?? null,
        detail: cursor?.lastAlertDetail ?? null,
        at: cursor?.lastAlertAt ?? null,
      },
      checkpoints,
      total: checkpoints.length,
    };
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
    // An admin may bind an enrollment to an explicit tenant, but `default` is
    // the reserved untenanted sentinel — it can never be named explicitly
    // (parity with the AuthGuard's reserved-tenant rejection).
    assertNotReservedTenant(body.tenantId, 'tenantId');
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
