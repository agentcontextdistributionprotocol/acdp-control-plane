/**
 * Live-Redis contract spec (ACDP #137 Phase 7, ioredis 5 -> 6).
 *
 * WHY THIS FILE EXISTS. `src/events/redis-stream-hub.strategy.spec.ts` and
 * `src/quota/quota-store.spec.ts` both replace the client with a fake
 * (`jest.mock('ioredis', () => FakeRedis)` / a duck-typed `eval`), so NEITHER
 * proves anything about the wire protocol. ioredis 6 sends `HELLO 3` and speaks
 * RESP3 by default, which changes pub/sub to push frames and could change reply
 * shapes. Only a real server can falsify that, so this spec drives a REAL
 * `ioredis` client through the exact three operations the repo depends on:
 *
 *   1. pub/sub round-trip  -> `RedisStreamHubStrategy.connect` (subscribe + 'message')
 *   2. `.eval()` of the quota Lua -> `RedisQuotaStore.increment` reply shape
 *   3. `.quit()`            -> both strategies' shutdown paths
 *
 * SKIP POLICY. A spec that silently skips in CI is worse than no spec — it
 * reports green forever while proving nothing. That is exactly the CP-7 defect
 * this repo already fixed once for the conformance suites. So:
 *   - CI + REDIS_URL set    -> run (the `integration` job supplies it)
 *   - CI + REDIS_URL UNSET  -> FAIL LOUDLY, never skip
 *   - local, no Redis       -> skip, with a message saying how to get one
 * Outside CI we default to the `redis-test` service in docker-compose.test.yml
 * (published on 6380 so it cannot collide with a developer's own local Redis),
 * which `test/setup/global-setup.ts` starts alongside postgres-test.
 */
import Redis from 'ioredis';

const DEFAULT_LOCAL_URL = 'redis://127.0.0.1:6380';
const IS_CI = Boolean(process.env.CI);
const REDIS_URL = process.env.REDIS_URL ?? (IS_CI ? undefined : DEFAULT_LOCAL_URL);

if (IS_CI && !REDIS_URL) {
  throw new Error(
    'REDIS_URL is unset in CI. The live-Redis contract spec must never skip in ' +
      'CI — ioredis 6 speaks RESP3 and the mocked unit specs cannot detect a ' +
      'wire-protocol break. Add a `redis` service + REDIS_URL to the integration job.',
  );
}

/** The exact script in src/quota/quota-store.ts — kept verbatim on purpose. */
const INCR_AND_EXPIRE_LUA = `
local v = redis.call('INCR', KEYS[1])
if v == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  return {v, tonumber(ARGV[1])}
end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {v, ttl}
`;

const CHANNEL = 'acdp:stream-hub';

describe('ioredis live contract (RESP3)', () => {
  let pub: Redis;
  let sub: Redis;
  let reachable = false;

  beforeAll(async () => {
    pub = new Redis(REDIS_URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
    sub = new Redis(REDIS_URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
    // Attach error handlers before connecting: an ioredis client is an
    // EventEmitter and an unhandled 'error' is noisy at best.
    pub.on('error', () => undefined);
    sub.on('error', () => undefined);
    try {
      await pub.connect();
      await sub.connect();
      reachable = true;
    } catch (err) {
      if (IS_CI) {
        throw new Error(
          `REDIS_URL is set in CI but unreachable: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      console.warn(
        `[redis-live] no Redis at ${DEFAULT_LOCAL_URL} — SKIPPING. Start one with ` +
          '`docker compose -f docker-compose.test.yml up -d redis-test`.',
      );
    }
  });

  afterAll(async () => {
    // .quit() is itself part of the contract under test (operation 3).
    if (reachable) {
      await expect(pub.quit()).resolves.toBe('OK');
      await expect(sub.quit()).resolves.toBe('OK');
    } else {
      pub?.disconnect();
      sub?.disconnect();
    }
  });

  /**
   * Each case early-returns when Redis is absent. That is a deliberate
   * trade-off and only ever applies LOCALLY: in CI `beforeAll` throws on an
   * unreachable server, so CI can never take this path and can never report a
   * trivially-passing green. The console.warn above is the local signal.
   */
  it('actually NEGOTIATED RESP3, not merely requested it', () => {
    if (!reachable) return;
    // `options.protocol` is the compile-time DEFAULT and is useless as
    // evidence: ioredis deliberately never mutates it when the server rejects
    // HELLO 3 — it downgrades by setting `condition.protocol = 2` and leaves
    // the option alone (built/redis/event_handler.js: "so just warn — don't
    // touch the option"). Asserting the option therefore passes green against a
    // Redis 5 that speaks no RESP3 at all, under a title claiming negotiation.
    // Verified: against redis:5-alpine, options.protocol is still 3 while
    // condition.protocol is 2. So assert the NEGOTIATED value.
    const negotiated = (pub as unknown as { condition: { protocol: number } }).condition
      .protocol;
    expect(negotiated).toBe(3);

    // `replyMapping: 'legacy'` is what preserves the v5/RESP2 reply SHAPES the
    // quota Lua reader depends on. If a future ioredis flips this default, the
    // quota store breaks silently — pin it.
    expect(pub.options.replyMapping).toBe('legacy');
  });

  it('delivers a pub/sub round-trip using the strategy\'s exact pattern', async () => {
    if (!reachable) return;
    const payload = JSON.stringify({ scope: 'global', tenantId: 't1', event: { id: 'e1' } });

    const received = await new Promise<{ channel: string; message: string }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('no message delivered within 5s')),
          5_000,
        );
        // ioredis types this as `Callback<unknown>`, whose `err` admits
        // `undefined` as well as `Error | null` — match it exactly.
        sub.subscribe(CHANNEL, (err?: Error | null) => {
          if (err) {
            clearTimeout(timer);
            reject(err);
            return;
          }
          sub.on('message', (channel: string, message: string) => {
            clearTimeout(timer);
            resolve({ channel, message });
          });
          void pub.publish(CHANNEL, payload);
        });
      },
    );

    expect(received.channel).toBe(CHANNEL);
    expect(received.message).toBe(payload);
    // Under RESP3 pub/sub uses push frames, but ioredis keeps `mode` normal —
    // the strategy never inspects `mode`, and this pins that assumption.
    expect(sub.mode).toBe('normal');
  });

  it('returns the 2-element array RedisQuotaStore.increment expects', async () => {
    if (!reachable) return;
    const key = `quota:live-test:${process.pid}`;
    await pub.del(key);

    const first = (await pub.eval(INCR_AND_EXPIRE_LUA, 1, key, 60)) as [number, number];
    expect(Array.isArray(first)).toBe(true);
    expect(first).toHaveLength(2);
    expect(first[0]).toBe(1);
    expect(first[1]).toBe(60);

    const second = (await pub.eval(INCR_AND_EXPIRE_LUA, 1, key, 60)) as [number, number];
    expect(second[0]).toBe(2);
    // TTL is counted down by the server, so assert a range rather than equality.
    expect(second[1]).toBeGreaterThan(0);
    expect(second[1]).toBeLessThanOrEqual(60);

    await pub.del(key);
  });
});
