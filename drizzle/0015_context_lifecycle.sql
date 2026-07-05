-- 0015_context_lifecycle.sql
-- ACDP 0.3.0 lifecycle adoption (RFC-ACDP-0013 retract / republish).
--
-- The registry now emits `context_retracted` / `context_republished` webhook
-- events (snake_case JSON `type`, matching the control plane's canonical
-- form). Retraction is mark-not-delete: the context body stays retrievable,
-- but consumers must be able to see that a lineage node is currently
-- retracted.
--
-- Design choice: a keyed PROJECTION table rather than a marker column on an
-- existing table, because
--   * there is no contexts table — lineage DAG nodes are derived at query
--     time from context_published rows in the append-only context_events
--     log, and mutating that log would break replayability;
--   * lineage_edges rows are per-edge, not per-context — a root node with no
--     edges could never be marked;
--   * a retract can arrive for a context whose publish this control plane
--     never ingested (or that retention already swept), so there may be no
--     row to mark at all.
-- One row per (tenant_id, ctx_id). Transitions are last-write-wins by the
-- lifecycle event's own timestamp (last_event_at), making event replays and
-- out-of-order deliveries idempotent.

CREATE TABLE IF NOT EXISTS context_lifecycle (
  ctx_id          text NOT NULL,
  tenant_id       varchar(255) NOT NULL DEFAULT 'default',
  lineage_id      text,
  -- Current state: true between a retract and a subsequent republish.
  retracted       boolean NOT NULL DEFAULT false,
  -- Most recent transition timestamps (full history lives in context_events
  -- and the registry's registry_state.lifecycle_events, not here).
  retracted_at    timestamptz,
  republished_at  timestamptz,
  -- DID + optional reason of the LAST applied transition.
  actor           text,
  reason          text,
  -- Event-time of the last applied transition — the idempotence guard.
  last_event_at   timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ctx_id)
);

CREATE INDEX IF NOT EXISTS cl_retracted_idx ON context_lifecycle (retracted);
CREATE INDEX IF NOT EXISTS cl_lineage_idx ON context_lifecycle (lineage_id);
