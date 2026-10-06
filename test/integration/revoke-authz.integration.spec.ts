// MUST be first: TOKEN_ISSUANCE_ENABLED is read when AppModule is evaluated.
import '../helpers/enable-token-issuance';
import jwt from 'jsonwebtoken';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';

/**
 * POST /auth/token/revoke must authorize only on VERIFIED claims (#229).
 * Caller + victim are federated peer tokens (the CP can only self-verify its
 * own tokens, so a peer token always takes the unverified-decode path).
 */
const LOCAL_SECRET = 'local-revoke-integration-secret-0123456789';
const PEER_SECRET = 'P'.repeat(40);
const ADMIN_KEY = 'admin-key-revoke';

function peerToken(sub: string, jti: string, secret = PEER_SECRET): string {
  return jwt.sign({ sub, aud: 'peer.example', jti }, secret, {
    algorithm: 'HS256',
    issuer: 'peer',
    expiresIn: 300,
  });
}

describe('Revoke authorization (integration, #229)', () => {
  let ctx: TestAppContext;
  let admin: TestClient;
  let attacker: TestClient;
  let victimClient: TestClient;

  beforeAll(async () => {
    ctx = await createTestApp({
      apiKey: 'plain-key',
      adminApiKey: ADMIN_KEY,
      trustedIssuers: `peer|HS256|${PEER_SECRET}|peer.example`,
      tokenIssuance: { jwtSecret: LOCAL_SECRET, authority: 'cp.test' },
    });
    admin = new TestClient(ctx.url, ADMIN_KEY);
    attacker = new TestClient(ctx.url, peerToken('did:web:mallory', 'jti-mallory'));
    victimClient = new TestClient(ctx.url, peerToken('did:web:victim', 'jti-victim'));
  });

  afterAll(async () => {
    delete process.env.TOKEN_ISSUANCE_ENABLED;
    delete process.env.TRUSTED_ISSUERS;
    await ctx.app.close();
  });

  const active = async (token: string) => {
    const res = await admin.requestRaw('POST', '/auth/introspect', { body: { token } });
    return (res.body as any).active as boolean;
  };

  it('a forged token (sub = caller, jti = victim) does not deny-list the victim', async () => {
    const victimTok = peerToken('did:web:victim', 'jti-victim');
    expect(await active(victimTok)).toBe(true);

    // Unsigned/wrong-key forgery: sub is the attacker's own, jti is the victim's.
    const forged = peerToken('did:web:mallory', 'jti-victim', 'X'.repeat(40));
    const res = await attacker.requestRaw('POST', '/auth/token/revoke', { body: { token: forged } });
    expect(res.status).toBe(200);
    expect((res.body as any).revoked).toBe(false);

    expect(await active(victimTok)).toBe(true); // victim unaffected
  });

  it('an unverifiable peer token is also not self-revocable by its owner (admin only)', async () => {
    const tok = peerToken('did:web:victim', 'jti-own');
    const res = await victimClient.requestRaw('POST', '/auth/token/revoke', { body: { token: tok } });
    expect(res.status).toBe(200);
    expect((res.body as any).revoked).toBe(false);
    expect(await active(tok)).toBe(true);
  });

  it('an admin can still deny-list it', async () => {
    const tok = peerToken('did:web:victim', 'jti-admin-revoked');
    expect(await active(tok)).toBe(true);
    const res = await admin.requestRaw('POST', '/auth/token/revoke', { body: { token: tok } });
    expect(res.status).toBe(200);
    expect((res.body as any).revoked).toBe(true);
    expect(await active(tok)).toBe(false);
  });
});
