import { InMemoryQuotaStore, RedisQuotaStore } from './quota-store';

describe('InMemoryQuotaStore', () => {
  it('first increment starts at 1 with full TTL', async () => {
    const s = new InMemoryQuotaStore();
    const r = await s.increment('k', 60);
    expect(r.count).toBe(1);
    expect(r.ttlSeconds).toBe(60);
  });

  it('subsequent increments stack within the window', async () => {
    const s = new InMemoryQuotaStore();
    await s.increment('k', 60);
    const r = await s.increment('k', 60);
    expect(r.count).toBe(2);
    expect(r.ttlSeconds).toBeLessThanOrEqual(60);
    expect(r.ttlSeconds).toBeGreaterThan(0);
  });

  it('different keys are independent', async () => {
    const s = new InMemoryQuotaStore();
    await s.increment('a', 60);
    const r = await s.increment('b', 60);
    expect(r.count).toBe(1);
  });

  it('expired bucket resets', async () => {
    const s = new InMemoryQuotaStore();
    // 1ms TTL — wait it out before next increment.
    await s.increment('k', 0); // 0 sec window → 0 ms TTL → already expired
    const r = await s.increment('k', 60);
    expect(r.count).toBe(1);
  });
});

describe('RedisQuotaStore', () => {
  it('returns count + ttl from a successful eval', async () => {
    const fakeRedis = {
      eval: jest.fn().mockResolvedValue([5, 42]),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    const s = new RedisQuotaStore(fakeRedis);
    const r = await s.increment('k', 60);
    expect(r.count).toBe(5);
    expect(r.ttlSeconds).toBe(42);
    expect(fakeRedis.eval).toHaveBeenCalledTimes(1);
  });

  it('handles string return types from ioredis', async () => {
    const fakeRedis = {
      eval: jest.fn().mockResolvedValue(['7', '13']),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    const s = new RedisQuotaStore(fakeRedis);
    const r = await s.increment('k', 60);
    expect(r.count).toBe(7);
    expect(r.ttlSeconds).toBe(13);
  });

  it('fails open on transport error (returns {0,0})', async () => {
    const logs: string[] = [];
    const fakeRedis = {
      eval: jest.fn().mockRejectedValue(new Error('CONNREFUSED')),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    const logger = { warn: (m: string) => logs.push(m) };
    const s = new RedisQuotaStore(fakeRedis, logger);
    const r = await s.increment('k', 60);
    expect(r).toEqual({ count: 0, ttlSeconds: 0 });
    expect(logs[0]).toMatch(/CONNREFUSED/);
  });

  it('fails open on malformed eval result', async () => {
    const fakeRedis = {
      eval: jest.fn().mockResolvedValue(null),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    const s = new RedisQuotaStore(fakeRedis);
    expect(await s.increment('k', 60)).toEqual({ count: 0, ttlSeconds: 0 });
  });

  // close() exists because an unclosed ioredis client keeps Node's event loop
  // alive — that is what hung the integration suite when REDIS_URL reached CI.
  it('close() quits the client', async () => {
    const fakeRedis = {
      eval: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    await new RedisQuotaStore(fakeRedis).close();
    expect(fakeRedis.quit).toHaveBeenCalledTimes(1);
  });

  it('close() never throws, so a failing transport cannot block shutdown', async () => {
    const logs: string[] = [];
    const fakeRedis = {
      eval: jest.fn(),
      quit: jest.fn().mockRejectedValue(new Error('ECONNRESET')),
    };
    const s = new RedisQuotaStore(fakeRedis, { warn: (m: string) => logs.push(m) });
    await expect(s.close()).resolves.toBeUndefined();
    expect(logs[0]).toMatch(/ECONNRESET/);
  });
});
