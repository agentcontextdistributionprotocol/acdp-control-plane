-- 0014_trust_metadata.sql
-- ACDP 0.2.0 trust & hardening (RFC-ACDP-0010 registry receipts).
--
-- Registries running 0.2.0 attach two additive fields to context_published
-- webhook events: `key_fingerprint` ("sha256:<64-hex>" of the producer key
-- actually used at publish-time verification) and `registry_receipt` (the
-- full signed receipt object). The raw receipt already lands verbatim in
-- context_events.raw_payload; these columns lift the two signals the
-- console / metrics need into queryable form.

ALTER TABLE context_events
  ADD COLUMN IF NOT EXISTS key_fingerprint varchar(80);

ALTER TABLE context_events
  ADD COLUMN IF NOT EXISTS receipt_present boolean NOT NULL DEFAULT false;

-- Receipt audit verdicts (optional second-observer mode, RECEIPT_AUDIT_ENABLED).
-- One row per audited context_published event (PK = event id, idempotent).
-- `event_arrived_at` (when THIS control plane first saw the event) vs the
-- receipt's claimed `created_at` is the backdating-detection window the
-- future transparency log (RFC-ACDP-0009 §2.11) formalizes.
CREATE TABLE IF NOT EXISTS receipt_audits (
  event_id            uuid PRIMARY KEY,
  tenant_id           varchar(255) NOT NULL DEFAULT 'default',
  run_id              varchar(255),
  ctx_id              text,
  registry_authority  varchar(255) NOT NULL,
  -- verified | structural | discrepancy | no_receipt | error
  status              varchar(32) NOT NULL,
  discrepancies       jsonb NOT NULL DEFAULT '[]',
  receipt_created_at  timestamptz,
  event_arrived_at    timestamptz,
  -- event_arrived_at - receipt_created_at, in ms (positive = receipt claims
  -- an earlier mint than our observation; large positives bound backdating).
  skew_ms             bigint,
  checked_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ra_run_idx ON receipt_audits (run_id);
CREATE INDEX IF NOT EXISTS ra_status_idx ON receipt_audits (status);
CREATE INDEX IF NOT EXISTS ra_tenant_idx ON receipt_audits (tenant_id);
CREATE INDEX IF NOT EXISTS ra_registry_idx ON receipt_audits (registry_authority);
