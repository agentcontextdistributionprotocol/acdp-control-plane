/**
 * Quota counter storage abstraction.
 *
 * Two backends:
 *   - `InMemoryQuotaStore`: process-local Map<key, {count, expiresAt}>.
 *     Correct only for single-process deployments. Good for tests and
 *     local dev.
 *   - `RedisQuotaStore`: shared counters via `INCR` + `EXPIRE NX`.
 *     The atomic INCR + a one-shot EXPIRE makes the count and TTL
 *     a single round-trip, eliminating the race where two callers
 *     INCR before either EXPIREs.
 *
 * Both backends fail OPEN — if the store is unreachable, requests
 * proceed without quota enforcement. A Redis outage MUST NOT take
 * down the control plane. The QuotaGuard logs at warn level when
 * fail-open fires so operators can spot the gap.
 */

export interface QuotaIncrementResult {
  /** Current count INCLUSIVE of this call's increment. */
  count: number;
  /** TTL of the bucket (seconds remaining). */
  ttlSeconds: number;
}

export interface QuotaStore {
  /**
   * Atomically increment `key`'s counter and ensure it has an expiry
   * of `windowSeconds`. Returns the new count + remaining TTL.
   *
   * Implementations MUST NOT throw on transport failure — wrap and
   * return a sentinel (we use `{count: 0, ttlSeconds: 0}` meaning
   * "store unavailable; fail open").
   */
  increment(key: string, windowSeconds: number): Promise<QuotaIncrementResult>;
}

/** Process-local store. Lost on restart. */
export class InMemoryQuotaStore implements QuotaStore {
  private readonly buckets = new Map<string, { count: number; expiresAt: number }>();

  async increment(
    key: string,
    windowSeconds: number,
  ): Promise<QuotaIncrementResult> {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (!existing || existing.expiresAt <= now) {
      const fresh = { count: 1, expiresAt: now + windowSeconds * 1000 };
      this.buckets.set(key, fresh);
      return { count: 1, ttlSeconds: windowSeconds };
    }
    existing.count++;
    return {
      count: existing.count,
      ttlSeconds: Math.max(1, Math.ceil((existing.expiresAt - now) / 1000)),
    };
  }
}

/**
 * Redis-backed store. Uses a Lua script for atomic INCR + EXPIRE NX,
 * so the first increment in a window sets the TTL and subsequent
 * increments leave it alone (otherwise every INCR + EXPIRE pair
 * resets the window, defeating the rate limit).
 *
 * The `ioredis` import is duck-typed so we don't have to put it
 * in `dependencies` (the SSE strategy already does that).
 */
export class RedisQuotaStore implements QuotaStore {
  private static readonly INCR_AND_EXPIRE_LUA = `
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

  constructor(
    private readonly redis: {
      eval: (script: string, numKeys: number, ...args: (string | number)[]) => Promise<unknown>;
      quit: () => Promise<unknown>;
    },
    private readonly logger?: { warn: (msg: string) => void },
  ) {}

  /**
   * Release the connection. An ioredis client is long-lived and keeps Node's
   * event loop alive, so without this a process that configured quotas never
   * exits cleanly — `QuotaModule.onModuleDestroy` calls this on shutdown.
   * Never throws: shutdown must not be blocked by a failing transport.
   */
  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch (e) {
      this.logger?.warn(
        `redis quota quit failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async increment(
    key: string,
    windowSeconds: number,
  ): Promise<QuotaIncrementResult> {
    try {
      const result = (await this.redis.eval(
        RedisQuotaStore.INCR_AND_EXPIRE_LUA,
        1,
        key,
        windowSeconds,
      )) as [number | string, number | string] | null;
      if (!result || result.length !== 2) {
        return { count: 0, ttlSeconds: 0 };
      }
      return {
        count: Number(result[0]),
        ttlSeconds: Number(result[1]),
      };
    } catch (e) {
      this.logger?.warn(
        `quota store unavailable, failing open: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { count: 0, ttlSeconds: 0 };
    }
  }
}
