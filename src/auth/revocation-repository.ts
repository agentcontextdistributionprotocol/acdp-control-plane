/**
 * Storage abstraction for revoked-token records.
 *
 * A JWT whose `jti` lives in this store is treated as invalid by
 * `TokenIssuer.verifyJwt` (and any downstream guards that consult the
 * repository) even if its `exp` hasn't passed. Once `exp` passes,
 * ordinary JWT verification rejects the token anyway, so the entry
 * becomes safe to evict — the `RevocationSweeper` runs that cleanup.
 *
 * Two implementations are wired up by `AuthModule` based on the
 * `AUTH_PERSISTENCE` env var, mirroring the challenge store choice.
 */

export type RevocationReason =
  | 'user_logout'
  | 'admin_revoke'
  | 'key_rotation'
  | 'security_incident'
  | 'unspecified';

export interface RevocationRecord {
  jti: string;
  sub: string;
  iss: string;
  /** Unix seconds. */
  exp: number;
  revokedBy: string;
  reason: RevocationReason;
  revokedAt?: Date;
}

export interface RevocationRepository {
  /**
   * Mark a token as revoked. Returns true if the token was newly
   * revoked, false if it was already in the store (idempotent).
   */
  revoke(record: RevocationRecord): Promise<boolean>;

  /** Return true if the `jti` is currently revoked. */
  isRevoked(jti: string): Promise<boolean>;

  /** Look up a revocation record (for introspection / audit). */
  get(jti: string): Promise<RevocationRecord | null>;

  /** Best-effort sweep of records whose `exp` has passed. */
  evictExpired(): Promise<number>;

  /** Live entry count (for diagnostics). */
  size(): Promise<number>;

  /**
   * Cross-issuer revocation feed (Phase-5 plan §9 follow-up).
   *
   * Returns revocations whose `revokedAt > sinceMs`, ordered by
   * `revokedAt ASC, jti ASC` for deterministic pagination. `limit` is
   * clamped to a sane upper bound by the implementation. Returns the
   * next cursor (`revokedAt|jti` of the last entry) when the result
   * set is at least `limit` rows — `null` otherwise.
   *
   * Peers consume this via `GET /auth/revocations?since=...&limit=...`
   * and apply the entries into their local revocation store, so a
   * token revoked at the issuer is rejected at every consuming
   * registry without requiring shared state.
   */
  listSince(
    sinceMs: number,
    limit: number,
  ): Promise<{ entries: RevocationRecord[]; nextCursor: number | null }>;

  /**
   * Durable per-issuer cursor for the cross-issuer revocation poller
   * (`RevocationPollerService`). Returns the last persisted unix-ms cursor
   * for `issuer`, or `null` when none is stored — in which case the poller
   * starts at 0 (a one-time full re-fetch; `revoke()` is idempotent so this
   * is harmless). Mirrors the registry's `get/set_revocation_cursor`.
   */
  getRevocationCursor(issuer: string): Promise<number | null>;

  /** Persist the per-issuer poll cursor (unix-ms). */
  setRevocationCursor(issuer: string, cursorMs: number): Promise<void>;
}

export const REVOCATION_REPOSITORY = Symbol('REVOCATION_REPOSITORY');
