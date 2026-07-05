-- 0016_log_witness.sql
-- ACDP 0.3.0 Tier 3 — transparency-log checkpoint witness (RFC-ACDP-0012).
--
-- The control plane acts as an EXTERNAL WITNESS / MONITOR for registry
-- transparency logs: it polls GET /log/checkpoint on enrolled registries
-- advertising the `acdp-registry-transparency-log` profile, verifies each
-- checkpoint's registry signature, and demands a consistency proof between
-- the last-witnessed tree head and the new one (RFC-ACDP-0012 §9.2). Retained
-- checkpoints are the forensic anchors §13/§15 call for: a pair of
-- signature-valid, mutually inconsistent checkpoints of one log_id is
-- compact, non-repudiable proof of a logged-history rewrite. Witnessing only
-- — the RFC-ACDP-0009 §2.12 cosigning protocol is reserved/unspecified, so
-- no cosignatures are minted here.

-- Every checkpoint this control plane has witnessed (append-only evidence).
-- UNIQUE(log_id, tree_size, root_hash) dedupes re-fetches of the same head;
-- two rows sharing (log_id, tree_size) with DIFFERENT root_hash are the
-- split-view evidence pair itself.
CREATE TABLE IF NOT EXISTS log_witness_checkpoints (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           varchar(255) NOT NULL DEFAULT 'default',
  registry_authority  varchar(255) NOT NULL,
  log_id              text NOT NULL,
  tree_size           bigint NOT NULL,
  root_hash           varchar(80) NOT NULL,
  -- Registry-asserted evaluation time from the checkpoint itself (§6).
  timestamp           timestamptz NOT NULL,
  -- The checkpoint verbatim as fetched — the portable evidence object.
  raw_checkpoint      jsonb NOT NULL,
  witnessed_at        timestamptz NOT NULL DEFAULT now(),
  signature_valid     boolean NOT NULL,
  -- §9.2 verdict vs the previously witnessed head of the same log_id.
  -- NULL for the first witnessed checkpoint of a log (nothing to compare).
  consistency_ok      boolean,
  UNIQUE (log_id, tree_size, root_hash)
);

CREATE INDEX IF NOT EXISTS lwc_authority_idx ON log_witness_checkpoints (registry_authority);
CREATE INDEX IF NOT EXISTS lwc_tenant_idx ON log_witness_checkpoints (tenant_id);
CREATE INDEX IF NOT EXISTS lwc_log_size_idx ON log_witness_checkpoints (log_id, tree_size);

-- Per-registry witness cursor + alert state. The cursor (last_witnessed_size
-- + last_root_hash) advances ONLY on a fully verified sweep step (valid
-- signature AND, when a prior head exists, a valid consistency proof) — on
-- any failure it holds, so the retained pre-failure root stays available as
-- the §9.2 first_root for the next demand (and as post-incident evidence).
CREATE TABLE IF NOT EXISTS log_witness_cursors (
  registry_authority    varchar(255) NOT NULL,
  tenant_id             varchar(255) NOT NULL DEFAULT 'default',
  log_id                text,
  last_witnessed_size   bigint,
  last_root_hash        varchar(80),
  -- Environmental (transport/resolution) failures since the last success.
  -- Dishonesty signals do NOT count here — they set the alert fields.
  consecutive_failures  integer NOT NULL DEFAULT 0,
  alerted               boolean NOT NULL DEFAULT false,
  -- checkpoint_invalid | checkpoint_signature_invalid | tree_size_regression
  -- | root_mismatch | consistency_failed | log_id_changed
  last_alert_reason     varchar(64),
  -- Evidence detail (offending checkpoint, failing consistency path, ...).
  last_alert_detail     jsonb,
  last_alert_at         timestamptz,
  last_success_at       timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, registry_authority)
);

CREATE INDEX IF NOT EXISTS lwcur_alerted_idx ON log_witness_cursors (alerted);

-- Receipt ↔ log cross-check verdicts (RFC-ACDP-0012 §9.1): for stored
-- context_published events that carried a registry_receipt from a
-- log-advertising registry, the sweep reconstructs the §4 leaf from OUR
-- stored copy of the receipt, fetches GET /log/proof?ctx_id=…, and verifies
-- inclusion. A PARALLEL table rather than new columns on receipt_audits:
-- receipt_audits rows are written exactly once (PK = event id, insert
-- on-conflict-do-nothing — racing sweeps keep the first verdict), and
-- RFC-ACDP-0012 §9.3 requires the receipt verdict and the log verdict to be
-- independent results reported independently — a later log verdict must not
-- mutate a sealed receipt verdict row. Same once-only idempotent design,
-- one level up.
CREATE TABLE IF NOT EXISTS log_inclusion_audits (
  event_id            uuid PRIMARY KEY,
  tenant_id           varchar(255) NOT NULL DEFAULT 'default',
  run_id              varchar(255),
  ctx_id              text,
  registry_authority  varchar(255) NOT NULL,
  log_id              text,
  leaf_index          bigint,
  tree_size           bigint,
  -- included | invalid_proof | not_logged | no_log | error
  status              varchar(32) NOT NULL,
  detail              jsonb NOT NULL DEFAULT '[]',
  checked_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lia_status_idx ON log_inclusion_audits (status);
CREATE INDEX IF NOT EXISTS lia_tenant_idx ON log_inclusion_audits (tenant_id);
CREATE INDEX IF NOT EXISTS lia_registry_idx ON log_inclusion_audits (registry_authority);
CREATE INDEX IF NOT EXISTS lia_run_idx ON log_inclusion_audits (run_id);
