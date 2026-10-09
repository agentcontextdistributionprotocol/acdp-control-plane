import { Logger } from '@nestjs/common';
import { ErrorCode } from '../errors/error-codes';
import { AppException } from '../errors/app-exception';
import { RegistriesController } from './registries.controller';
import { TenantedRequest } from '../tenant/request-tenant';

describe('RegistriesController.enroll', () => {
  const enrollmentRepo = { upsert: jest.fn(), list: jest.fn(), findByAuthority: jest.fn() };
  const registryRepo = { list: jest.fn() };
  const logWitnessRepo = {
    getCursor: jest.fn(),
    latestForAuthority: jest.fn(),
    listAlerted: jest.fn(),
    acknowledgeAlert: jest.fn(),
  };
  let controller: RegistriesController;

  beforeEach(() => {
    jest.clearAllMocks();
    enrollmentRepo.upsert.mockResolvedValue({
      authority: 'reg.example',
      tenantId: 'tenant-a',
      webhookSecret: 'shh',
    });
    controller = new RegistriesController(
      registryRepo as never,
      enrollmentRepo as never,
      logWitnessRepo as never,
    );
  });

  function req(over: Partial<TenantedRequest & { actorIsAdmin?: boolean; actorId?: string }> = {}) {
    return { tenantId: 'tenant-a', actorIsAdmin: true, ...over } as TenantedRequest & {
      actorIsAdmin?: boolean;
      actorId?: string;
    };
  }

  it('rejects a non-admin caller', async () => {
    await expect(
      controller.enroll({ authority: 'reg.example' } as never, req({ actorIsAdmin: false })),
    ).rejects.toMatchObject({ errorCode: ErrorCode.ADMIN_REQUIRED, status: 403 });
    expect(enrollmentRepo.upsert).not.toHaveBeenCalled();
  });

  it('rejects an explicit assertion of the reserved `default` tenant', async () => {
    await expect(
      controller.enroll(
        { authority: 'reg.example', tenantId: 'default' } as never,
        req(),
      ),
    ).rejects.toMatchObject({ errorCode: ErrorCode.TENANT_RESERVED, status: 403 });
    expect(enrollmentRepo.upsert).not.toHaveBeenCalled();
  });

  it('enrolls when the admin omits tenantId (falls back to the caller tenant)', async () => {
    await controller.enroll({ authority: 'reg.example' } as never, req());
    expect(enrollmentRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ authority: 'reg.example', tenantId: 'tenant-a' }),
    );
  });

  it('never echoes the webhook secret back', async () => {
    const out = await controller.enroll(
      { authority: 'reg.example', tenantId: 'tenant-a' } as never,
      req(),
    );
    expect(out).not.toHaveProperty('webhookSecret');
  });

  it('returns the enrollment when the upsert succeeds (insert / same-tenant update)', async () => {
    const out = await controller.enroll(
      { authority: 'reg.example', tenantId: 'tenant-a' } as never,
      req(),
    );
    expect(out).toEqual({ authority: 'reg.example', tenantId: 'tenant-a' });
    expect(enrollmentRepo.findByAuthority).not.toHaveBeenCalled();
  });

  // ── PATCH-like re-enroll (tenant-enroll-quota-fix P2) ──────────────────
  describe('undefined vs null pass-through', () => {
    it('passes omitted fields as undefined (repo keeps stored values)', async () => {
      await controller.enroll({ authority: 'reg.example' } as never, req());
      const input = enrollmentRepo.upsert.mock.calls[0][0] as Record<string, unknown>;
      expect(input.baseUrl).toBeUndefined();
      expect(input.registryDid).toBeUndefined();
      expect(input.webhookSecret).toBeUndefined();
      expect(input.enabled).toBeUndefined();
    });

    it('passes explicit nulls for the nullable fields through as null', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await controller.enroll(
        { authority: 'reg.example', baseUrl: null, registryDid: null, webhookSecret: null } as never,
        req(),
      );
      expect(enrollmentRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: null, registryDid: null, webhookSecret: null }),
      );
      warn.mockRestore();
    });

    it('normalises enabled:null to omitted (never forwards NULL for the NOT NULL column)', async () => {
      await controller.enroll({ authority: 'reg.example', enabled: null } as never, req());
      const input = enrollmentRepo.upsert.mock.calls[0][0] as Record<string, unknown>;
      expect(input.enabled).toBeUndefined();
    });

    it('forwards enabled:false', async () => {
      await controller.enroll({ authority: 'reg.example', enabled: false } as never, req());
      expect(enrollmentRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );
    });

    it('warns (structured, no secret) when webhookSecret is explicitly cleared', async () => {
      enrollmentRepo.upsert.mockResolvedValue({
        authority: 'reg.example',
        tenantId: 'tenant-a',
        webhookSecret: null,
      });
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const out = await controller.enroll(
        { authority: 'reg.example', webhookSecret: null } as never,
        req(),
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: expect.stringContaining('WEBHOOK_SECRET'),
          authority: 'reg.example',
          tenantId: 'tenant-a',
        }),
      );
      expect(warn.mock.calls[0][0]).not.toHaveProperty('webhookSecret');
      expect(out).not.toHaveProperty('webhookSecret');
      warn.mockRestore();
    });

    it('does not warn when webhookSecret is omitted or set', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await controller.enroll({ authority: 'reg.example' } as never, req());
      await controller.enroll(
        { authority: 'reg.example', webhookSecret: 'a-sixteen-char-secret' } as never,
        req(),
      );
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('authority already enrolled under a different tenant', () => {
    let warn: jest.SpyInstance;

    beforeEach(() => {
      enrollmentRepo.upsert.mockResolvedValue(null);
      enrollmentRepo.findByAuthority.mockResolvedValue({
        authority: 'reg.example',
        tenantId: 'owner-tenant-secret',
      });
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => warn.mockRestore());

    it('throws 409 REGISTRY_ENROLLED_ELSEWHERE without leaking the owning tenant', async () => {
      let caught: unknown;
      try {
        await controller.enroll(
          { authority: 'reg.example', tenantId: 'tenant-b' } as never,
          req({ tenantId: 'tenant-b' }),
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AppException);
      const err = caught as AppException;
      expect(err.errorCode).toBe(ErrorCode.REGISTRY_ENROLLED_ELSEWHERE);
      expect(err.getStatus()).toBe(409);
      expect(err.message).toBe(
        'authority "reg.example" is already enrolled under a different tenant',
      );
      // Nothing the client sees names the owning tenant.
      expect(JSON.stringify(err.getResponse())).not.toContain('owner-tenant-secret');
      expect(JSON.stringify(err)).not.toContain('owner-tenant-secret');
    });

    it('logs the owning tenant server-side as structured fields', async () => {
      await expect(
        controller.enroll({ authority: 'reg.example' } as never, req({ tenantId: 'tenant-b' })),
      ).rejects.toMatchObject({ errorCode: ErrorCode.REGISTRY_ENROLLED_ELSEWHERE });
      expect(enrollmentRepo.findByAuthority).toHaveBeenCalledWith('reg.example');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: expect.any(String),
          authority: 'reg.example',
          requestedTenant: 'tenant-b',
          owningTenant: 'owner-tenant-secret',
        }),
      );
    });
  });

  describe('enroll — log lookup failure', () => {
    it('still returns the 409 (owningTenant null) when the log-only read throws', async () => {
      enrollmentRepo.upsert.mockResolvedValue(null);
      enrollmentRepo.findByAuthority.mockRejectedValue(new Error('db blip'));
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await expect(
        controller.enroll({ authority: 'reg.example' } as never, req({ tenantId: 'tenant-b' })),
      ).rejects.toMatchObject({ errorCode: ErrorCode.REGISTRY_ENROLLED_ELSEWHERE });
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ owningTenant: null }));
      warn.mockRestore();
    });
  });

  // ── Witness alert worklist + acknowledgement (durability hardening) ──────

  it('lists only UNACKNOWLEDGED witness alerts by default', async () => {
    logWitnessRepo.listAlerted.mockResolvedValue([
      {
        registryAuthority: 'reg.example',
        logId: 'did:web:reg.example/log/1',
        lastWitnessedSize: 5,
        lastRootHash: 'sha256:aa',
        lastAlertReason: 'consistency_failed',
        lastAlertDetail: { error: 'rewrite' },
        lastAlertAt: '2026-07-06T00:00:00.000Z',
        acknowledgedAt: null,
        acknowledgedBy: null,
        consecutiveFailures: 0,
      },
    ]);
    const out = await controller.logWitnessAlerts(req());
    expect(logWitnessRepo.listAlerted).toHaveBeenCalledWith('tenant-a', {
      includeAcknowledged: false,
    });
    expect(out.total).toBe(1);
    expect(out.data[0]).toMatchObject({
      authority: 'reg.example',
      reason: 'consistency_failed',
      acknowledgedAt: null,
    });
  });

  it('includes acknowledged alerts when asked', async () => {
    logWitnessRepo.listAlerted.mockResolvedValue([]);
    await controller.logWitnessAlerts(req(), 'true');
    expect(logWitnessRepo.listAlerted).toHaveBeenCalledWith('tenant-a', {
      includeAcknowledged: true,
    });
  });

  it('rejects a non-admin acknowledging an alert', async () => {
    await expect(
      controller.acknowledgeLogWitnessAlert('reg.example', req({ actorIsAdmin: false })),
    ).rejects.toMatchObject({ errorCode: ErrorCode.ADMIN_REQUIRED, status: 403 });
    expect(logWitnessRepo.acknowledgeAlert).not.toHaveBeenCalled();
  });

  it('acknowledges an active alert (admin) and records the actor', async () => {
    logWitnessRepo.acknowledgeAlert.mockResolvedValue({
      alerted: true,
      lastAlertReason: 'root_mismatch',
      acknowledgedAt: '2026-07-06T01:00:00.000Z',
      acknowledgedBy: 'op-1',
    });
    const out = await controller.acknowledgeLogWitnessAlert(
      'reg.example',
      req({ actorId: 'op-1' }) as never,
    );
    expect(logWitnessRepo.acknowledgeAlert).toHaveBeenCalledWith('tenant-a', 'reg.example', 'op-1');
    expect(out).toMatchObject({ authority: 'reg.example', acknowledgedBy: 'op-1' });
  });

  it('404s when acknowledging an authority with no active alert', async () => {
    logWitnessRepo.acknowledgeAlert.mockResolvedValue(null);
    await expect(
      controller.acknowledgeLogWitnessAlert('reg.example', req()),
    ).rejects.toBeInstanceOf(AppException);
  });
});
