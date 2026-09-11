/**
 * Finalization seam spec (ACDP #137, §4 — spans Phase 7 and Phase 9).
 *
 * WHY THIS FILE EXISTS. Phase 7 (ioredis 5 -> 6) shipped a BLOCKING defect that
 * every per-phase test missed, and the shape of that miss is the reason this
 * spec exists rather than another unit test.
 *
 * `QuotaModule`'s docblock promised "no Redis traffic even when a Redis URL is
 * configured" if no tenants are configured. The factory never implemented that
 * condition — it checked only `REDIS_URL` — so a process with `REDIS_URL` and
 * no `TENANT_QUOTAS` opened a long-lived ioredis client that nothing ever used.
 * A live client keeps Node's event loop alive, so the process never exited.
 * This surfaced only when CI's integration job gained a `REDIS_URL`: 24 of 26
 * suites leaked a client, jest printed all-green and then HUNG to the job
 * timeout. Green, then hang — the worst possible failure signature.
 *
 * WHY EXISTING COVERAGE DOES NOT CATCH IT. `src/quota/quota-store.spec.ts`
 * proves `RedisQuotaStore.close()` calls `.quit()` — against a hand-written
 * fake, in isolation from Nest. Nothing proves the two things that actually
 * failed:
 *   1. that the FACTORY picks the in-memory store when Redis is configured but
 *      no tenants are  (the defect itself), and
 *   2. that `QuotaModule.onModuleDestroy` is wired such that a REAL client is
 *      actually closed when the Nest app shuts down  (the fix's other half).
 * Both are seams between a module, a factory, a lifecycle hook and a live
 * socket — exactly what a unit test with a fake cannot reach.
 *
 * SKIP POLICY. Mirrors `redis-live.integration.spec.ts`, INCLUDING its reachability
 * probe. A URL is not a server: outside CI `REDIS_URL` falls back to a hardcoded
 * default, so branching on the URL alone can never take the "no Redis" path — it
 * runs against nothing, times out, and then HANGS on the retry timer. The probe,
 * not the string, decides:
 *   - CI + REDIS_URL unset     -> FAIL LOUDLY (never skip)
 *   - CI + set but unreachable -> FAIL LOUDLY
 *   - local + reachable        -> run
 *   - local + unreachable      -> skip, with instructions
 *
 * MUST NEVER HANG. This spec exists because a leaked ioredis client turned a green
 * suite into a job timeout. It must not reproduce that in its own failure path, so
 * cleanup runs in `withApp`'s `finally` — never as a test's last statement, which a
 * failed assertion would skip — and is itself time-bounded, falling back to
 * `disconnect()` when a `quit()` against a dead server stalls.
 */
import Redis from 'ioredis';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '../../src/config/config.module';
import { QuotaModule } from '../../src/quota/quota.module';
import { QUOTA_STORE } from '../../src/quota/quota.guard';
import {
  InMemoryQuotaStore,
  RedisQuotaStore,
  type QuotaStore,
} from '../../src/quota/quota-store';

const DEFAULT_LOCAL_URL = 'redis://127.0.0.1:6380';
const IS_CI = Boolean(process.env.CI);
const REDIS_URL = process.env.REDIS_URL ?? (IS_CI ? undefined : DEFAULT_LOCAL_URL);

if (IS_CI && !REDIS_URL) {
  throw new Error(
    'REDIS_URL is unset in CI. The quota-store lifecycle spec must never skip ' +
      'in CI — it guards the Phase 7 defect where a leaked ioredis client made ' +
      'the integration job hang AFTER reporting green.',
  );
}

/** The private field on `RedisQuotaStore` that holds the ioredis client. */
const CLIENT_FIELD = 'redis';

/**
 * Reach the private client to observe the socket. Deliberate: the whole point is
 * asserting on transport state the public contract hides.
 *
 * The `instanceof` guard is what stops `toBeUndefined()` passing VACUOUSLY. Without
 * it, renaming that private field makes every `clientOf(...)` return `undefined`,
 * turning "no client was opened" into a tautology that can never fail — on the very
 * spec written to catch a leaked client.
 */
function clientOf(store: QuotaStore): { status: string } | undefined {
  const client = (store as unknown as Record<string, unknown>)[CLIENT_FIELD];
  if (store instanceof RedisQuotaStore && client === undefined) {
    throw new Error(
      `RedisQuotaStore no longer exposes a private '${CLIENT_FIELD}' field. This ` +
        "spec's transport assertions would silently pass vacuously — update CLIENT_FIELD.",
    );
  }
  return client as { status: string } | undefined;
}

