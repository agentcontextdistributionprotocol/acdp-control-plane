import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';
import { QUOTA_ACTION_KEY } from './check-quota.decorator';
import { QuotaGuard } from './quota.guard';
import { parseQuotaConfig } from './quota-config';
import { InMemoryQuotaStore } from './quota-store';
import { QUOTA_CONFIG, QUOTA_STORE, QuotaService } from './quota.service';

// Enforcement itself (limits, fail-open, 429 body) is covered by
// quota.service.spec.ts; this spec pins only the wrapper.

function ctx(req: any, response: unknown = { setHeader: jest.fn() }): ExecutionContext {
  const handler = function fakeHandler() {};
  class FakeClass {}
  return {
    getHandler: jest.fn().mockReturnValue(handler),
    getClass: jest.fn().mockReturnValue(FakeClass),
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: jest.fn().mockReturnValue(response),
      getNext: jest.fn(),
    }),
    getArgs: jest.fn(),
    getArgByIndex: jest.fn(),
    switchToRpc: jest.fn(),
    switchToWs: jest.fn(),
    getType: jest.fn(),
  } as unknown as ExecutionContext;
}

function newReflector(action?: string): Reflector {
  const r: any = new Reflector();
  jest
    .spyOn(r, 'getAllAndOverride')
    .mockImplementation((...args: unknown[]) =>
      args[0] === QUOTA_ACTION_KEY ? action : undefined,
    );
  return r as Reflector;
}

function mockService(impl?: () => Promise<void>): QuotaService & { enforce: jest.Mock } {
  return { enforce: jest.fn(impl ?? (async () => undefined)) } as unknown as QuotaService & {
    enforce: jest.Mock;
  };
}

describe('QuotaGuard', () => {
  it('passes through handlers without @CheckQuota() and never calls the service', async () => {
    const svc = mockService();
    const g = new QuotaGuard(newReflector(undefined), svc);
    expect(await g.canActivate(ctx({ tenantId: 'tenant-a' }))).toBe(true);
    expect(svc.enforce).not.toHaveBeenCalled();
  });

  it('passes through when no QuotaService is registered', async () => {
    const g = new QuotaGuard(newReflector('publish'));
    expect(await g.canActivate(ctx({ tenantId: 'tenant-a' }))).toBe(true);
  });

  it('forwards the pinned tenant, the action and req.res', async () => {
    const svc = mockService();
    const g = new QuotaGuard(newReflector('publish'), svc);
    const res = { setHeader: jest.fn() };
    expect(await g.canActivate(ctx({ tenantId: 'tenant-a', res }))).toBe(true);
    expect(svc.enforce).toHaveBeenCalledWith('tenant-a', 'publish', res);
  });

  it('falls back to the context response when req.res is absent', async () => {
    const svc = mockService();
    const g = new QuotaGuard(newReflector('publish'), svc);
    const response = { setHeader: jest.fn() };
    await g.canActivate(ctx({ tenantId: 'tenant-a' }, response));
    expect(svc.enforce).toHaveBeenCalledWith('tenant-a', 'publish', response);
  });

  it.each([undefined, '', 42])(
    'meters under DEFAULT_TENANT_ID when req.tenantId is %p',
    async (tenantId) => {
      const svc = mockService();
      const g = new QuotaGuard(newReflector('run.start'), svc);
      await g.canActivate(ctx({ tenantId }));
      expect(svc.enforce).toHaveBeenCalledWith(
        DEFAULT_TENANT_ID,
        'run.start',
        expect.anything(),
      );
    },
  );

  it('propagates a service rejection (429) unchanged', async () => {
    const err = new HttpException({ message: 'quota exceeded' }, HttpStatus.TOO_MANY_REQUESTS);
    const svc = mockService(async () => {
      throw err;
    });
    const g = new QuotaGuard(newReflector('publish'), svc);
    await expect(g.canActivate(ctx({ tenantId: 'tenant-a' }))).rejects.toBe(err);
  });

  // Regression guard: the @Optional() service param is typed `| null`, which
  // serializes as `Object` in design:paramtypes — without the explicit
  // @Inject(QuotaService) Nest silently injects nothing and quotas vanish.
  it('receives QuotaService through Nest DI (not silently null)', async () => {
    const mod = await Test.createTestingModule({
      providers: [
        Reflector,
        QuotaService,
        QuotaGuard,
        { provide: QUOTA_CONFIG, useValue: parseQuotaConfig('tenant-a:publish=1/min') },
        { provide: QUOTA_STORE, useValue: new InMemoryQuotaStore() },
      ],
    }).compile();
    const reflector = mod.get(Reflector);
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key: unknown) => (key === QUOTA_ACTION_KEY ? 'publish' : undefined));
    const g = mod.get(QuotaGuard);
    expect(await g.canActivate(ctx({ tenantId: 'tenant-a' }))).toBe(true);
    await expect(g.canActivate(ctx({ tenantId: 'tenant-a' }))).rejects.toThrow(HttpException);
  });
});
