/**
 * Wire-format types for ACDP (Agent Context Distribution Protocol).
 *
 * These mirror the canonical event/payload shapes produced by registries and
 * consumed by the control-plane ingest pipeline.
 */

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Canonical registry event-type strings (the JSON `type` field).
 *
 * Wire-name note (verified against acdp-registry-rs): the registry's
 * `WebhookEvent` enum is `#[serde(tag = "type", rename_all = "snake_case")]`,
 * so the JSON body carries UNDERSCORED names (`context_published`,
 * `context_retracted`, ...). The dotted forms (`context.retracted`) exist only
 * in the registry's `X-ACDP-Event` HTTP header and its log lines — the control
 * plane never keys off that header, so no ingest normalization is needed: the
 * wire form and the canonical form below are identical.
 */
export const ACDP_EVENT_CONTEXT_PUBLISHED = 'context_published';
export const ACDP_EVENT_CONTEXT_RETRIEVED = 'context_retrieved';
/** ACDP 0.3.0 lifecycle (RFC-ACDP-0013 §6): formal retraction, mark-not-delete. */
export const ACDP_EVENT_CONTEXT_RETRACTED = 'context_retracted';
/** ACDP 0.3.0 lifecycle (RFC-ACDP-0013 §6): a prior retraction was reversed. */
export const ACDP_EVENT_CONTEXT_REPUBLISHED = 'context_republished';
export const ACDP_EVENT_SEARCH_EXECUTED = 'search_executed';

/** Raw inbound webhook event (as posted by a registry). */
export interface AcdpWebhookEvent {
  /**
   * Stable event id minted once by the registry and reused across retries
   * (REG-P2-6 WireEnvelope; also echoed in the X-ACDP-Event-Id header). When
   * present it is the preferred dedup key — see EventProcessorService.dedupKey.
   */
  event_id?: string;
  /** Registry wire-envelope schema version (REG-P2-6). Tolerated, not required. */
  schema_version?: string;
  type: string;
  ctx_id?: string;
  lineage_id?: string;
  // Optional on the wire: only context_published carries an agent_id. The
  // registry's context_retrieved / search_executed variants are agent-less
  // (they carry an optional requester_did instead). The processor tolerates
  // an absent agent_id; the ingest guard requires it only for publishes.
  agent_id?: string;
  context_type?: string;
  visibility?: string;
  version?: number;
  derived_from?: string[];
  // Optional on the wire: registries may omit it and the ingest path falls
  // back to extracting the authority from ctx_id (acdp://<authority>/<id>).
  registry_authority?: string;
  /** Registry's public base URL, used to reach it via the federation proxy. */
  registry_base_url?: string;
  scenario_id?: string;
  run_id?: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
  /**
   * ACDP 0.2.0 (RFC-ACDP-0010): "sha256:<64-hex>" fingerprint of the producer
   * key the registry actually verified at publish time. Only set by registries
   * minting receipts; absent on 0.1.0 traffic.
   */
  key_fingerprint?: string;
  /**
   * ACDP 0.2.0 (RFC-ACDP-0010): the full signed registry receipt object
   * ({ registry_did, ctx_id, lineage_id, origin_registry, created_at,
   * content_hash, key_fingerprint, signature }). Kept as an open record —
   * the receipt is a closed schema OWNED by the SDK; the control plane never
   * re-implements its parse/verify (see src/audit/receipt-verify.ts).
   */
  registry_receipt?: Record<string, unknown>;
  /**
   * ACDP 0.3.0 lifecycle (RFC-ACDP-0013): retract/republish (and
   * retrieve/search) events timestamp themselves with `at` instead of
   * `created_at` (which only publishes carry).
   */
  at?: string;
  /**
   * ACDP 0.3.0 lifecycle: DID of the party performing a retract/republish
   * (the producer for endpoint-submitted lifecycle events). NOTE: on
   * retract/republish events the flattened wire body's `event_id` is the
   * actor-minted lifecycle event id (RFC 9562 UUID) — still retry-stable, so
   * it remains a valid dedup fallback when `X-ACDP-Event-Id` is absent.
   */
  actor?: string;
  /** ACDP 0.3.0 lifecycle: optional human-readable explanation from the signed event. */
  reason?: string;
  /**
   * ACDP 0.3.0: context status if a registry ever attaches it to an event
   * (mirrors `registry_state.status` on retrieval, e.g. `retracted`).
   * Tolerated, not required — current registries do not send it.
   */
  status?: string;
  /**
   * ACDP 0.3.0: mirror of `registry_state.lifecycle_events` if a registry
   * attaches the history to an event. Open records (schema owned by the
   * registry); tolerated, not required.
   */
  lifecycle_events?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

/** Stream event broadcast over SSE (per-run and global feeds). */
export interface AcdpStreamEvent {
  type: string;
  ts: string;
  runId?: string;
  ctxId?: string;
  agentId: string;
  contextType?: string;
  registryAuthority: string;
  derivedFrom: string[];
  /** ACDP 0.2.0 trust signals — additive; SSE consumers tolerate unknowns. */
  keyFingerprint?: string;
  receiptPresent?: boolean;
  /** ACDP 0.3.0 lifecycle — set on retract/republish events only. */
  actor?: string;
  reason?: string;
  /**
   * ACDP 0.3.0 Tier 3 (RFC-ACDP-0012): set on `log_witness_alert` system
   * events — the transparency-log instantiation the alert concerns. On those
   * events `agentId` carries the registry's did:web DID (the accused party),
   * `reason` the alert-taxonomy value, and `runId`/`ctxId` are absent
   * (witness alerts are registry-scoped, not run-scoped). Additive.
   */
  logId?: string;
}

/** Lineage DAG result. */
export interface LineageDag {
  runId: string;
  nodes: Array<{
    ctxId: string | null;
    agentId: string;
    contextType: string | null;
    visibility: string | null;
    registryAuthority: string;
    step: number;
    /**
     * ACDP 0.3.0 (RFC-ACDP-0013): true when the context is CURRENTLY
     * retracted (a later republish clears it). Mark-not-delete: the node
     * stays in the DAG.
     */
    retracted: boolean;
  }>;
  edges: Array<{ from: string; to: string }>;
}
