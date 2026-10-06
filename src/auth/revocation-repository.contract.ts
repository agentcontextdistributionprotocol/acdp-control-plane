/**
 * Shared contract test suite for any RevocationRepository implementation.
 */
import {
  RevocationRecord,
  RevocationRepository,
} from './revocation-repository';

function record(overrides: Partial<RevocationRecord> = {}): RevocationRecord {
  const now = Math.floor(Date.now() / 1000);
  return {
    jti: overrides.jti ?? `j-${Math.random().toString(36).slice(2)}`,
    sub: overrides.sub ?? 'did:web:alice',
    iss: overrides.iss ?? 'cp.test',
    exp: overrides.exp ?? now + 60,
    revokedBy: overrides.revokedBy ?? 'unit-test',
    reason: overrides.reason ?? 'admin_revoke',
  };
}

export function runRevocationRepositoryContract(
  newRepo: () => Promise<RevocationRepository>,
): void {
  let repo: RevocationRepository;

  beforeEach(async () => {
    repo = await newRepo();
  });

  it('revoke returns true the first time, false on duplicate (idempotent)', async () => {
    const rec = record();
    expect(await repo.revoke(rec)).toBe(true);
    expect(await repo.revoke(rec)).toBe(false);
  });

  it('isRevoked returns true after revoke', async () => {
    const rec = record();
    await repo.revoke(rec);
    expect(await repo.isRevoked(rec.iss, rec.jti)).toBe(true);
  });

  it('is keyed by (iss, jti): the same jti under another issuer is independent (#232)', async () => {
    const a = record({ jti: 'shared-jti', iss: 'issuer-a' });
    expect(await repo.revoke(a)).toBe(true);
    expect(await repo.isRevoked('issuer-a', 'shared-jti')).toBe(true);
    expect(await repo.isRevoked('issuer-b', 'shared-jti')).toBe(false); // not revoked by A's entry
    expect(await repo.get('issuer-b', 'shared-jti')).toBeNull();
    // B can be revoked on its own; A's entry is untouched and both coexist.
    expect(await repo.revoke(record({ jti: 'shared-jti', iss: 'issuer-b' }))).toBe(true);
    expect(await repo.isRevoked('issuer-b', 'shared-jti')).toBe(true);
    expect(await repo.revoke(a)).toBe(false); // still idempotent per (iss, jti)
  });

  it('isRevoked returns false for unknown jtis', async () => {
    expect(await repo.isRevoked('cp.test', 'never-existed')).toBe(false);
  });

  it('isRevoked returns false for entries whose exp has passed', async () => {
    const rec = record({ exp: Math.floor(Date.now() / 1000) - 1 });
    await repo.revoke(rec);
    expect(await repo.isRevoked(rec.iss, rec.jti)).toBe(false);
  });

  it('get returns the stored record', async () => {
    const rec = record({ reason: 'security_incident', revokedBy: 'alice' });
    await repo.revoke(rec);
    const got = await repo.get(rec.iss, rec.jti);
    expect(got).not.toBeNull();
    expect(got?.reason).toBe('security_incident');
    expect(got?.revokedBy).toBe('alice');
    expect(got?.exp).toBe(rec.exp);
  });

  it('get returns null for unknown jtis', async () => {
    expect(await repo.get('cp.test', 'never-existed')).toBeNull();
  });

  it('evictExpired drops only entries whose exp has passed', async () => {
    const now = Math.floor(Date.now() / 1000);
    await repo.revoke(record({ jti: 'fresh', exp: now + 60 }));
    await repo.revoke(record({ jti: 'old-1', exp: now - 10 }));
    await repo.revoke(record({ jti: 'old-2', exp: now - 20 }));
    const evicted = await repo.evictExpired();
    expect(evicted).toBe(2);
    expect(await repo.isRevoked('cp.test', 'fresh')).toBe(true);
    expect(await repo.get('cp.test', 'old-1')).toBeNull();
  });

  it('size reflects live entries', async () => {
    const now = Math.floor(Date.now() / 1000);
    await repo.revoke(record({ jti: 'a', exp: now + 60 }));
    await repo.revoke(record({ jti: 'b', exp: now + 60 }));
    await repo.revoke(record({ jti: 'c', exp: now - 10 }));
    expect(await repo.size()).toBe(2);
  });

  it('getRevocationCursor returns null before any cursor is set', async () => {
    expect(await repo.getRevocationCursor('peer.example')).toBeNull();
  });

  it('setRevocationCursor persists and overwrites a per-issuer cursor', async () => {
    await repo.setRevocationCursor('peer.example', 1000);
    expect(await repo.getRevocationCursor('peer.example')).toBe(1000);
    await repo.setRevocationCursor('peer.example', 2500);
    expect(await repo.getRevocationCursor('peer.example')).toBe(2500);
  });

  it('tracks cursors independently per issuer', async () => {
    await repo.setRevocationCursor('a.example', 100);
    await repo.setRevocationCursor('b.example', 200);
    expect(await repo.getRevocationCursor('a.example')).toBe(100);
    expect(await repo.getRevocationCursor('b.example')).toBe(200);
  });
}
