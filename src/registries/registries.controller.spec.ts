import { ForbiddenException } from '@nestjs/common';
import { AppException } from '../errors/app-exception';
import { RegistriesController } from './registries.controller';
import { TenantedRequest } from '../tenant/request-tenant';

describe('RegistriesController.enroll', () => {
  const enrollmentRepo = { upsert: jest.fn(), list: jest.fn() };
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
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(enrollmentRepo.upsert).not.toHaveBeenCalled();
  });

  it('rejects an explicit assertion of the reserved `default` tenant', async () => {
    await expect(
      controller.enroll(
        { authority: 'reg.example', tenantId: 'default' } as never,
        req(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
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
    ).rejects.toBeInstanceOf(ForbiddenException);
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
