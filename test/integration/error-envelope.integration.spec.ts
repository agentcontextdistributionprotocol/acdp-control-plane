import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';

/**
 * GlobalExceptionFilter contract over real HTTP (RFC-ACDP-0007 §4): every
 * error body ships as `application/acdp+json`, AppExceptions carry both the
 * legacy `{statusCode, errorCode, message}` fields AND the additive ACDP
 * `{error: {code, message}}` envelope, and framework-generated errors still
 * pass through the filter with the ACDP media type.
 */
describe('Error envelope (integration)', () => {
  let ctx: TestAppContext;
  let client: TestClient;

  beforeAll(async () => {
    ctx = await createTestApp({ apiKey: 'error-envelope-key' });
    client = ctx.client;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('AppException → acdp+json body with errorCode AND the ACDP error envelope', async () => {
    const res = await client.requestRaw(
      'GET',
      '/registries/no-such-authority.example/log-witness',
    );

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/acdp+json');
    const body = res.body as Record<string, unknown>;
    // Legacy CP fields — existing consumers key on these.
    expect(body.statusCode).toBe(404);
    expect(body.errorCode).toBe('REGISTRY_NOT_FOUND');
    expect(typeof body.message).toBe('string');
    // Additive ACDP envelope — federation consumers key on error.code.
    expect(body.error).toMatchObject({ code: 'REGISTRY_NOT_FOUND' });
  });

  it('framework 401 (missing credentials) still ships as acdp+json', async () => {
    const noAuth = new TestClient(ctx.url);
    const res = await noAuth.requestRaw('GET', '/runs');

    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/acdp+json');
    const body = res.body as Record<string, unknown>;
    expect(body.statusCode).toBe(401);
    // #182: an unlabelled 401 names itself, never the retryable INTERNAL_ERROR.
    expect(body.errorCode).toBe('UNAUTHORIZED');
    expect(body.error).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('validation failure (bad query DTO) returns 400 as acdp+json with a message array', async () => {
    const res = await client.requestRaw('GET', '/runs', {
      query: { limit: 'not-a-number' },
    });

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/acdp+json');
    const body = res.body as Record<string, unknown>;
    expect(body.statusCode).toBe(400);
    expect(body.message).toBeDefined();
  });

  it('unknown route 404s as acdp+json (filter catches framework NotFound)', async () => {
    const res = await client.requestRaw('GET', '/definitely-not-a-route');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/acdp+json');
    const body = res.body as Record<string, unknown>;
    expect(body.errorCode).toBe('NOT_FOUND');
    expect(body.error).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('over-limit JSON body → 413 PAYLOAD_TOO_LARGE, not a 500 (#182 defect 3)', async () => {
    // body-parser's PayloadTooLargeError is an http-errors object (status 413,
    // expose true), not an HttpException; before #182 it fell through the
    // filter's unhandled-exception branch as a 500 INTERNAL_ERROR.
    const res = await client.requestRaw('POST', '/ingest/acdp', {
      rawBody: JSON.stringify({ padding: 'x'.repeat(1_100_000) }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toContain('application/acdp+json');
    const body = res.body as Record<string, unknown>;
    expect(body.statusCode).toBe(413);
    expect(body.errorCode).toBe('PAYLOAD_TOO_LARGE');
    expect(body.error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});

/**
 * The coarse per-principal throttle (`ThrottleByUserGuard`, a
 * `@nestjs/throttler` subclass) throws a STRING-bodied ThrottlerException;
 * the filter's string branch used to hardcode INTERNAL_ERROR (#182 defect 2).
 * Own describe + own app so the low limit cannot leak into other cases.
 */
describe('Error envelope — throttler 429 (integration)', () => {
  let ctx: TestAppContext;
  const prevLimit = process.env.THROTTLE_LIMIT;

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '2';
    ctx = await createTestApp({ apiKey: 'error-envelope-throttle-key' });
  });

  afterAll(async () => {
    await ctx.app.close();
    if (prevLimit === undefined) delete process.env.THROTTLE_LIMIT;
    else process.env.THROTTLE_LIMIT = prevLimit;
  });

  it('throttled request → 429 RATE_LIMITED with a positive Retry-After', async () => {
    let res = await ctx.client.requestRaw('GET', '/runs');
    for (let i = 0; i < 5 && res.status !== 429; i++) {
      res = await ctx.client.requestRaw('GET', '/runs');
    }

    expect(res.status).toBe(429);
    expect(res.headers['content-type']).toContain('application/acdp+json');
    const body = res.body as Record<string, unknown>;
    expect(body.statusCode).toBe(429);
    expect(body.errorCode).toBe('RATE_LIMITED');
    expect(body.error).toMatchObject({ code: 'RATE_LIMITED' });
    const retryAfter = Number(res.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });
});
