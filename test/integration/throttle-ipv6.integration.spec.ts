import { createTestApp, TestAppContext } from '../helpers/test-app';
import { RawResponse, TestClient } from '../helpers/test-client';

/**
 * Issue #187 over real HTTP: an unauthenticated IPv6 caller rotating source
 * addresses inside its own /64 must hit the coarse throttle (429
 * RATE_LIMITED + Retry-After) exactly as a single address would.
 *
 * The harness listens on loopback, so the client address is supplied the
 * way a production deployment behind a reverse proxy supplies it: Express
 * `trust proxy` (trusting only the loopback hop) + `X-Forwarded-For`. The
 * guard sees the resolved `req.ip` either way — this test proves the full
 * request → ThrottleByUserGuard → storage → GlobalExceptionFilter path, and
 * (second describe) that THROTTLE_IPV6_SUBNET_PREFIX reaches the guard
 * through ThrottlerModule's object-form options.
 *
 * The throttled public route is `GET /ingest/health` (`@Public()`, static):
 * the probes `/healthz` / `/readyz` are `@SkipThrottle()` since #210, so they
 * can no longer stand in for "an unauthenticated, throttled route".
 */

const LIMIT = 3;
const ROTATING_64 = [
  '2001:db8:abcd:12::1',
  '2001:db8:abcd:12::2',
  '2001:db8:abcd:12:ffff:ffff:ffff:fffe',
  '2001:db8:abcd:12:1234:5678:9abc:def0',
  '2001:db8:abcd:12::beef',
  '2001:db8:abcd:12::cafe',
];

function from(ip: string): { headers: Record<string, string> } {
  return { headers: { 'X-Forwarded-For': ip } };
}

async function bootWithThrottleEnv(
  apiKey: string,
  env: Record<string, string>,
): Promise<{ ctx: TestAppContext; restore: () => void }> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  const ctx = await createTestApp({ apiKey, trustProxy: 'loopback' });
  return {
    ctx,
    restore: () => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

function expectRateLimited(res: RawResponse): void {
  expect(res.status).toBe(429);
  const body = res.body as Record<string, unknown>;
  expect(body.errorCode).toBe('RATE_LIMITED');
  expect(body.error).toMatchObject({ code: 'RATE_LIMITED' });
  const retryAfter = Number(res.headers['retry-after']);
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThan(0);
}

describe('Throttle — IPv6 /64 rotation (issue #187, integration)', () => {
  let ctx: TestAppContext;
  let restore: () => void;
  let anon: TestClient;

  beforeAll(async () => {
    ({ ctx, restore } = await bootWithThrottleEnv('throttle-ipv6-key', {
      THROTTLE_LIMIT: String(LIMIT),
      THROTTLE_IPV6_SUBNET_PREFIX: '64',
    }));
    // No Authorization header: a @Public() route then has no actorId and
    // the guard keys on the (normalized) client IP.
    anon = new TestClient(ctx.url);
  });

  afterAll(async () => {
    await ctx.app.close();
    restore();
  });

  it('a caller rotating addresses within one /64 is throttled at the limit', async () => {
    const statuses: number[] = [];
    let last: RawResponse | undefined;
    for (const ip of ROTATING_64) {
      last = await anon.requestRaw('GET', '/ingest/health', from(ip));
      statuses.push(last.status);
    }
    // First LIMIT distinct addresses pass, every later one is refused —
    // were each address its own bucket, all six would be 200.
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
    expectRateLimited(last!);
  });

  it('a different /64 keeps its own bucket', async () => {
    const res = await anon.requestRaw('GET', '/ingest/health', from('2001:db8:abcd:13::1'));
    expect(res.status).toBe(200);
  });

  it('IPv4-mapped IPv6 shares the plain IPv4 bucket', async () => {
    const seq = ['192.0.2.7', '::ffff:192.0.2.7', '::ffff:c000:207', '192.0.2.7'];
    const statuses: number[] = [];
    for (const ip of seq) {
      statuses.push((await anon.requestRaw('GET', '/ingest/health', from(ip))).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('authenticated callers stay keyed on the principal, not the address', async () => {
    // Rotating across DIFFERENT /64s does not reset an authenticated
    // caller's bucket: the tracker is the actorId.
    const ips = ['2001:db8:1:1::1', '2001:db8:2:2::1', '2001:db8:3:3::1', '2001:db8:4:4::1'];
    const statuses: number[] = [];
    let last: RawResponse | undefined;
    for (const ip of ips) {
      last = await ctx.client.requestRaw('GET', '/runs', from(ip));
      statuses.push(last.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expectRateLimited(last!);
  });
});

describe('Throttle — THROTTLE_IPV6_SUBNET_PREFIX=128 (knob wiring, integration)', () => {
  let ctx: TestAppContext;
  let restore: () => void;

  beforeAll(async () => {
    ({ ctx, restore } = await bootWithThrottleEnv('throttle-ipv6-128-key', {
      THROTTLE_LIMIT: String(LIMIT),
      THROTTLE_IPV6_SUBNET_PREFIX: '128',
    }));
  });

  afterAll(async () => {
    await ctx.app.close();
    restore();
  });

  it('per-address buckets: the same rotation is NOT throttled', async () => {
    const anon = new TestClient(ctx.url);
    const statuses: number[] = [];
    for (const ip of ROTATING_64) {
      statuses.push((await anon.requestRaw('GET', '/ingest/health', from(ip))).status);
    }
    expect(statuses).toEqual(ROTATING_64.map(() => 200));
  });
});
