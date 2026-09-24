-- 0023_receipt_audit_revocation.sql
-- RFC-ACDP-0014 §7 — receipt-audit consumer semantics (Phase 14).
--
-- Adds the §7 compromise-boundary classification to receipt_audits. This is
-- a VERIFICATION VERDICT about the producer key's lifecycle, deliberately
-- separate from `discrepancies` (registry dishonesty) — RFC-ACDP-0014 §10:
-- "a §7 fail-closed is a verification verdict, not a wire condition." An
-- otherwise perfectly honest registry can serve a context signed by a key
-- its own producer has since revoked; that is not a discrepancy.
--
-- key_revocation_status: 'none' | 'pre_compromise' | 'revoked_at_or_after' |
--   'revoked_time_unverifiable' (enumerated in a comment, not a DB enum, per
--   house style). NOT NULL DEFAULT 'none' — every audited event gets a
--   determinate classification, including when the feature is disabled
--   (every row simply stays 'none', matching pre-phase behaviour bit for
--   bit on every pre-existing column).
--
-- key_revocation_trust_class: 'producer_signed' | 'registry_attested' of the
--   revocation(s) that established compromise_boundary below. Nullable, but
--   NEVER NULL when key_revocation_status <> 'none' — RFC-ACDP-0014 §6 is
--   explicit the two trust classes must never be collapsed into one
--   boolean or into key_revocation_status itself.
--
-- compromise_boundary: the effective (earliest, §4) compromised_since T that
-- drove the classification. NULL when key_revocation_status = 'none'.
--
-- key_revocation_sources: {ctxId, publisher} (camelCase, JSON) per
-- key_revocations row that
-- fed the classification — RFC-ACDP-0014 §13 provenance ("surfacing which
-- DID issued each acted-upon revocation"), not just the boundary number, so
-- an operator can weigh who published each revocation this verdict rests on.
--
-- ra_key_revocation_status_idx is PARTIAL (WHERE <> 'none'): revocations are
-- rare by construction (see key_revocations' own header), so the
-- overwhelming majority of receipt_audits rows are 'none' and would only
-- bloat a full index.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS are
-- native and safe to re-run.
--
-- Lock note: four new nullable-or-defaulted columns plus one partial index
-- on an existing table (receipt_audits). Adding a column with a constant
-- DEFAULT is a metadata-only change on PG 11+ (no table rewrite); the index
-- build takes a SHARE lock (not CONCURRENTLY — this runner has no
-- transaction-less migration path), briefly blocking writers — acceptable
-- at this table's write rate, consistent with every other indexed migration
-- in this directory.
--
-- Rollback: there is no down migration — see the other migrations in this
-- directory for why (an automated reversal is not this runner's model); a
-- rollback here would also discard genuine §7 classification history, which
-- is exactly the kind of evidence this table exists to retain.

ALTER TABLE receipt_audits
  ADD COLUMN IF NOT EXISTS key_revocation_status varchar(32) NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS key_revocation_trust_class varchar(32),
  ADD COLUMN IF NOT EXISTS compromise_boundary timestamptz,
  ADD COLUMN IF NOT EXISTS key_revocation_sources jsonb NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS ra_key_revocation_status_idx
  ON receipt_audits (key_revocation_status)
  WHERE key_revocation_status <> 'none';
