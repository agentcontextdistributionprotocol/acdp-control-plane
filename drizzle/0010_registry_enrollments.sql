-- 0010 — registry enrollment (CP-3.1).
--
-- Establishes a trust anchor for ingest: an authority is bound to exactly
-- one tenant (authority is the PK), with an optional per-registry webhook
-- secret and base URL. When an authority is enrolled, ingest derives the
-- tenant from the enrollment (not the client-supplied X-Tenant-Id header)
-- and verifies HMAC against the per-registry secret.
--
-- Backward compatible: with no enrollments and INGEST_REQUIRE_ENROLLMENT
-- unset, ingest behaves exactly as before (global secret + header tenant).

CREATE TABLE IF NOT EXISTS registry_enrollments (
  authority varchar(255) PRIMARY KEY,
  tenant_id varchar(255) NOT NULL DEFAULT 'default',
  base_url text,
  registry_did text,
  webhook_secret varchar(255),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registry_enrollments_tenant_idx
  ON registry_enrollments (tenant_id);
