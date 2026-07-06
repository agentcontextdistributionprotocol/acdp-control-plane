-- 0017_log_cosignatures.sql
-- ACDP 0.4.0 — transparency-log witness COSIGNING (RFC-ACDP-0015).
--
-- Evolves the control plane's checkpoint witness from DETECT-ONLY (migration
-- 0016) into an actual COSIGNING WITNESS. After the witness verifies a
-- checkpoint's registry signature (RFC-ACDP-0012 §9.3) AND discharges the
-- RFC-ACDP-0015 §7 consistency obligation against its retained head, it MINTS a
-- signed `acdp-log-cosignature` over the observed
-- {log_id, tree_size, root_hash, timestamp} tuple — the RFC-ACDP-0010 §5
-- construction, keyed by the WITNESS's OWN assertionMethod key (not the
-- registry's) — and stores it here to serve at GET /log/witness (§6.2). A
-- consumer trusting this witness inherits split-view protection.
--
-- A checkpoint that FAILS the §7 obligation (bad signature, or inconsistent
-- with the retained head) is NEVER cosigned — that refusal is the entire point
-- of witnessing; it stays on the detect/alert path (log_witness_cursors).
--
-- One cosignature per observed tuple for a given witness: the UNIQUE constraint
-- makes re-observation idempotent (cosignatures are ephemeral per-observation
-- evidence, §4 — we retain the first per tuple rather than a fresh one per
-- sweep). A PARALLEL table to log_witness_checkpoints, not new columns: the
-- checkpoint evidence rows are the detect-layer forensic anchors and must stay
-- independent of the (optional, key-gated) cosign layer.
CREATE TABLE IF NOT EXISTS log_cosignatures (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           varchar(255) NOT NULL DEFAULT 'default',
  -- The witness's OWN DID (RFC-ACDP-0015 §4 witness_id), distinct from any
  -- registry_did — witnesses are not registries.
  witness_id          text NOT NULL,
  registry_authority  varchar(255) NOT NULL,
  log_id              text NOT NULL,
  tree_size           bigint NOT NULL,
  root_hash           varchar(80) NOT NULL,
  -- Registry-claimed checkpoint time, copied verbatim (§4).
  timestamp           timestamptz NOT NULL,
  -- The witness-clock observation time bound into the signed object (§4).
  witnessed_at        timestamptz NOT NULL,
  key_id              text NOT NULL,
  cosignature_hash    varchar(80) NOT NULL,
  signature_value     text NOT NULL,
  -- The full signed acdp-log-cosignature object, verbatim — GET /log/witness
  -- returns exactly this (§6.2).
  cosignature         jsonb NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Idempotent per (witness, observed tuple): re-observing the same head keeps
  -- the first cosignature (RFC-ACDP-0015 §4/§7).
  UNIQUE (witness_id, log_id, tree_size, root_hash)
);

CREATE INDEX IF NOT EXISTS lcs_log_size_idx ON log_cosignatures (log_id, tree_size);
CREATE INDEX IF NOT EXISTS lcs_tenant_idx ON log_cosignatures (tenant_id);
CREATE INDEX IF NOT EXISTS lcs_authority_idx ON log_cosignatures (registry_authority);
