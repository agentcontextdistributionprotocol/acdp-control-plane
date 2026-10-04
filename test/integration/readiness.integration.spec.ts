import { performance } from 'node:perf_hooks';
import { DatabaseService } from '../../src/db/database.service';
import { PgFaultProxy } from '../helpers/pg-fault-proxy';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { RawResponse, TestClient } from '../helpers/test-client';

/**
 * Issue #210 over real HTTP and a real pg pool: `/readyz` answers 503
 * DEPENDENCY_UNAVAILABLE when Postgres is refused, black-holed or the probe
 * cannot get a connection in time; returns 200 after recovery; never holds more
 * than one pool client; is never 429'd. And (Phase 2) `/healthz` is pure
 * liveness: fast and 200 whatever the database does, its `ok` mirroring the
 * last readiness verdict with no latch. The database failures are simulated by
 * `PgFaultProxy` in front of the shared test Postgres, which is never stopped.
 */

const TIMEOUT_MS = 300;
const CACHE_MS = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Save the given env vars, set new values, and return a restorer. */
function withEnv(env: Record<string, string>): () => void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

async function timed(fn: () => Promise<RawResponse>): Promise<{ res: RawResponse; ms: number }> {
  const t0 = performance.now();
  const res = await fn();
  return { res, ms: performance.now() - t0 };
}

/** Poll `/readyz` until 200; returns elapsed ms (or throws at `limitMs`). */
async function pollReady(anon: TestClient, limitMs: number): Promise<number> {
  const t0 = performance.now();
  for (;;) {
    const res = await anon.requestRaw('GET', '/readyz');
    const elapsed = performance.now() - t0;
    if (res.status === 200) return elapsed;
    if (elapsed > limitMs) {
      throw new Error(`/readyz still ${res.status} after ${Math.round(elapsed)} ms`);
    }
    await sleep(25);
  }
}

function details(res: RawResponse): Record<string, unknown> {
  const body = res.body as { error?: { details?: Record<string, unknown> } };
  return body.error?.details ?? {};
}

function metricValue(text: string, series: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(series + ' '));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

/** `fn`'s response, or a synthetic status 0 once `limitMs` has passed (a hang). */
async function timedWithin(
  fn: () => Promise<RawResponse>,
  limitMs: number,
): Promise<{ res: RawResponse; ms: number }> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<RawResponse>((resolve) => {
    timer = setTimeout(() => resolve({ status: 0, headers: {}, body: 'hung' }), limitMs);
  });
  try {
    return await timed(() => Promise.race([fn(), hung]));
  } finally {
    clearTimeout(timer);
  }
}

/** `/healthz` refreshes readiness in the background once the snapshot is older
 *  than max(READINESS_CACHE_MS, 5000) ms (#210 Phase 2). */
const HEALTHZ_STALE_MS = 5000;

const DB_UP = 'acdp_dependency_up{dependency="database"}';
const POOL_ERRORS = 'acdp_db_pool_errors_total';
const TIMEOUTS = 'acdp_readiness_checks_total{dependency="database",result="timeout"}';

