-- 0011 — widen the dedup key to carry the registry's event_id.
--
-- As of REG-P2-6 the registry mints a stable event_id (UUID, minted once at
-- emit and reused across retries) and echoes it in the X-ACDP-Event-Id header
-- specifically for control-plane dedupe. We prefer that id over the
-- self-computed content fingerprint: it is retry-stable even if the registry
-- reshapes a payload field, and it never falsely collapses two distinct events
-- that happen to share (type, agent, created_at) — notably the ctx_id-less
-- context_retrieved / search_executed variants.
--
-- The dedup key now holds either:
--   * `evt:<uuid>`            — registry-provided event_id (40 chars), or
--   * a 32-char content hash  — legacy fallback for registries not yet
--                               sending an event_id (unchanged shape, so
--                               existing rows keep deduping).
-- These two namespaces are disjoint (a hex hash never starts with `evt:`), so
-- they share one column + one partial unique index without collision.
--
-- varchar(32) -> varchar(80): roomy for `evt:` + uuid with headroom. The
-- partial unique index (ce_tenant_fingerprint_uidx, migration 0009) is
-- unaffected by a column-type widening.

ALTER TABLE context_events
  ALTER COLUMN fingerprint TYPE varchar(80);
