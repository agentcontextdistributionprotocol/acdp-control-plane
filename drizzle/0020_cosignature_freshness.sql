-- 0020_cosignature_freshness.sql
-- B1 fix: RFC-ACDP-0015 §4 requires a witness to produce a FRESH cosignature
-- on every re-observation of a log, INCLUDING a fresh cosignature at an
-- unchanged tree_size as a liveness signal. This control plane did the
-- opposite: `onConflictDoNothing()` against a (tenant_id, witness_id, log_id,
-- tree_size, root_hash) unique key (migration 0019) kept only the FIRST
-- cosignature per head, so this witness's cosignature crossed the §8.1
-- default 300s staleness boundary on the very next sweep of an unchanged
-- head and never came back -- a spec-conformant consumer sees stale: true
-- forever. §15 names the failure directly: "a witness that silently stops
-- cosigning is indistinguishable from one that is merely offline."
--
-- Fix: widen the unique key to include witnessed_at, so one row is minted
-- per OBSERVATION rather than per HEAD. This is a WIDENING, not a drop, so
-- genuine idempotence (a sweep retried within the same millisecond cannot
-- double-insert) survives alongside the fresh-per-observation behavior.
--
-- This constraint must be dropped by the EXACT name migration 0019 gave it
-- (0019 deliberately chose an explicit name rather than letting PostgreSQL
-- auto-generate one, precisely so 0020 could target it exactly here --
-- see 0019's own header for why a wrong DROP name is a silent, dangerous
-- no-op): log_cosignatures_tenant_witness_head_key
--
-- B6: log_witness_checkpoints gains fresh_witnessed_count / meets_fresh_quorum
-- -- the freshness half of the SDK's evaluateWitnessQuorum report, alongside
-- the existing witnessed_count / meets_quorum from migration 0018.
--
-- No data migration: existing log_cosignatures rows are unaffected by the
-- constraint widening (a wider unique key never rejects a write the
-- narrower one accepted), and NULL is the correct starting value for the two
-- new nullable columns on existing checkpoint rows (quorum consumption may
-- be disabled, or the row predates this phase).
--
-- Idempotent: safe to re-run, same pattern as 0019 (guarded ADD via a
-- pg_constraint existence check; ADD COLUMN IF NOT EXISTS is native).
--
-- Lock note: DROP/ADD CONSTRAINT and CREATE INDEX (non-concurrent, as here)
-- take an ACCESS EXCLUSIVE lock on log_cosignatures for the duration of
-- uniqueness validation / index build; ADD COLUMN with no default is
-- metadata-only and near-instant. At the point this migration deploys, the
-- table is still at ITS PREDECESSOR's growth rate (one row per witnessed
-- HEAD, same as 0019 characterized) -- the re-mint-per-OBSERVATION behavior
-- this migration enables only starts accumulating rows faster AFTER the
-- accompanying code ships, so the lock window here is the same sub-second
-- order of magnitude 0019 already covers, not the steady-state size this
-- table grows to later.
--
-- Rollback: there is no down migration, same rationale as 0019 (a wider
-- unique key/extra nullable columns never reject or lose data the narrower
-- schema accepted).

ALTER TABLE log_cosignatures
  DROP CONSTRAINT IF EXISTS log_cosignatures_tenant_witness_head_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'log_cosignatures'::regclass
      AND conname = 'log_cosignatures_tenant_witness_head_ts_key'
  ) THEN
    ALTER TABLE log_cosignatures
      ADD CONSTRAINT log_cosignatures_tenant_witness_head_ts_key
      UNIQUE (tenant_id, witness_id, log_id, tree_size, root_hash, witnessed_at);
  END IF;
END $$;

-- Serves "latest cosignature per tuple" (the DISTINCT ON in
-- LogCosignatureRepository.list) and the retention purge's per-tuple ranking.
CREATE INDEX IF NOT EXISTS lcs_tuple_witnessed_idx
  ON log_cosignatures (tenant_id, witness_id, log_id, tree_size, root_hash, witnessed_at DESC);

ALTER TABLE log_witness_checkpoints
  ADD COLUMN IF NOT EXISTS fresh_witnessed_count integer,
  ADD COLUMN IF NOT EXISTS meets_fresh_quorum boolean;
