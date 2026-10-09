import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Req,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EnrollRegistryDto } from '../dto/enroll-registry.dto';
import { assertAdmin } from '../auth/admin';
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
  private readonly logger = new Logger(RegistriesController.name);

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

  @Get('log-witness/alerts')
  @ApiOperation({
    summary:
      'Unacknowledged transparency-log witness alerts for this tenant (RFC-ACDP-0012). A durable, ' +
      'pollable worklist of dishonesty detections (root rewrite, split view, tree-size regression, ' +
      'log reset) — persisted on detection, so it survives a failed SSE/webhook fan-out. Pass ' +
      '?includeAcknowledged=true for the full set.',
  })
  async logWitnessAlerts(
    @Req() req: TenantedRequest,
    @Query('includeAcknowledged') includeAcknowledged?: string,
  ) {
    const tenantId = tenantOf(req);
    const include = includeAcknowledged === 'true' || includeAcknowledged === '1';
    const rows = await this.logWitnessRepo.listAlerted(tenantId, {
      includeAcknowledged: include,
    });
    const data = rows.map((c) => ({
      authority: c.registryAuthority,
      logId: c.logId,
      lastWitnessedSize: c.lastWitnessedSize,
      lastRootHash: c.lastRootHash,
      reason: c.lastAlertReason,
      detail: c.lastAlertDetail,
      at: c.lastAlertAt,
      acknowledgedAt: c.acknowledgedAt ?? null,
      acknowledgedBy: c.acknowledgedBy ?? null,
      consecutiveFailures: c.consecutiveFailures,
    }));
    return { data, total: data.length };
  }

  @Post(':authority/log-witness/ack')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Acknowledge an alerted registry (admin-only). Records who saw the alert and when, without ' +
      'touching the retained head — the alert still auto-clears only when the condition resolves. ' +
      'Acknowledged alerts drop off the default worklist.',
  })
  async acknowledgeLogWitnessAlert(
    @Param('authority') authority: string,
    @Req() req: TenantedRequest & { actorId?: string; actorIsAdmin?: boolean },
  ) {
    assertAdmin(req, 'acknowledging a witness alert is admin-only');
    const tenantId = tenantOf(req);
    const acknowledgedBy = req.actorId ?? 'admin';
    const row = await this.logWitnessRepo.acknowledgeAlert(tenantId, authority, acknowledgedBy);
    if (!row) {
      throw new AppException(
        ErrorCode.REGISTRY_NOT_FOUND,
        `no active witness alert for '${authority}' to acknowledge`,
        HttpStatus.NOT_FOUND,
      );
    }
    return {
      authority,
      alerted: row.alerted,
      reason: row.lastAlertReason,
      acknowledgedAt: row.acknowledgedAt,
      acknowledgedBy: row.acknowledgedBy,
    };
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
      'to a tenant and pins an optional per-registry webhook secret + base URL. ' +
      'The tenant binding is immutable: re-enrolling an authority already bound ' +
      'to a different tenant is rejected with 409 REGISTRY_ENROLLED_ELSEWHERE.',
  })
  async enroll(
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    body: EnrollRegistryDto,
    @Req() req: TenantedRequest & { actorIsAdmin?: boolean },
  ) {
    assertAdmin(req, 'registry enrollment is admin-only');
    // An admin may bind an enrollment to an explicit tenant, but `default` is
    // the reserved untenanted sentinel — it can never be named explicitly
    // (parity with the AuthGuard's reserved-tenant rejection).
    assertNotReservedTenant(body.tenantId, 'tenantId');
    const requestedTenant = body.tenantId ?? tenantOf(req);
    const row = await this.enrollmentRepo.upsert({
      authority: body.authority,
      tenantId: requestedTenant,
      baseUrl: body.baseUrl,
      registryDid: body.registryDid,
      webhookSecret: body.webhookSecret,
      enabled: body.enabled,
    });
    if (row === null) {
      // The authority is bound to ANOTHER tenant and the binding is immutable
      // (the upsert's conflict update was suppressed atomically; the row is
      // unchanged). Name the owning tenant only in the server-side log — the
      // response must not disclose which tenant holds the authority. This
      // read is separate from the write (not atomic); it is log-only.
      // A failing lookup must never mask the 409 with a 500.
      const existing = await this.enrollmentRepo
        .findByAuthority(body.authority)
        .catch(() => null);
      this.logger.warn({
        msg: 'registry enroll rejected: authority already enrolled under a different tenant',
        authority: body.authority,
        requestedTenant,
        owningTenant: existing?.tenantId ?? null,
      });
      throw new AppException(
        ErrorCode.REGISTRY_ENROLLED_ELSEWHERE,
        `authority "${body.authority}" is already enrolled under a different tenant`,
        HttpStatus.CONFLICT,
      );
    }
    const { webhookSecret: _omit, ...sanitized } = row;
    return sanitized;
  }
}
