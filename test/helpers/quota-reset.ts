/**
 * Clears quota counters from the shared Redis store (when `REDIS_URL` is set,
 * as in CI) so integration blocks that assert exact windowed counts don't
 * inherit a previous block's `acdp:quota:<tenant>:<action>` increments. With
 * the in-memory store (no REDIS_URL) every app instance starts empty and this
 * is a no-op.
 */
export async function resetQuotaCounters(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;
  const { default: Redis } = await import('ioredis');
  const client = new Redis(url);
  try {
    const keys = await client.keys('acdp:quota:*');
    if (keys.length > 0) await client.del(...keys);
  } finally {
    client.disconnect();
  }
}
