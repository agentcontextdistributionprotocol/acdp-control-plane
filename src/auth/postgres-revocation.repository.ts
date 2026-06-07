import { Injectable } from '@nestjs/common';
import { eq, lt, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { revokedTokens } from '../db/schema';
import {
  RevocationRecord,
  RevocationRepository,
} from './revocation-repository';

@Injectable()
export class PostgresRevocationRepository implements RevocationRepository {
  constructor(private readonly db: DatabaseService) {}

  async revoke(record: RevocationRecord): Promise<boolean> {
    // ON CONFLICT DO NOTHING so duplicate revocations are idempotent
    // and we don't leak the existence of a token via 409s. The
    // affected-row count tells us whether this was a new revocation.
    const result = await this.db.db.execute(
      sql`INSERT INTO revoked_tokens (jti, sub, iss, exp, revoked_by, reason)
          VALUES (${record.jti}, ${record.sub}, ${record.iss}, ${record.exp},
                  ${record.revokedBy}, ${record.reason})
          ON CONFLICT (jti) DO NOTHING
          RETURNING jti`,
    );
    return result.rows.length > 0;
  }

  async isRevoked(jti: string): Promise<boolean> {
    const result = await this.db.db.execute(
      sql`SELECT 1 FROM revoked_tokens
          WHERE jti = ${jti} AND exp > extract(epoch from now())
          LIMIT 1`,
    );
    return result.rows.length > 0;
  }

  async get(jti: string): Promise<RevocationRecord | null> {
    const rows = await this.db.db
      .select()
      .from(revokedTokens)
      .where(eq(revokedTokens.jti, jti))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      jti: row.jti,
      sub: row.sub,
      iss: row.iss,
      exp: Number(row.exp),
      revokedBy: row.revokedBy,
      reason: (row.reason ?? 'unspecified') as RevocationRecord['reason'],
      revokedAt: row.revokedAt ? new Date(row.revokedAt) : undefined,
    };
  }

  async evictExpired(): Promise<number> {
    const result = await this.db.db
      .delete(revokedTokens)
      .where(lt(revokedTokens.exp, nowSeconds()))
      .returning({ jti: revokedTokens.jti });
    return result.length;
  }

  async size(): Promise<number> {
    const result = await this.db.db.execute(
      sql`SELECT count(*)::int AS n FROM revoked_tokens
          WHERE exp > extract(epoch from now())`,
    );
    return (result.rows[0] as { n: number })?.n ?? 0;
  }

  async listSince(
    sinceMs: number,
    limit: number,
  ): Promise<{ entries: RevocationRecord[]; nextCursor: number | null }> {
    const cap = Math.max(1, Math.min(limit | 0, 500));
    // revoked_at is a microsecond-precision TIMESTAMP, but the cursor is
    // millisecond-granular. nextCursor below floors the final entry's timestamp
    // down to its millisecond, so the next poll's strict `revoked_at > cursor`
    // RE-FETCHES any same-millisecond entries that didn't fit this page (their
    // sub-ms component keeps them above the floored cursor) rather than skipping
    // them. Re-fetch is idempotent, so unlike the ms-granular in-memory store
    // this path cannot lose entries at a page boundary and needs no group
    // extension. Compare against to_timestamp(sinceMs/1000).
    const result = await this.db.db.execute(
      sql`SELECT jti, sub, iss, exp, revoked_by, reason, revoked_at
          FROM revoked_tokens
          WHERE revoked_at > to_timestamp(${sinceMs} / 1000.0)
          ORDER BY revoked_at ASC, jti ASC
          LIMIT ${cap}`,
    );
    type Row = {
      jti: string;
      sub: string;
      iss: string;
      exp: string | number;
      revoked_by: string;
      reason: string | null;
      revoked_at: string;
    };
    const entries: RevocationRecord[] = (result.rows as Row[]).map((row) => ({
      jti: row.jti,
      sub: row.sub,
      iss: row.iss,
      exp: Number(row.exp),
      revokedBy: row.revoked_by,
      reason: (row.reason ?? 'unspecified') as RevocationRecord['reason'],
      revokedAt: new Date(row.revoked_at),
    }));
    const nextCursor =
      entries.length === cap
        ? (entries[entries.length - 1].revokedAt?.getTime() ?? null)
        : null;
    return { entries, nextCursor };
  }

  async getRevocationCursor(issuer: string): Promise<number | null> {
    const result = await this.db.db.execute(
      sql`SELECT cursor_ms FROM revocation_cursors WHERE issuer = ${issuer} LIMIT 1`,
    );
    const row = result.rows[0] as { cursor_ms: string | number } | undefined;
    if (!row) return null;
    const n = Number(row.cursor_ms);
    return Number.isFinite(n) ? n : null;
  }

  async setRevocationCursor(issuer: string, cursorMs: number): Promise<void> {
    await this.db.db.execute(
      sql`INSERT INTO revocation_cursors (issuer, cursor_ms, updated_at)
          VALUES (${issuer}, ${cursorMs}, now())
          ON CONFLICT (issuer)
          DO UPDATE SET cursor_ms = EXCLUDED.cursor_ms, updated_at = now()`,
    );
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