describe('Readiness — /readyz vs. a failing database (issue #210, integration)', () => {
  let proxy: PgFaultProxy;
  let proxyUrl: string;
  let ctx: TestAppContext;
  let anon: TestClient;
  let restoreEnv: () => void;
  let database: DatabaseService;

  beforeAll(async () => {
    proxy = new PgFaultProxy();
    proxyUrl = (await proxy.start()).url;
    restoreEnv = withEnv({ DATABASE_URL: process.env.DATABASE_URL ?? '' });
    ctx = await createTestApp({
      databaseUrl: proxyUrl,
      readiness: { timeoutMs: TIMEOUT_MS, cacheMs: CACHE_MS },
    });
    anon = new TestClient(ctx.url);
    database = ctx.module.get(DatabaseService);
  });

  afterEach(async () => {
    // A failed case must not poison the next one (or a later suite).
    await proxy.restore();
    await pollReady(anon, 10_000);
  });

  afterAll(async () => {
    await ctx.app.close();
    await proxy.close();
    restoreEnv();
  });

  it('healthy: 200 { ok, database, checks } with Cache-Control: no-store; HEAD too', async () => {
    const res = await anon.requestRaw('GET', '/readyz');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      ok: true,
      database: 'ok',
      checks: { database: { status: 'up', latencyMs: expect.any(Number) } },
    });
    const head = await anon.requestRaw('HEAD', '/readyz');
    expect(head.status).toBe(200);
    expect(head.headers['cache-control']).toBe('no-store');
  });

  it('DB refused: 503 DEPENDENCY_UNAVAILABLE within timeout+250 ms, no leakage; then recovers', async () => {
    await proxy.refuse();
    await sleep(CACHE_MS + 50); // let the cached "up" verdict expire

    const { res, ms } = await timed(() => anon.requestRaw('GET', '/readyz'));
    expect(res.status).toBe(503);
    expect(ms).toBeLessThan(TIMEOUT_MS + 250);
    const body = res.body as Record<string, unknown>;
    expect(body.errorCode).toBe('DEPENDENCY_UNAVAILABLE');
    expect(body.error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(details(res)).toEqual({
      ok: false,
      database: 'unhealthy',
      checks: { database: { status: 'down', reason: 'error', latencyMs: expect.any(Number) } },
    });
    expect(res.headers['content-type']).toContain('application/acdp+json');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['retry-after']).toBeUndefined();
    // Unauthenticated endpoint: never the driver's error text, host or port.
    const text = JSON.stringify(res.body);
    for (const leak of ['ECONNREFUSED', '127.0.0.1', String(proxy.listenPort), 'postgres']) {
      expect(text).not.toContain(leak);
    }

    const head = await anon.requestRaw('HEAD', '/readyz');
    expect(head.status).toBe(503);

    await proxy.restore();
    // Proxy-dependent bound: restore() destroys the dead sockets, so nothing
    // stays pending (the production bound is in the pending-connect case).
    const elapsed = await pollReady(anon, CACHE_MS + TIMEOUT_MS + 500);
    expect(elapsed).toBeLessThan(CACHE_MS + TIMEOUT_MS + 500);
    const ok = await anon.requestRaw('GET', '/readyz');
    expect(ok.body).toMatchObject({ ok: true, database: 'ok' });
  });

  // ── Phase 2: /healthz is liveness — it never awaits the database ──────────

  it('DB black-holed: /healthz answers 200 in < 200 ms (20x) while /readyz is 503; ok mirrors the verdict', async () => {
    // Warm: an idle pooled client exists, so the black hole pins a real socket.
    expect((await anon.requestRaw('GET', '/readyz')).status).toBe(200);
    proxy.blackhole();
    await sleep(CACHE_MS + 50);
    expect((await anon.requestRaw('GET', '/readyz')).status).toBe(503);

    for (let i = 0; i < 20; i++) {
      // Bounded so a hanging liveness probe (the pre-#210 behaviour: > 15 s)
      // fails as an assertion, not as a jest timeout.
      const { res, ms } = await timedWithin(() => anon.requestRaw('GET', '/healthz'), 2000);
      expect({ i, status: res.status }).toEqual({ i, status: 200 });
      expect(ms).toBeLessThan(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        ok: false,
        service: 'acdp-control-plane',
        version: expect.any(String),
      });
      if (i % 5 === 0) expect((await anon.requestRaw('GET', '/readyz')).status).toBe(503);
    }
  });

  it('DB refused then restored: /healthz mirrors ok:false, then ok:true within one stale window — no latch; pool errors counted', async () => {
    // Warm: an idle client exists, so refuse() destroys an idle socket and the
    // pool emits 'error' — the event that used to latch /healthz forever.
    expect((await anon.requestRaw('GET', '/readyz')).status).toBe(200);
    const errorsBefore = metricValue(await anon.metrics(), POOL_ERRORS) ?? 0;

    await proxy.refuse();
    await sleep(CACHE_MS + 50);
    expect((await anon.requestRaw('GET', '/readyz')).status).toBe(503);
    const down = await timedWithin(() => anon.requestRaw('GET', '/healthz'), 2000);
    expect(down.res.status).toBe(200);
    expect(down.res.body).toEqual({
      ok: false,
      service: 'acdp-control-plane',
      version: expect.any(String),
    });
    expect(metricValue(await anon.metrics(), POOL_ERRORS)).toBeGreaterThanOrEqual(errorsBefore + 1);

    await proxy.restore();
    const restoredAt = performance.now();
    // Only /healthz from here: its own background refresh (once the snapshot
    // is stale) must bring `ok` back, with no /readyz traffic and no restart.
    const limit = HEALTHZ_STALE_MS + TIMEOUT_MS + 1000;
    for (;;) {
      const { res } = await timedWithin(() => anon.requestRaw('GET', '/healthz'), 2000);
      expect(res.status).toBe(200);
      if ((res.body as { ok?: unknown }).ok === true) break;
      if (performance.now() - restoredAt > limit) {
        throw new Error(`/healthz still ok:false ${Math.round(performance.now() - restoredAt)} ms after restore`);
      }
      await sleep(100);
    }
    expect(performance.now() - restoredAt).toBeLessThan(limit);
  });

  it('DB black-holed: 503 reason "timeout" in < 600 ms; 50 concurrent probes add <= 1 pool client; metrics move', async () => {
    // Warm: one successful probe so an idle client exists, then snapshot.
    expect((await anon.requestRaw('GET', '/readyz')).status).toBe(200);
    const before = database.pool.totalCount;

    proxy.blackhole();
    await sleep(CACHE_MS + 50);

    const { res, ms } = await timed(() => anon.requestRaw('GET', '/readyz'));
    expect(res.status).toBe(503);
    expect(ms).toBeLessThan(600);
    expect(details(res)).toMatchObject({
      ok: false,
      checks: { database: { status: 'down', reason: 'timeout' } },
    });

    // 50 concurrent probes in one burst, then 5 waves of 10 spanning several
    // cache windows, sampling the pool between waves: probes share ONE
    // in-flight query at most.
    const burst = await Promise.all(
      Array.from({ length: 50 }, () => anon.requestRaw('GET', '/readyz')),
    );
    expect(burst.map((r) => r.status)).toEqual(burst.map(() => 503));
    let maxTotal = database.pool.totalCount;
    for (let wave = 0; wave < 5; wave++) {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => anon.requestRaw('GET', '/readyz')),
      );
      expect(results.map((r) => r.status)).toEqual(results.map(() => 503));
      maxTotal = Math.max(maxTotal, database.pool.totalCount);
      await sleep(CACHE_MS / 2);
      maxTotal = Math.max(maxTotal, database.pool.totalCount);
    }
    expect(maxTotal).toBeLessThanOrEqual(before + 1);

    const during = await anon.metrics();
    expect(metricValue(during, TIMEOUTS)).toBeGreaterThanOrEqual(1);
    expect(metricValue(during, DB_UP)).toBe(0);

    await proxy.restore();
    const elapsed = await pollReady(anon, CACHE_MS + TIMEOUT_MS + 500);
    expect(elapsed).toBeLessThan(CACHE_MS + TIMEOUT_MS + 500);
    expect(metricValue(await anon.metrics(), DB_UP)).toBe(1);

    // The app pool serves real traffic again.
    expect((await ctx.client.requestRaw('GET', '/runs')).status).toBe(200);
  });
});

