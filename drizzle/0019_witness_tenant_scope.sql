-- 0019_witness_tenant_scope.sql
-- B7 fix: the UNIQUE constraints migrations 0016/0017 put on
-- log_witness_checkpoints and log_cosignatures omit tenant_id, although both
-- tables carry the column. Both writers use onConflictDoNothing(), so when a
-- SECOND tenant witnesses the SAME registry head, its insert silently no-ops
-- -- and because the reader (latestForAuthority) DOES filter by tenant, that
-- tenant sees an empty witness history while its sweep reports success. A
-- silent, complete loss of forensic evidence for every tenant but the first.
--
-- The OLD constraints must be dropped by their EXACT, deterministic,
-- Postgres-generated names -- both were declared inline in CREATE TABLE, so
-- Postgres named them by its documented <table>_<col1>_<col2>..._key rule,
-- and both are under the 63-byte identifier limit (54 and 58 bytes), so
-- neither was truncated:
--   - log_witness_checkpoints_log_id_tree_size_root_hash_key
--   - log_cosignatures_witness_id_log_id_tree_size_root_hash_key
-- DROP CONSTRAINT IF EXISTS against a WRONG name is a silent no-op, and the
-- subsequent ADD CONSTRAINT over a different column list then SUCCEEDS --
-- leaving both the old narrow constraint and the new wide one in place. The
-- old one keeps rejecting tenant B's insert, onConflictDoNothing() keeps
-- swallowing it, and B7 survives the migration entirely undetected by any
-- check that only asserts the new constraint exists. Hence the exact names
-- above, not a guess.
--
-- No data migration needed: every existing row already carries its true
-- tenant_id (the column has always been populated); only the constraint was
-- wrong, and a wider unique key never rejects a write the narrower one
-- accepted, so widening it is safe even with rows that could not previously
-- collide.
--
-- Idempotent: safe to re-run. DROP ... IF EXISTS on both known old names;
-- ADD CONSTRAINT is guarded by a pg_constraint existence check since
-- PostgreSQL has no native ADD CONSTRAINT IF NOT EXISTS. The runner
-- (src/db/migrate.ts) wraps this whole file in one transaction and only
-- records it applied on a full commit, but this file may also be re-run
-- manually outside the runner, so it must tolerate that.
--
-- Lock note: DROP/ADD CONSTRAINT take an ACCESS EXCLUSIVE lock on the table
-- for the duration of the uniqueness validation. Both tables hold one row per
-- witnessed head -- sub-second in any realistic deployment.
--
-- Rollback: there is no down migration. Rolling back the CODE while leaving
-- the widened constraint in place is safe (a wider unique key never rejects
-- a write the narrower one accepted). Rolling back the MIGRATION itself is
-- not supported.

ALTER TABLE log_witness_checkpoints
  DROP CONSTRAINT IF EXISTS log_witness_checkpoints_log_id_tree_size_root_hash_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'log_witness_checkpoints'::regclass
      AND conname = 'log_witness_checkpoints_tenant_head_key'
  ) THEN
    ALTER TABLE log_witness_checkpoints
      ADD CONSTRAINT log_witness_checkpoints_tenant_head_key
      UNIQUE (tenant_id, log_id, tree_size, root_hash);
  END IF;
END $$;

ALTER TABLE log_cosignatures
  DROP CONSTRAINT IF EXISTS log_cosignatures_witness_id_log_id_tree_size_root_hash_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'log_cosignatures'::regclass
      AND conname = 'log_cosignatures_tenant_witness_head_key'
  ) THEN
    ALTER TABLE log_cosignatures
      ADD CONSTRAINT log_cosignatures_tenant_witness_head_key
      UNIQUE (tenant_id, witness_id, log_id, tree_size, root_hash);
  END IF;
END $$;
