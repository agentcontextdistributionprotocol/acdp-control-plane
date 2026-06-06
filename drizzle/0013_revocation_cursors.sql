-- 0013_revocation_cursors.sql
-- Durable per-issuer cursor for the cross-issuer revocation poller
-- (RevocationPollerService). The CP polls each configured peer's
-- /auth/revocations feed and applies propagated revocations locally; this
-- table records the unix-ms `revoked_at` of the last applied entry per issuer
-- so a restart resumes where it left off instead of re-fetching from since=0.
-- Mirrors the registry's per-issuer revocation cursor.

CREATE TABLE IF NOT EXISTS revocation_cursors (
  issuer     text PRIMARY KEY,
  cursor_ms  bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
