import { ForbiddenException } from '@nestjs/common';
import { RegistriesController } from './registries.controller';
import { TenantedRequest } from '../tenant/request-tenant';

describe('RegistriesController.enroll', () => {
  const enrollmentRepo = { upsert: jest.fn(), list: jest.fn() };
  const registryRepo = { list: jest.fn() };
  const logWitnessRepo = { getCursor: jest.fn(), latestForAuthority: jest.fn() };
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

  function req(over: Partial<TenantedRequest & { actorIsAdmin?: boolean }> = {}) {
    return { tenantId: 'tenant-a', actorIsAdmin: true, ...over } as TenantedRequest & {
      actorIsAdmin?: boolean;
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
});