describe('Readiness — pending connect at restore (issue #210, production recovery bound)', () => {
  const CONN_TIMEOUT_MS = 1500;
  let proxy: PgFaultProxy;
  let ctx: TestAppContext;
  let anon: TestClient;
  let database: DatabaseService;
  let restoreEnv: () => void;

  beforeAll(async () => {
    proxy = new PgFaultProxy();
    const { url } = await proxy.start();
    restoreEnv = withEnv({
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      DB_POOL_CONNECTION_TIMEOUT: String(CONN_TIMEOUT_MS),
      // Idle clients close almost at once, so the probe after the black-hole
      // must open a NEW client — a connect, not a query on an established socket.
      DB_POOL_IDLE_TIMEOUT: '1',
    });
    ctx = await createTestApp({
      databaseUrl: url,
      readiness: { timeoutMs: TIMEOUT_MS, cacheMs: CACHE_MS },
    });
    anon = new TestClient(ctx.url);
    database = ctx.module.get(DatabaseService);
  });

  afterAll(async () => {
    await proxy.restore();
    await ctx.app.close();
    await proxy.close();
    restoreEnv();
  });

  it('stays 503 with no second probe query until the stuck connect times out, then 200 — never sticks', async () => {
    expect((await anon.requestRaw('GET', '/readyz')).status).toBe(200);
    // Wait for the pool to have no client at all (idle timeout 1 ms).
    for (let i = 0; database.pool.totalCount > 0; i++) {
      if (i > 200) throw new Error('pool never drained');
      await sleep(10);
    }
    const before = database.pool.totalCount; // 0

    proxy.blackhole();
    await sleep(CACHE_MS + 50);
    const first = await anon.requestRaw('GET', '/readyz');
    expect(first.status).toBe(503);
    expect(details(first)).toMatchObject({ checks: { database: { reason: 'timeout' } } });
    // The probe is stuck in a NEW-client connect through the black hole.
    expect(proxy.blackholedAccepts).toBe(1);
    expect(database.pool.totalCount).toBe(1);
    expect(database.pool.idleCount).toBe(0);

    await proxy.restore({ keepPending: true });
    const restoredAt = performance.now();

    // Until the stuck connect hits connectionTimeoutMillis, readiness reuses the
    // failure — no second probe query, so never more than one probe client.
    let sawRecovery = false;
    let maxTotal = database.pool.totalCount;
    for (;;) {
      const res = await anon.requestRaw('GET', '/readyz');
      maxTotal = Math.max(maxTotal, database.pool.totalCount);
      const since = performance.now() - restoredAt;
      if (res.status === 200) {
        sawRecovery = true;
        break;
      }
      if (since > CACHE_MS + CONN_TIMEOUT_MS + TIMEOUT_MS + 500) break;
      await sleep(25);
    }
    const recoveredAfter = performance.now() - restoredAt;
    expect(sawRecovery).toBe(true);
    expect(recoveredAfter).toBeLessThan(CACHE_MS + CONN_TIMEOUT_MS + TIMEOUT_MS + 500);
    expect(maxTotal).toBeLessThanOrEqual(before + 1);
    // Only one connect ever went into the black hole.
    expect(proxy.blackholedAccepts).toBe(1);
  });
});

