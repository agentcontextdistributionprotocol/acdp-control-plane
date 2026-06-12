import { ChallengeStore, signingInputFor } from './challenge-store.service';
import { InMemoryChallengeRepository } from './in-memory-challenge.repository';

describe('ChallengeStore (in-memory repo)', () => {
  let store: ChallengeStore;

  beforeEach(() => {
    store = new ChallengeStore(new InMemoryChallengeRepository());
  });

  it('issues a challenge with the canonical signing input', async () => {
    const rec = await store.issue('did:web:alice', 'cp.local', 60);
    // nonce is randomBytes(16) base64url-encoded → 22 url-safe chars.
    expect(rec.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(rec.agentDid).toBe('did:web:alice');
    expect(rec.registryAuthority).toBe('cp.local');
    expect(rec.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(rec.signingInput).toBe(
      signingInputFor(rec.nonce, 'did:web:alice', 'cp.local', rec.expiresAt),
    );
  });

  it('consume returns the record and deletes it (single-use)', async () => {
    const rec = await store.issue('did:web:alice', 'cp.local', 60);
    const got = await store.consume(rec.nonce);
    expect(got?.agentDid).toBe('did:web:alice');

    const second = await store.consume(rec.nonce);
    expect(second).toBeNull();
  });

  it('consume returns null for unknown nonces', async () => {
    expect(await store.consume('not-a-real-nonce')).toBeNull();
  });

  it('consume returns null for expired records', async () => {
    const rec = await store.issue('did:web:alice', 'cp.local', -1); // already expired
    expect(await store.consume(rec.nonce)).toBeNull();
  });

  it('size evicts expired records lazily', async () => {
    await store.issue('did:web:alice', 'cp.local', -10);
    await store.issue('did:web:bob', 'cp.local', 60);
    expect(await store.size()).toBe(1);
  });

  it('signingInputFor format pins the v1 prefix and order', () => {
    expect(signingInputFor('n', 'did:web:x', 'auth', 123)).toBe(
      'acdp-registry-auth:v1:n:did:web:x:auth:123',
    );
  });
});
