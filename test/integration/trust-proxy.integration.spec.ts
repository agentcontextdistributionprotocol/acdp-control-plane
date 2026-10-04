import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';

/**
 * TRUST_PROXY over real HTTP. The harness listens on loopback, so the test
 * process IS the "proxy" hop: with `TRUST_PROXY=1` Express trusts exactly
 * that one hop and resolves `req.ip` to the RIGHTMOST `X-Forwarded-For`
 * entry; unset, `req.ip` is the loopback peer and the header is ignored.
 *
 * Observed through ThrottleByUserGuard's bucket on an unauthenticated
 * `@Public()` route with no `@Throttle` override (`GET /ingest/health`), so
 * the limit is THROTTLE_LIMIT. Each describe boots its own app → its own
 * in-memory throttle storage.
 */

const LIMIT = 3;
const ROUTE = '/ingest/health';

function from(xff: string): { headers: Record<string, string> } {
  return { headers: { 'X-Forwarded-For': xff } };
}

async function boot(
  apiKey: string,
  trustProxy: string | undefined,
): Promise<{ ctx: TestAppContext; restore: () => void }> {
  const prev = process.env.THROTTLE_LIMIT;
  process.env.THROTTLE_LIMIT = String(LIMIT);
  const ctx = await createTestApp({ apiKey, trustProxy });
  return {
    ctx,
    restore: () => {
      if (prev === undefined) delete process.env.THROTTLE_LIMIT;
      else process.env.THROTTLE_LIMIT = prev;
    },
  };
}

async function statuses(anon: TestClient, xffs: string[]): Promise<number[]> {
  const out: number[] = [];
  for (const xff of xffs) out.push((await anon.requestRaw('GET', ROUTE, from(xff))).status);
  return out;
}

describe('TRUST_PROXY=1 (integration)', () => {
  let ctx: TestAppContext;
  let restore: () => void;
  let anon: TestClient;

  beforeAll(async () => {
    ({ ctx, restore } = await boot('trust-proxy-1-key', '1'));
    anon = new TestClient(ctx.url);
  });

  afterAll(async () => {
    await ctx.app.close();
    restore();
  });

  // Ordered: (a) proves trust is ON in this app, which is what makes (b)'s
  // "leftmost spoof does not evade" meaningful rather than vacuous.
  it('(a) two distinct forwarded clients get distinct throttle buckets', async () => {
    const a = '198.51.100.1';
    expect(await statuses(anon, [a, a, a, a])).toEqual([200, 200, 200, 429]);
    // Client B is untouched by A's exhausted bucket.
    expect(await statuses(anon, ['198.51.100.2'])).toEqual([200]);
  });

  it('(b) only the trusted hop counts: rotating a leftmost spoof does not evade', async () => {
    const real = '198.51.100.9';
    const chain = ['6.6.6.1', '6.6.6.2', '6.6.6.3', '6.6.6.4'].map((spoof) => `${spoof}, ${real}`);
    expect(await statuses(anon, chain)).toEqual([200, 200, 200, 429]);
  });
});

describe('TRUST_PROXY unset (integration — default unchanged)', () => {
  let ctx: TestAppContext;
  let restore: () => void;

  beforeAll(async () => {
    ({ ctx, restore } = await boot('trust-proxy-off-key', undefined));
  });

  afterAll(async () => {
    await ctx.app.close();
    restore();
  });

  it('the harness left TRUST_PROXY cleared', () => {
    expect(process.env.TRUST_PROXY).toBeUndefined();
  });

  it('a spoofed X-Forwarded-For does NOT change the bucket', async () => {
    const anon = new TestClient(ctx.url);
    const spoofs = ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4'];
    // Were XFF honoured, four distinct "clients" would all get 200.
    expect(await statuses(anon, spoofs)).toEqual([200, 200, 200, 429]);
  });
});