describe('Readiness — probes are never throttled (issue #210, D5)', () => {
  let proxy: PgFaultProxy;
  let ctx: TestAppContext;
  let restoreEnv: () => void;

  beforeAll(async () => {
    proxy = new PgFaultProxy();
    const { url } = await proxy.start();
    restoreEnv = withEnv({
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      THROTTLE_LIMIT: '5',
    });
    ctx = await createTestApp({ databaseUrl: url });
  });

  afterAll(async () => {
    await ctx.app.close();
    await proxy.close();
    restoreEnv();
  });

  it('50 anonymous /readyz and 50 /healthz from one IP: 0 x 429; /ingest/health still throttled at the 6th', async () => {
    const anon = new TestClient(ctx.url);
    const ready = await Promise.all(
      Array.from({ length: 50 }, () => anon.requestRaw('GET', '/readyz')),
    );
    expect(ready.filter((r) => r.status === 429)).toHaveLength(0);
    expect(ready.every((r) => r.status === 200)).toBe(true);
    // Phase 2: /healthz never touches the DB, so @SkipThrottle() is class-level.
    const live = await Promise.all(
      Array.from({ length: 50 }, () => anon.requestRaw('GET', '/healthz')),
    );
    expect(live.filter((r) => r.status === 429)).toHaveLength(0);
    expect(live.every((r) => r.status === 200)).toBe(true);

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await anon.requestRaw('GET', '/ingest/health')).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe('Readiness — boot-time validation in the development harness (issue #210)', () => {
  it.each([
    ['DB_POOL_CONNECTION_TIMEOUT', '0'],
    ['DB_POOL_CONNECTION_TIMEOUT', '-1'],
    ['DB_POOL_CONNECTION_TIMEOUT', '1.5'],
    ['READINESS_DB_TIMEOUT_MS', 'abc'],
    ['READINESS_DB_TIMEOUT_MS', '0'],
    ['READINESS_DB_TIMEOUT_MS', '40000'],
    ['READINESS_CACHE_MS', '-1'],
    ['READINESS_CACHE_MS', 'x'],
  ])('%s=%s fails boot, naming the variable', async (name, value) => {
    const restoreEnv = withEnv({ DATABASE_URL: process.env.DATABASE_URL ?? '' });
    const restorePool =
      name === 'DB_POOL_CONNECTION_TIMEOUT' ? withEnv({ [name]: value }) : () => undefined;
    try {
      const boot = createTestApp({
        readiness:
          name === 'READINESS_DB_TIMEOUT_MS'
            ? { timeoutMs: value }
            : name === 'READINESS_CACHE_MS'
              ? { cacheMs: value }
              : undefined,
      });
      await expect(boot).rejects.toThrow(new RegExp(`^${name} must be`));
    } finally {
      restorePool();
      restoreEnv();
      delete process.env.READINESS_DB_TIMEOUT_MS;
      delete process.env.READINESS_CACHE_MS;
    }
  });
});
