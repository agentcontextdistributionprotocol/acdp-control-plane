-- 0018_witness_quorum.sql
-- ACDP 0.4.0 — transparency-log witness quorum CONSUMPTION (RFC-ACDP-0015 §8)
-- plus operator acknowledgement of witness alerts (durability hardening).
--
-- 1. Quorum consumption. The mirror of cosigning (migration 0017): rather than
--    only MINTING its own cosignature, the checkpoint witness now also EVALUATES
--    the N-witnessed quorum over the cosignatures a registry AGGREGATES and
--    serves on GET /log/checkpoint (the top-level `witness_signatures` sibling,
--    §6.1). Each is verified against its witness's OWN resolved did:web document;
--    DISTINCT trusted witnesses over the checkpoint's exact
--    (log_id, tree_size, root_hash) tuple are counted. The result is recorded on
--    the witnessed head as a trust signal. NULL columns = consumption disabled.
--
-- 2. Alert acknowledgement. A witness alert is already durably persisted on
--    log_witness_cursors (the detection is never lost if the best-effort
--    SSE/webhook fan-out fails). These columns add the operator-facing half: an
--    alerted cursor is UNACKNOWLEDGED until an operator acks it, so unacked
--    alerts can be polled (GET /registries/log-witness/alerts) and worked. Reset
--    on a new alert reason or on resolution (advanceCursor).

ALTER TABLE log_witness_checkpoints
  ADD COLUMN IF NOT EXISTS witnessed_count integer,
  ADD COLUMN IF NOT EXISTS meets_quorum    boolean;

ALTER TABLE log_witness_cursors
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS acknowledged_by text;
