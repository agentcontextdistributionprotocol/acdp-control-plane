import { Injectable } from '@nestjs/common';
import {
  RevocationRecord,
  RevocationRepository,
} from './revocation-repository';

@Injectable()
export class InMemoryRevocationRepository implements RevocationRepository {
  private readonly store = new Map<string, RevocationRecord>();
  private readonly cursors = new Map<string, number>();

  async revoke(record: RevocationRecord): Promise<boolean> {
    if (this.store.has(record.jti)) return false;
    this.store.set(record.jti, { ...record, revokedAt: record.revokedAt ?? new Date() });
    return true;
  }

  async isRevoked(jti: string): Promise<boolean> {
    const rec = this.store.get(jti);
    if (!rec) return false;
    if (rec.exp < nowSeconds()) {
      // Lazy eviction — JWT verification will reject expired tokens
      // anyway; the entry no longer needs to occupy the deny-list.
      this.store.delete(jti);
      return false;
    }
    return true;
  }

  async get(jti: string): Promise<RevocationRecord | null> {
    return this.store.get(jti) ?? null;
  }

  async evictExpired(): Promise<number> {
    const now = nowSeconds();
    let evicted = 0;
    for (const [jti, rec] of this.store) {
      if (rec.exp < now) {
        this.store.delete(jti);
        evicted++;
      }
    }
    return evicted;
  }

  async size(): Promise<number> {
    await this.evictExpired();
    return this.store.size;
  }

  async listSince(
    sinceMs: number,
    limit: number,
  ): Promise<{ entries: RevocationRecord[]; nextCursor: number | null }> {
    const cap = Math.max(1, Math.min(limit | 0, 500));
    const sorted = Array.from(this.store.values())
      .filter((r) => (r.revokedAt?.getTime() ?? 0) > sinceMs)
      .sort((a, b) => {
        const at = a.revokedAt?.getTime() ?? 0;
        const bt = b.revokedAt?.getTime() ?? 0;
        if (at !== bt) return at - bt;
        return a.jti.localeCompare(b.jti);
      });
    const entries = sorted.slice(0, cap);
    // Never split one millisecond across a page boundary. The cursor is
    // millisecond-granular and the next poll queries `revoked_at > cursor`
    // (strict), so any entry sharing the final entry's millisecond that didn't
    // fit in the page would be skipped forever. `Date` is ms-precision, so a
    // burst of >cap revocations in the same millisecond is the (improbable, but
    // real) trigger. Extend the page to include the whole final-ms group so the
    // strict-`>` cursor lands cleanly past it. (Postgres stores microsecond
    // revoked_at, so its ms-floored cursor re-fetches rather than skips — it
    // cannot lose entries and needs no equivalent extension.)
    if (entries.length === cap && sorted.length > cap) {
      const boundaryMs = entries[entries.length - 1].revokedAt?.getTime() ?? 0;
      for (let i = cap; i < sorted.length; i++) {
        if ((sorted[i].revokedAt?.getTime() ?? 0) !== boundaryMs) break;
        entries.push(sorted[i]);
      }
    }
    const nextCursor =
      entries.length < sorted.length
        ? (entries[entries.length - 1].revokedAt?.getTime() ?? null)
        : null;
    return { entries, nextCursor };
  }

  async getRevocationCursor(issuer: string): Promise<number | null> {
    return this.cursors.get(issuer) ?? null;
  }

  async setRevocationCursor(issuer: string, cursorMs: number): Promise<void> {
    this.cursors.set(issuer, cursorMs);
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
