-- 0024_revocation_reaudit.sql
-- RFC-ACDP-0014 §7 — retroactive re-audit when a revocation predates an
-- existing verdict (Phase 15).
--
-- No new columns or tables: the amendment this phase adds writes only the
-- four key_revocation_* columns migration 0023 already created, in place,
-- via a column-scoped, monotone UPDATE (see
-- ReceiptAuditRepository.amendKeyRevocation / .findRevocationAmendmentCandidates).
--
-- This phase needs two indexes to make the fan-out affordable:
--
-- 1. ce_key_fingerprint_idx: the fan-out joins receipt_audits ->
--    context_events on (tenant_id, key_fingerprint) to find every
--    already-sealed verdict for a newly-revoked signer key, and without this
--    index that join is a full scan of context_events on every sweep pass
--    for every distinct revoked fingerprint. Partial (WHERE key_fingerprint
--    IS NOT NULL): the column is ACDP 0.2.0+ trust metadata, so most
--    historical rows never populated it.
--
-- 2. ra_key_revocation_none_idx: the candidate query
--    (findRevocationAmendmentCandidates) restricts receipt_audits to rows
--    still eligible for amendment — 'none', or a stored compromise_boundary
--    later than the fact set's current minimum. The overwhelmingly common
--    steady-state case (a fingerprint with no revocation at all, or one
--    already fully amended) resolves against the 'none' branch of that
--    predicate alone; this partial index (mirroring the inverse
--    ra_key_revocation_status_idx from migration 0023) keeps that branch an
--    index lookup rather than a scan, even at scale (EXPLAIN (ANALYZE,
--    BUFFERS) against 200k seeded rows showed ~190ms / ~505k buffer hits
--    without it, on a table where every row was already amended).
--
-- Idempotent: CREATE INDEX IF NOT EXISTS is native and safe to re-run.
--
-- Lock note: two new indexes on existing tables (context_events,
-- receipt_audits). Not CONCURRENTLY — this runner has no transaction-less
-- migration path, so each build takes a SHARE lock, briefly blocking
-- writers, consistent with every other indexed migration in this directory.
--
-- Rollback: there is no down migration — see the other migrations in this
-- directory for why (an automated reversal is not this runner's model); a
-- dropped index here only costs performance, never data, so re-adding it is
-- always safe if this migration is ever reverted by hand.

CREATE INDEX IF NOT EXISTS ce_key_fingerprint_idx
  ON context_events (tenant_id, key_fingerprint)
  WHERE key_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS ra_key_revocation_none_idx
  ON receipt_audits (tenant_id, event_id)
  WHERE key_revocation_status = 'none';
