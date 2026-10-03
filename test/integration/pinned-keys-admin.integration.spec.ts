import { generateKeyPairSync } from 'node:crypto';
import { createTestApp, TestAppContext } from '../helpers/test-app';

function freshKeyPub(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return Buffer.from(spki.subarray(spki.length - 32)).toString('base64');
}

describe('POST /admin/pinned-keys/reload (integration)', () => {
  let ctx: TestAppContext;
  const ADMIN_KEY = 'admin-test-key';
  const USER_KEY = 'user-test-key';

  beforeAll(async () => {
    // Seed: one key for alice. The reload test mutates this var.
    process.env.CONTROL_PLANE_PINNED_KEYS = `did:web:alice=${freshKeyPub()}`;
    ctx = await createTestApp({ apiKey: USER_KEY, adminApiKey: ADMIN_KEY });
  });

  afterAll(async () => {
    await ctx.app.close();
    delete process.env.CONTROL_PLANE_PINNED_KEYS;
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  it('rejects non-admin callers with 403', async () => {
    // The TestClient uses USER_KEY by default; it's a valid api-key but
    // NOT in the admin list, so the guard sets actorIsAdmin=false.
    const res = await ctx.client.requestRaw('POST', '/admin/pinned-keys/reload');
    expect(res.status).toBe(403);
    expect((res.body as { errorCode: string }).errorCode).toBe('ADMIN_REQUIRED');
    expect((res.body as { message: string }).message).toBe('pinned-keys reload is admin-only');
  });

  it('rejects unauthenticated callers with 401', async () => {
    const res = await ctx.client.requestRaw('POST', '/admin/pinned-keys/reload', {
      headers: { Authorization: '' },
    });
    expect(res.status).toBe(401);
  });

  it('admin caller swaps the directory live', async () => {
    // Mutate env to add bob; reload should pick it up.
    process.env.CONTROL_PLANE_PINNED_KEYS =
      `did:web:alice=${freshKeyPub()},did:web:bob=${freshKeyPub()}`;
    const res = await ctx.client.requestRaw('POST', '/admin/pinned-keys/reload', {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, count: 2 });
  });

  it('admin caller can drain the directory by emptying the env var', async () => {
    process.env.CONTROL_PLANE_PINNED_KEYS = '';
    const res = await ctx.client.requestRaw('POST', '/admin/pinned-keys/reload', {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, count: 0 });
  });
});
