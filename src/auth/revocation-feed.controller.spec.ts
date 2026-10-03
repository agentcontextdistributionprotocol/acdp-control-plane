import { InMemoryRevocationRepository } from './in-memory-revocation.repository';
import { ErrorCode } from '../errors/error-codes';
import { RevocationFeedController } from './revocation-feed.controller';
import type { Request } from 'express';

describe('RevocationFeedController', () => {
  let repo: InMemoryRevocationRepository;
  let controller: RevocationFeedController;

  beforeEach(async () => {
    repo = new InMemoryRevocationRepository();
    // Seed three revocations at known times so the cursor pagination
    // is deterministic.
    const baseMs = 1_700_000_000_000;
    await repo.revoke({
      jti: 'j1',
      sub: 'did:web:alice',
      iss: 'cp.local',
      exp: 9_999_999_999,
      revokedBy: 'admin',
      reason: 'admin_revoke',
      revokedAt: new Date(baseMs + 1000),
    });
    await repo.revoke({
      jti: 'j2',
      sub: 'did:web:bob',
      iss: 'cp.local',
      exp: 9_999_999_999,
      revokedBy: 'admin',
      reason: 'admin_revoke',
      revokedAt: new Date(baseMs + 2000),
    });
    await repo.revoke({
      jti: 'j3',
      sub: 'did:web:carol',
      iss: 'cp.local',
      exp: 9_999_999_999,
      revokedBy: 'admin',
      reason: 'admin_revoke',
      revokedAt: new Date(baseMs + 3000),
    });
    controller = new RevocationFeedController(repo);
  });

  function adminReq() {
    return { actorIsAdmin: true } as unknown as Request & { actorIsAdmin?: boolean };
  }

  function nonAdminReq() {
    return { actorIsAdmin: false } as unknown as Request & { actorIsAdmin?: boolean };
  }

  it('403s non-admin callers (feed is admin-only)', async () => {
    await expect(controller.feed(nonAdminReq())).rejects.toMatchObject({ errorCode: ErrorCode.ADMIN_REQUIRED, status: 403 });
  });

  it('returns all entries when called with since=0 (admin)', async () => {
    const out = await controller.feed(adminReq(), '0', '10');
    expect(out.entries.map((e) => e.jti)).toEqual(['j1', 'j2', 'j3']);
    expect(out.next_cursor).toBeNull();
  });

  it('paginates with cursor when limit < total', async () => {
    const page1 = await controller.feed(adminReq(), '0', '2');
    expect(page1.entries.map((e) => e.jti)).toEqual(['j1', 'j2']);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = await controller.feed(
      adminReq(),
      String(page1.next_cursor),
      '2',
    );
    expect(page2.entries.map((e) => e.jti)).toEqual(['j3']);
    expect(page2.next_cursor).toBeNull();
  });

  it('cursor strictly excludes the previous boundary (no double-counting)', async () => {
    const out = await controller.feed(
      adminReq(),
      String(1_700_000_000_000 + 2000), // exact revokedAt of j2
      '10',
    );
    expect(out.entries.map((e) => e.jti)).toEqual(['j3']);
  });

  it('serializes the record shape the peer expects', async () => {
    const out = await controller.feed(adminReq(), '0', '1');
    const e = out.entries[0];
    expect(e).toEqual({
      jti: 'j1',
      sub: 'did:web:alice',
      iss: 'cp.local',
      exp: 9_999_999_999,
      revoked_at_ms: 1_700_000_000_000 + 1000,
    });
  });

  it('treats bogus query params as defaults (0, 200)', async () => {
    const out = await controller.feed(adminReq(), 'abc', 'xyz');
    expect(out.entries.length).toBe(3);
  });
});
