import { InMemoryRevocationRepository } from './in-memory-revocation.repository';
import { RevocationRecord } from './revocation-repository';
import { runRevocationRepositoryContract } from './revocation-repository.contract';

describe('InMemoryRevocationRepository', () => {
  runRevocationRepositoryContract(async () => new InMemoryRevocationRepository());

  describe('listSince page-boundary handling', () => {
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    function rec(jti: string, revokedAtMs: number): RevocationRecord {
      return {
        jti,
        sub: 'did:web:alice',
        iss: 'cp.test',
        exp: expSec,
        revokedBy: 'unit-test',
        reason: 'admin_revoke',
        revokedAt: new Date(revokedAtMs),
      };
    }

    it('never splits a single millisecond across a page boundary (no lost entries)', async () => {
      const repo = new InMemoryRevocationRepository();
      // Three revocations share one millisecond; a fourth is later. With a
      // page size of 2 the millisecond group straddles the boundary.
      await repo.revoke(rec('a', 1000));
      await repo.revoke(rec('b', 1000));
      await repo.revoke(rec('c', 1000));
      await repo.revoke(rec('d', 2000));

      const page1 = await repo.listSince(0, 2);
      // Page is extended past the nominal cap of 2 to include the whole 1000ms
      // group, so the strict-`>` cursor can advance cleanly past it.
      expect(page1.entries.map((e) => e.jti)).toEqual(['a', 'b', 'c']);
      expect(page1.nextCursor).toBe(1000);

      const page2 = await repo.listSince(page1.nextCursor!, 2);
      expect(page2.entries.map((e) => e.jti)).toEqual(['d']);
      expect(page2.nextCursor).toBeNull();

      // Every revocation is delivered exactly once across the two pages.
      const all = [...page1.entries, ...page2.entries].map((e) => e.jti).sort();
      expect(all).toEqual(['a', 'b', 'c', 'd']);
    });

    it('returns null nextCursor when the page exhausts the feed', async () => {
      const repo = new InMemoryRevocationRepository();
      await repo.revoke(rec('a', 1000));
      await repo.revoke(rec('b', 2000));
      const page = await repo.listSince(0, 200);
      expect(page.entries.map((e) => e.jti)).toEqual(['a', 'b']);
      expect(page.nextCursor).toBeNull();
    });
  });
});
