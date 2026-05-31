/**
 * Wire-format types for ACDP (Agent Context Description Protocol).
 *
 * These mirror the canonical event/payload shapes produced by registries and
 * consumed by the control-plane ingest pipeline.
 */

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

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
  }>;
  edges: Array<{ from: string; to: string }>;
}
