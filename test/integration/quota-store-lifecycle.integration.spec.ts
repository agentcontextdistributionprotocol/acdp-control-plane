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
 * SKIP POLICY. Mirrors `redis-live.integration.spec.ts`: a spec that silently
 * skips in CI reports green forever while proving nothing.
 *   - CI + REDIS_URL set   -> run
 *   - CI + REDIS_URL unset -> FAIL LOUDLY
 *   - local, no Redis      -> skip with instructions
 */
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

/** Reach the private client to observe the socket. Deliberate: the whole point
 *  is asserting on transport state the public contract hides. */
function clientOf(store: QuotaStore): { status: string } {
  return (store as unknown as { redis: { status: string } }).redis;
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

const d = REDIS_URL ? describe : describe.skip;
if (!REDIS_URL) {
  console.warn(
    'quota-store lifecycle spec skipped: no Redis. Start one with ' +
      '`docker compose -f docker-compose.test.yml up -d redis-test` (port 6380).',
  );
}

d('QuotaModule store lifecycle (live Redis)', () => {
  jest.setTimeout(30_000);

  describe('REDIS_URL set but NO tenants configured — the Phase 7 defect', () => {
    it('selects the in-memory store and opens no Redis connection', async () => {
      const { store, close } = await buildWith({
        REDIS_URL,
        TENANT_QUOTAS: '',
      });
      // The assertion that would have failed before the fix.
      expect(store).toBeInstanceOf(InMemoryQuotaStore);
      expect(store).not.toBeInstanceOf(RedisQuotaStore);
      // No client at all — not merely a closed one.
      expect(clientOf(store)).toBeUndefined();
      await close();
    });

    it('shuts down without leaving the event loop alive', async () => {
      const { close } = await buildWith({ REDIS_URL, TENANT_QUOTAS: '' });
      // If this hangs, the defect is back: jest would report green then hang.
      await expect(close()).resolves.toBeUndefined();
    });
  });

  describe('REDIS_URL set AND tenants configured', () => {
    it('selects the Redis store and reaches a live server', async () => {
      const { store, close } = await buildWith({
        REDIS_URL,
        TENANT_QUOTAS: 'tenant-a:publish=100/min',
      });
      expect(store).toBeInstanceOf(RedisQuotaStore);
      // Cross the wire through the store's own public path, so the Lua and the
      // ioredis 6 reply shape are both exercised, not just the constructor.
      const key = `quota-lifecycle-test:${Date.now()}`;
      const first = await store.increment(key, 60);
      expect(first.count).toBe(1);
      const second = await store.increment(key, 60);
      expect(second.count).toBe(2);
      await close();
    });

    it('closes the live client on app shutdown', async () => {
      const { store, close } = await buildWith({
        REDIS_URL,
        TENANT_QUOTAS: 'tenant-a:publish=100/min',
      });
      const client = clientOf(store);
      expect(client).toBeDefined();
      expect(['connect', 'connecting', 'ready']).toContain(client.status);

      await close();

      // 'end' is ioredis's terminal state after quit(). This is the assertion
      // that proves QuotaModule.onModuleDestroy is actually wired to the
      // store's close() — the half of the Phase 7 fix no unit test reaches.
      expect(client.status).toBe('end');
    });
  });
});
