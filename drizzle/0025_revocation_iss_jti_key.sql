-- 0025 — revocation deny-list is keyed by (iss, jti), not jti alone (#232)
--
-- A jti is only unique WITHIN an issuer. Keyed on jti alone, a peer feed entry
-- (or any writer) carrying a jti that collides with another issuer's token
-- would deny-list that token. `iss` is already NOT NULL on every row, so the
-- composite key needs no backfill.
--
-- Rollback hazard: builds older than this migration issue
-- `ON CONFLICT (jti) DO NOTHING`, which has no matching unique constraint after
-- this change and errors — revoke() would fail on a rolled-back build.

ALTER TABLE revoked_tokens DROP CONSTRAINT IF EXISTS revoked_tokens_pkey;
ALTER TABLE revoked_tokens ADD PRIMARY KEY (iss, jti);
