-- 0009 — ingest idempotency (FEAT-CP-03).
--
-- A registry that retries a webhook (e.g. after a transient 500) would
-- otherwise insert the same event twice — duplicate lineage nodes and
-- duplicate SSE fan-out. We add a content fingerprint and a PARTIAL
-- unique index over (tenant_id, fingerprint).
--
-- Partial (WHERE fingerprint IS NOT NULL) so the backfilled-NULL existing
-- rows neither collide nor get indexed; only new fingerprinted rows are
-- deduped. The processor inserts with ON CONFLICT DO NOTHING, so a
-- duplicate is silently skipped before any downstream side effects.

ALTER TABLE context_events
  ADD COLUMN IF NOT EXISTS fingerprint varchar(32);

CREATE UNIQUE INDEX IF NOT EXISTS ce_tenant_fingerprint_uidx
  ON context_events (tenant_id, fingerprint)
  WHERE fingerprint IS NOT NULL;
