-- 0022_key_revocations.sql
-- RFC-ACDP-0014 (Final acdp/0.3.0) — producer key-revocation signal.
--
-- key_revocations: VERIFIED FACTS, PERMANENT, RETENTION-EXEMPT. §4 is
-- explicit that "there is no un-revoking a key" — a revocation that expired
-- out of a retention purge would silently re-authorize everything published
-- after its compromise boundary, which is a correctness bug, not a cleanup.
-- DataRetentionService MUST NOT purge this table, and KeyRevocationRepository
-- deliberately has no deleteBefore/purge method (see CLAUDE.md).
--
-- `publisher` and `trust_class` are BOTH stored and BOTH always reported —
-- never derive one from the other at read time, and never report a boundary
-- without its provenance: §6 is explicit that "the classification itself
-- MUST NOT be collapsed", and §13's whole cross-producer-revocation
-- mitigation rests on "surfacing which DID issued each acted-upon
-- revocation."
--
-- key_revocation_lineage_cursors: TTL-bounded per-vantage FRESHNESS MARKERS
-- ("lineage L was fully walked from registry R at time T") — a SEPARATE
-- table from the facts above, on purpose. This mirrors the SDK reference
-- client's own facts-vs-markers split and is a SECURITY control, not a
-- performance one: a cached *absence* of a walk must never suppress a walk
-- when fact rows are missing, so the cursor must be independently deletable
-- and must be deleted whenever fact rows for that lineage are. Populated and
-- consumed starting in a later phase (the §7 lineage fold) — created here so
-- both tables land in one migration together.
--
-- No materialized earliest_compromised_since cache: the §4 fold is
-- min(compromised_since) across every lineage member naming the fingerprint,
-- computed per-audit by feeding the matching rows to the SDK's
-- classifyUnderRevocation rather than reimplementing the boundary arithmetic
-- in SQL. A stale materialized minimum that drifts LATER is a silent false
-- authorization.
--
-- ce_context_type_idx: the candidate-discovery sweep filters context_events
-- by context_type (the two key-revocation spellings) — context_type had no
-- index of its own (ce_type_idx indexes event_type, a different column).
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS is native and safe to re-run.
--
-- Lock note: two new tables plus one new index on an existing table. The
-- index build takes a SHARE lock (not CONCURRENTLY — this runner has no
-- transaction-less migration path), briefly blocking writers to
-- context_events; acceptable at this table's write rate (see the other
-- indexed migrations in this directory, none of which used CONCURRENTLY).
--
-- Rollback: there is no down migration — these are new, empty, independently
-- unreferenced objects; dropping them is a manual operator decision, not an
-- automated reversal (and one that would discard permanent revocation
-- evidence, per the retention-exempt rule above).

CREATE TABLE IF NOT EXISTS key_revocations (
  tenant_id                varchar(255) NOT NULL DEFAULT 'default',
  ctx_id                   text NOT NULL,
  revoked_key_fingerprint  varchar(80) NOT NULL,
  compromised_since        timestamptz NOT NULL,
  revoked_key_controller   text NOT NULL,
  publisher                text NOT NULL,
  -- 'producer_signed' | 'registry_attested' (RFC-ACDP-0014 §5/§6). Never
  -- collapsed into a single boolean or derived field — see header.
  trust_class              varchar(32) NOT NULL,
  revoked_key_id           text,
  reason                   text,
  lineage_id               text NOT NULL,
  origin_authority         varchar(255) NOT NULL,
  -- Which spelling named this revocation: 'key-revocation' (standard) or
  -- 'acdp:key-revocation' (pre-0.3.0 interim — §10 requires 0.3.0+
  -- consumers to treat both as fully equivalent; recorded for observability
  -- only, never branched on downstream).
  context_type             varchar(64) NOT NULL,
  verified_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ctx_id)
);

CREATE INDEX IF NOT EXISTS kr_fingerprint_idx ON key_revocations (tenant_id, revoked_key_fingerprint);
CREATE INDEX IF NOT EXISTS kr_lineage_idx ON key_revocations (tenant_id, lineage_id);

CREATE TABLE IF NOT EXISTS key_revocation_lineage_cursors (
  tenant_id           varchar(255) NOT NULL DEFAULT 'default',
  lineage_id          text NOT NULL,
  registry_authority  varchar(255) NOT NULL,
  walked_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, lineage_id, registry_authority)
);

CREATE INDEX IF NOT EXISTS krlc_walked_at_idx ON key_revocation_lineage_cursors (walked_at);

CREATE INDEX IF NOT EXISTS ce_context_type_idx ON context_events (context_type, created_at);
