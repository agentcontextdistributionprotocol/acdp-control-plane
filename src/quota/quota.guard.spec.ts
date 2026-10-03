 
import { ExecutionContext, HttpException } from '@nestjs/common';
import { ErrorCode } from '../errors/error-codes';
import { Reflector } from '@nestjs/core';
import { QUOTA_ACTION_KEY } from './check-quota.decorator';
import { parseQuotaConfig } from './quota-config';
import { InMemoryQuotaStore } from './quota-store';
import { QuotaGuard } from './quota.guard';

function ctx(req: any, _action?: string): ExecutionContext {
  const handler = function fakeHandler() {};
  class FakeClass {}
  return {
    getHandler: jest.fn().mockReturnValue(handler),
    getClass: jest.fn().mockReturnValue(FakeClass),
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: jest.fn().mockReturnValue({ setHeader: jest.fn() }),
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

describe('QuotaGuard', () => {
  it('passes through handlers without @CheckQuota()', async () => {
    const g = new QuotaGuard(newReflector(undefined));
    expect(await g.canActivate(ctx({ tenantId: 'tenant-a' }))).toBe(true);
  });

  it('passes through when no config is registered', async () => {
    const g = new QuotaGuard(newReflector('publish'));
    expect(await g.canActivate(ctx({ tenantId: 'tenant-a' }))).toBe(true);
  });

  it('passes through when no rule matches the (tenant, action)', async () => {
    const g = new QuotaGuard(
      newReflector('publish'),
      parseQuotaConfig('tenant-other:publish=1/min'),
      new InMemoryQuotaStore(),
    );
    expect(await g.canActivate(ctx({ tenantId: 'tenant-a' }))).toBe(true);
  });

  it('allows the first N requests up to the limit', async () => {
    const g = new QuotaGuard(
      newReflector('publish'),
      parseQuotaConfig('tenant-a:publish=3/min'),
      new InMemoryQuotaStore(),
    );
    for (let i = 0; i < 3; i++) {
      expect(await g.canActivate(ctx({ tenantId: 'tenant-a' }))).toBe(true);
    }
  });

  it('throws 429 with structured body once the limit is exceeded', async () => {
    const g = new QuotaGuard(
      newReflector('publish'),
      parseQuotaConfig('tenant-a:publish=2/min'),
      new InMemoryQuotaStore(),
    );
    await g.canActivate(ctx({ tenantId: 'tenant-a' }));
    await g.canActivate(ctx({ tenantId: 'tenant-a' }));
    let err: unknown;
    try {
      await g.canActivate(ctx({ tenantId: 'tenant-a' }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpException);
    const httpErr = err as HttpException;
    expect(httpErr.getStatus()).toBe(429);
    const body = httpErr.getResponse() as Record<string, unknown>;
    expect(body.code).toBe('rate_limited');
    expect(body.tenantId).toBe('tenant-a');
    expect(body.action).toBe('publish');
    expect(body.limit).toBe(2);
    // #182: labelled in place — category + envelope details, legacy fields kept.
    expect(body.statusCode).toBe(429);
    expect(body.errorCode).toBe(ErrorCode.QUOTA_EXCEEDED);
    expect(body.windowSeconds).toBe(60);
    expect(typeof body.retryAfterSeconds).toBe('number');
    expect(body.metadata).toEqual({
      code: 'rate_limited',
      tenantId: 'tenant-a',
      action: 'publish',
      limit: 2,
      windowSeconds: 60,
      retryAfterSeconds: body.retryAfterSeconds,
    });
  });

  it('different tenants have independent counters', async () => {
    const g = new QuotaGuard(
      newReflector('publish'),
      parseQuotaConfig('tenant-a:publish=1/min;tenant-b:publish=1/min'),
      new InMemoryQuotaStore(),
    );
    expect(await g.canActivate(ctx({ tenantId: 'tenant-a' }))).toBe(true);
    expect(await g.canActivate(ctx({ tenantId: 'tenant-b' }))).toBe(true);
    // tenant-a's 2nd request fails; tenant-b's 1st was its own bucket
    await expect(g.canActivate(ctx({ tenantId: 'tenant-a' }))).rejects.toThrow(
      HttpException,
    );
  });

  it('fail-open when store returns sentinel (Redis down)', async () => {
    const sentinel = { increment: async () => ({ count: 0, ttlSeconds: 0 }) };
    const g = new QuotaGuard(
      newReflector('publish'),
      parseQuotaConfig('tenant-a:publish=1/min'),
      sentinel,
    );
    // Even though limit=1 and we'd normally expect 429 after a few calls,
    // the store says "no signal" so we pass.
    for (let i = 0; i < 5; i++) {
      expect(await g.canActivate(ctx({ tenantId: 'tenant-a' }))).toBe(true);
    }
  });

  it('wildcard * applies when action has no explicit limit', async () => {
    const g = new QuotaGuard(
      newReflector('run.start'),
      parseQuotaConfig('tenant-a:*=1/min'),
      new InMemoryQuotaStore(),
    );
    expect(await g.canActivate(ctx({ tenantId: 'tenant-a' }))).toBe(true);
    await expect(g.canActivate(ctx({ tenantId: 'tenant-a' }))).rejects.toThrow(
      HttpException,
    );
  });
});
