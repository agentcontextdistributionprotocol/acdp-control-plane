import { HttpException } from '@nestjs/common';
import { ErrorCode } from '../errors/error-codes';
import { parseQuotaConfig, QuotaAction } from './quota-config';
import { InMemoryQuotaStore } from './quota-store';
import { QuotaService } from './quota.service';

/**
 * The enforcement cases formerly in `quota.guard.spec.ts` (moved with the
 * logic in the P3 refactor); assertions unchanged, construction adapted.
 * `ok` maps `enforce`'s void resolution back to the guard's `true`.
 */
async function ok(
  s: QuotaService,
  tenantId: string,
  action: QuotaAction,
  res?: { setHeader: jest.Mock },
): Promise<boolean> {
  await s.enforce(tenantId, action, res ?? { setHeader: jest.fn() });
  return true;
}

describe('QuotaService', () => {
  it('passes through when no config is registered', async () => {
    const s = new QuotaService();
    expect(await ok(s, 'tenant-a', 'publish')).toBe(true);
  });

  it('passes through when no rule matches the (tenant, action)', async () => {
    const s = new QuotaService(
      parseQuotaConfig('tenant-other:publish=1/min'),
      new InMemoryQuotaStore(),
    );
    expect(await ok(s, 'tenant-a', 'publish')).toBe(true);
  });

  it('allows the first N requests up to the limit', async () => {
    const s = new QuotaService(
      parseQuotaConfig('tenant-a:publish=3/min'),
      new InMemoryQuotaStore(),
    );
    for (let i = 0; i < 3; i++) {
      expect(await ok(s, 'tenant-a', 'publish')).toBe(true);
    }
  });

  it('throws 429 with structured body once the limit is exceeded', async () => {
    const s = new QuotaService(
      parseQuotaConfig('tenant-a:publish=2/min'),
      new InMemoryQuotaStore(),
    );
    await ok(s, 'tenant-a', 'publish');
    await ok(s, 'tenant-a', 'publish');
    const res = { setHeader: jest.fn() };
    let err: unknown;
    try {
      await ok(s, 'tenant-a', 'publish', res);
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
    expect(res.setHeader).toHaveBeenCalledWith(
      'Retry-After',
      String(body.retryAfterSeconds),
    );
  });

  it('throws 429 without a response object (no header to set)', async () => {
    const s = new QuotaService(
      parseQuotaConfig('tenant-a:publish=1/min'),
      new InMemoryQuotaStore(),
    );
    await s.enforce('tenant-a', 'publish');
    await expect(s.enforce('tenant-a', 'publish')).rejects.toThrow(HttpException);
  });

  it('different tenants have independent counters', async () => {
    const s = new QuotaService(
      parseQuotaConfig('tenant-a:publish=1/min;tenant-b:publish=1/min'),
      new InMemoryQuotaStore(),
    );
    expect(await ok(s, 'tenant-a', 'publish')).toBe(true);
    expect(await ok(s, 'tenant-b', 'publish')).toBe(true);
    // tenant-a's 2nd request fails; tenant-b's 1st was its own bucket
    await expect(ok(s, 'tenant-a', 'publish')).rejects.toThrow(HttpException);
  });

  it('fail-open when store returns sentinel (Redis down)', async () => {
    const sentinel = { increment: async () => ({ count: 0, ttlSeconds: 0 }) };
    const s = new QuotaService(parseQuotaConfig('tenant-a:publish=1/min'), sentinel);
    // Even though limit=1 and we'd normally expect 429 after a few calls,
    // the store says "no signal" so we pass.
    for (let i = 0; i < 5; i++) {
      expect(await ok(s, 'tenant-a', 'publish')).toBe(true);
    }
  });

  it('wildcard * applies when action has no explicit limit', async () => {
    const s = new QuotaService(
      parseQuotaConfig('tenant-a:*=1/min'),
      new InMemoryQuotaStore(),
    );
    expect(await ok(s, 'tenant-a', 'run.start')).toBe(true);
    await expect(ok(s, 'tenant-a', 'run.start')).rejects.toThrow(HttpException);
  });
});
