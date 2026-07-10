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
    expect((res.body as Record<string, unknown>).statusCode).toBe(401);
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
  });
});
