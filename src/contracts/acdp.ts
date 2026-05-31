/**
 * Wire-format types for ACDP (Agent Context Description Protocol).
 *
 * These mirror the canonical event/payload shapes produced by registries and
 * consumed by the control-plane ingest pipeline.
 */

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Raw inbound webhook event (as posted by a registry). */
export interface AcdpWebhookEvent {
  type: string;
  ctx_id?: string;
  lineage_id?: string;
  agent_id: string;
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
