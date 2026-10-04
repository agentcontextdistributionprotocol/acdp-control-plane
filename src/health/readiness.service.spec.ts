import { Logger } from '@nestjs/common';
import * as client from 'prom-client';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../db/database.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { ReadinessService } from './readiness.service';

/** A pool.query fake whose calls the test settles by hand. */
function controllablePool() {
  const calls: Array<{
    arg: unknown;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }> = [];
  const query = jest.fn(
    (arg: unknown) =>
      new Promise((resolve, reject) => {
        calls.push({ arg, resolve, reject });
      }),
  );
  return { query, calls };
}

/** Let queued promise callbacks run (no timers advance). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('ReadinessService (issue #210)', () => {
  let instrumentation: InstrumentationService;
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
    client.register.clear();
    instrumentation = new InstrumentationService();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    warn.mockRestore();
    log.mockRestore();
    client.register.clear();
  });

  function make(query: jest.Mock, opts: { timeoutMs?: number; cacheMs?: number } = {}) {
    const config = {
      readinessDbTimeoutMs: opts.timeoutMs ?? 1000,
      readinessCacheMs: opts.cacheMs ?? 1000,
    } as AppConfigService;
    const database = { pool: { query } } as unknown as DatabaseService;
    return new ReadinessService(database, config, instrumentation);
  }

  async function metric(name: string, labels: Record<string, string>): Promise<number | undefined> {
    const m = await client.register.getSingleMetric(name)!.get();
    const hit = m.values.find((v) =>
      Object.entries(labels).every(([k, val]) => v.labels[k] === val),
    );
    return hit?.value;
  }

  it('up -> ready, with the bounded query (query_timeout = the probe timeout)', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const svc = make(query, { timeoutMs: 700 });
    const v = await svc.evaluate();
    expect(v.ready).toBe(true);
    expect(v.checks.database).toEqual({ status: 'up', latencyMs: 0 });
    expect(query).toHaveBeenCalledWith({ text: 'SELECT 1', query_timeout: 700 });
    expect(svc.snapshot()).toBe(v);
  });

  it('reject -> down/error, and the verdict never carries the error message', async () => {
    const query = jest
      .fn()
      .mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432 user=postgres'));
    const svc = make(query);
    const v = await svc.evaluate();
    expect(v.ready).toBe(false);
    expect(v.checks.database).toEqual({ status: 'down', reason: 'error', latencyMs: 0 });
    const text = JSON.stringify(v);
    for (const leak of ['ECONNREFUSED', '10.0.0.5', '5432', 'postgres']) {
      expect(text).not.toContain(leak);
    }
  });

  it('a synchronous driver throw is a down/error verdict, never a rejection', async () => {
    const query = jest.fn(() => {
      throw new Error('Cannot use a pool after calling end on the pool');
    });
    await expect(make(query).evaluate()).resolves.toMatchObject({
      ready: false,
      checks: { database: { status: 'down', reason: 'error' } },
    });
  });

  it('never-settling -> down/timeout at exactly the timeout', async () => {
    const { query } = controllablePool();
    const svc = make(query, { timeoutMs: 300 });
    let settled: unknown;
    void svc.evaluate().then((v) => (settled = v));
    await flush();
    jest.advanceTimersByTime(299);
    await flush();
    expect(settled).toBeUndefined();
    jest.advanceTimersByTime(1);
    await flush();
    expect(settled).toEqual({
      ready: false,
      checkedAt: 1_000_300,
      checks: { database: { status: 'down', reason: 'timeout', latencyMs: 300 } },
    });
  });

  it('10 concurrent evaluate() calls share ONE pool.query', async () => {
    const { query, calls } = controllablePool();
    const svc = make(query);
    const all = Promise.all(Array.from({ length: 10 }, () => svc.evaluate()));
    await flush();
    expect(query).toHaveBeenCalledTimes(1);
    calls[0].resolve({ rows: [] });
    const verdicts = await all;
    expect(new Set(verdicts).size).toBe(1);
    expect(verdicts[0].ready).toBe(true);
  });

  it('within the TTL no new query; after the TTL a new one', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const svc = make(query, { cacheMs: 1000 });
    await svc.evaluate();
    jest.advanceTimersByTime(999);
    await svc.evaluate();
    expect(query).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await svc.evaluate();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('a timed-out query still pending blocks a second query even after the TTL', async () => {
    const { query, calls } = controllablePool();
    const svc = make(query, { timeoutMs: 300, cacheMs: 200 });
    const first = svc.evaluate();
    await flush();
    jest.advanceTimersByTime(300);
    const v1 = await first;
    expect(v1.checks.database.reason).toBe('timeout');

    // Well past the TTL, the stuck query is still pending: reuse the failure.
    jest.advanceTimersByTime(5000);
    const v2 = await svc.evaluate();
    expect(v2).toBe(v1);
    expect(query).toHaveBeenCalledTimes(1);

    // Once it settles (here: pg's own query_timeout fires), the next
    // evaluation past the TTL probes afresh.
    calls[0].reject(new Error('Query read timeout'));
    await flush();
    const third = svc.evaluate();
    await flush();
    expect(query).toHaveBeenCalledTimes(2);
    calls[1].resolve({ rows: [] });
    await expect(third).resolves.toMatchObject({ ready: true });
  });

  it('a late success after a timeout refreshes the cache (recovery seen early), counted once', async () => {
    const { query, calls } = controllablePool();
    const svc = make(query, { timeoutMs: 300, cacheMs: 10_000 });
    const first = svc.evaluate();
    await flush();
    jest.advanceTimersByTime(300);
    expect((await first).ready).toBe(false);

    jest.advanceTimersByTime(50);
    calls[0].resolve({ rows: [] });
    await flush();
    const snap = svc.snapshot()!;
    expect(snap.ready).toBe(true);
    expect(snap.checks.database).toEqual({ status: 'up', latencyMs: 350 });
    // Served from cache from now on — no new query.
    await expect(svc.evaluate()).resolves.toBe(snap);
    expect(query).toHaveBeenCalledTimes(1);
    // One real probe = one count (its result was decided at the deadline);
    // the gauge follows the newest verdict.
    expect(await metric('acdp_readiness_checks_total', { result: 'timeout' })).toBe(1);
    expect(await metric('acdp_readiness_checks_total', { result: 'ok' })).toBeUndefined();
    expect(await metric('acdp_dependency_up', { dependency: 'database' })).toBe(1);
  });

  it('a late failure after a timeout does not overwrite the timeout verdict', async () => {
    const { query, calls } = controllablePool();
    const svc = make(query, { timeoutMs: 300 });
    const first = svc.evaluate();
    await flush();
    jest.advanceTimersByTime(300);
    const v1 = await first;
    calls[0].reject(new Error('Connection terminated'));
    await flush();
    expect(svc.snapshot()).toBe(v1);
    expect(await metric('acdp_readiness_checks_total', { result: 'error' })).toBeUndefined();
  });

  it('no NEWER verdict can exist while a probe is pending (single-flight), so a late settle is always the latest', async () => {
    // The seq guard in record() is defensive: this proves the invariant that
    // makes it unreachable — while the stuck probe is pending, no evaluation
    // (at any age) starts a second probe that could produce a newer verdict.
    const { query, calls } = controllablePool();
    const svc = make(query, { timeoutMs: 100, cacheMs: 0 });
    const first = svc.evaluate();
    await flush();
    jest.advanceTimersByTime(100);
    const v1 = await first;
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(1000);
      await expect(svc.evaluate()).resolves.toBe(v1);
    }
    expect(calls).toHaveLength(1);
  });

  it('cacheMs=0 still single-flights', async () => {
    const { query, calls } = controllablePool();
    const svc = make(query, { cacheMs: 0 });
    const a = svc.evaluate();
    const b = svc.evaluate();
    await flush();
    expect(query).toHaveBeenCalledTimes(1);
    calls[0].resolve({ rows: [] });
    expect(await a).toBe(await b);
    // ...and with no cache, the next call (nothing in flight) probes again.
    const c = svc.evaluate();
    await flush();
    expect(query).toHaveBeenCalledTimes(2);
    calls[1].resolve({ rows: [] });
    await c;
  });

  it('logs exactly once per readiness flip, with structured fields (no per-probe line)', async () => {
    const query = jest.fn();
    const svc = make(query, { cacheMs: 0 });

    query.mockResolvedValue({ rows: [] });
    await svc.evaluate(); // first verdict up: assumed-ready start, not a flip
    await svc.evaluate();
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();

    query.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5433'));
    await svc.evaluate();
    await svc.evaluate();
    await svc.evaluate();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({
      msg: 'readiness changed',
      dependency: 'database',
      ready: false,
      reason: 'error',
      latencyMs: 0,
      error: 'connect ECONNREFUSED 127.0.0.1:5433',
    });

    query.mockResolvedValue({ rows: [] });
    await svc.evaluate();
    await svc.evaluate();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({
      msg: 'readiness changed',
      dependency: 'database',
      ready: true,
      reason: undefined,
      latencyMs: 0,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a first-ever verdict of down IS a transition (logged once)', async () => {
    const svc = make(jest.fn().mockRejectedValue(new Error('x')));
    await svc.evaluate();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('counter + gauge move per REAL probe, never per cache hit', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const svc = make(query, { cacheMs: 1000 });
    for (let i = 0; i < 5; i++) await svc.evaluate(); // 1 real probe + 4 cache hits
    expect(await metric('acdp_readiness_checks_total', { dependency: 'database', result: 'ok' })).toBe(1);
    expect(await metric('acdp_dependency_up', { dependency: 'database' })).toBe(1);

    jest.advanceTimersByTime(1000);
    query.mockRejectedValue(new Error('down'));
    for (let i = 0; i < 3; i++) await svc.evaluate();
    expect(await metric('acdp_readiness_checks_total', { result: 'error' })).toBe(1);
    expect(await metric('acdp_dependency_up', { dependency: 'database' })).toBe(0);

    jest.advanceTimersByTime(1000);
    query.mockImplementation(() => new Promise(() => undefined));
    const t = svc.evaluate();
    await flush();
    jest.advanceTimersByTime(1000);
    await t;
    expect(await metric('acdp_readiness_checks_total', { result: 'timeout' })).toBe(1);
  });

  it('snapshot() is undefined before the first probe and never queries', () => {
    const query = jest.fn();
    expect(make(query).snapshot()).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
});