async function buildWith(env: {
  REDIS_URL?: string;
  TENANT_QUOTAS?: string;
}): Promise<{ store: QuotaStore; close: () => Promise<void> }> {
  const saved = {
    REDIS_URL: process.env.REDIS_URL,
    TENANT_QUOTAS: process.env.TENANT_QUOTAS,
    NODE_ENV: process.env.NODE_ENV,
  };
  // `AppConfigService.validate()` short-circuits only for NODE_ENV=development;
  // under anything else it demands AUTH_API_KEYS/WEBHOOK_SECRET and throws at
  // onModuleInit. `test/helpers/test-app.ts` sets 'development' for exactly this
  // reason — match that convention rather than inventing a second one.
  process.env.NODE_ENV = 'development';
  // AppConfigService reads process.env at field-init time, so the env must be
  // in place before the module is compiled, and restored right after.
  if (env.REDIS_URL === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = env.REDIS_URL;
  if (env.TENANT_QUOTAS === undefined) delete process.env.TENANT_QUOTAS;
  else process.env.TENANT_QUOTAS = env.TENANT_QUOTAS;

  try {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, QuotaModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return {
      store: app.get<QuotaStore>(QUOTA_STORE),
      close: () => app.close(),
    };
  } finally {
    if (saved.REDIS_URL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved.REDIS_URL;
    if (saved.TENANT_QUOTAS === undefined) delete process.env.TENANT_QUOTAS;
    else process.env.TENANT_QUOTAS = saved.TENANT_QUOTAS;
    if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.NODE_ENV;
  }
}

/**
 * Always-runs cleanup. A test's trailing `await close()` is skipped the moment an
 * assertion above it throws, leaking the very client this spec guards — so the app
 * is closed in a `finally` instead. The close is also bounded: a `quit()` issued
 * against a server that has gone away can stall indefinitely, and a stalled cleanup
 * is the same job timeout by another route.
 */
async function withApp<T>(
  env: { REDIS_URL?: string; TENANT_QUOTAS?: string },
  fn: (store: QuotaStore) => Promise<T>,
): Promise<T> {
  const { store, close } = await buildWith(env);
  try {
    return await fn(store);
  } finally {
    const client = clientOf(store) as unknown as { disconnect?: () => void } | undefined;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      close().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          client?.disconnect?.();
          resolve();
        }, 5_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}

describe('QuotaModule store lifecycle (live Redis)', () => {
  jest.setTimeout(30_000);

  let reachable = false;

  beforeAll(async () => {
    // `retryStrategy: () => null` is load-bearing: without it an unreachable server
    // leaves ioredis reconnecting forever, and that pending timer alone keeps Node's
    // event loop — and therefore jest — alive long after the last test reported.
    const probe = new Redis(REDIS_URL as string, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    probe.on('error', () => undefined);
    try {
      await probe.connect();
      reachable = true;
    } catch (err) {
      if (IS_CI) {
        throw new Error(
          `REDIS_URL is set in CI but unreachable: ${
            err instanceof Error ? err.message : String(err)
          }. This spec guards the Phase 7 defect where a leaked ioredis client made ` +
            'the integration job hang AFTER reporting green; it must not skip.',
        );
      }
      console.warn(
        `[quota-lifecycle] no Redis at ${REDIS_URL} — SKIPPING. Start one with ` +
          '`docker compose -f docker-compose.test.yml up -d redis-test`.',
      );
    } finally {
      probe.disconnect();
    }
  });

  describe('REDIS_URL set but NO tenants configured — the Phase 7 defect', () => {
    it('selects the in-memory store and opens no Redis connection', async () => {
      if (!reachable) return;
      await withApp({ REDIS_URL, TENANT_QUOTAS: '' }, async (store) => {
        // The assertion that would have failed before the fix.
        expect(store).toBeInstanceOf(InMemoryQuotaStore);
        expect(store).not.toBeInstanceOf(RedisQuotaStore);
        // No client at all — not merely a closed one.
        expect(clientOf(store)).toBeUndefined();
      });
    });

    it('shuts down without leaving the event loop alive', async () => {
      if (!reachable) return;
      const { close } = await buildWith({ REDIS_URL, TENANT_QUOTAS: '' });
      // If this hangs, the defect is back: jest would report green then hang.
      await expect(close()).resolves.toBeUndefined();
    });
  });

  describe('REDIS_URL set AND tenants configured', () => {
    it('selects the Redis store and reaches a live server', async () => {
      if (!reachable) return;
      await withApp(
        { REDIS_URL, TENANT_QUOTAS: 'tenant-a:publish=100/min' },
        async (store) => {
          expect(store).toBeInstanceOf(RedisQuotaStore);
          // Cross the wire through the store's own public path, so the Lua and the
          // ioredis 6 reply shape are both exercised, not just the constructor.
          const key = `quota-lifecycle-test:${Date.now()}`;
          const first = await store.increment(key, 60);
          expect(first.count).toBe(1);
          const second = await store.increment(key, 60);
          expect(second.count).toBe(2);
        },
      );
    });

    it('closes the live client on app shutdown', async () => {
      if (!reachable) return;
      let client: { status: string } | undefined;
      await withApp(
        { REDIS_URL, TENANT_QUOTAS: 'tenant-a:publish=100/min' },
        async (store) => {
          client = clientOf(store);
          expect(client).toBeDefined();
          expect(['connect', 'connecting', 'ready']).toContain(client!.status);
        },
      );
      // 'end' is ioredis's terminal state after quit(). This is the assertion that
      // proves QuotaModule.onModuleDestroy is actually wired to the store's close()
      // — the half of the Phase 7 fix no unit test reaches.
      expect(client!.status).toBe('end');
    });
  });
});
