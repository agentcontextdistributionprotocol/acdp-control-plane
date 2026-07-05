// TODO(ACDP 0.3.0 Tier 3 — checkpoint-witness poller): add INVALID_LOG_PROOF
// when transparency-log proof verification lands. Nothing in the lifecycle
// ingest / dashboard / lineage path (Tier 1+2) surfaces it yet, so the code
// is deliberately not minted here to avoid a dead vocabulary entry.
export enum ErrorCode {
  RUN_NOT_FOUND = 'RUN_NOT_FOUND',
  REGISTRY_NOT_FOUND = 'REGISTRY_NOT_FOUND',
  AGENT_NOT_FOUND = 'AGENT_NOT_FOUND',
  CONTEXT_NOT_FOUND = 'CONTEXT_NOT_FOUND',
  FEDERATION_UPSTREAM_RATE_LIMITED = 'FEDERATION_UPSTREAM_RATE_LIMITED',
  INVALID_PAYLOAD = 'INVALID_PAYLOAD',
  INVALID_SIGNATURE = 'INVALID_SIGNATURE',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}
