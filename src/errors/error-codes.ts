export enum ErrorCode {
  RUN_NOT_FOUND = 'RUN_NOT_FOUND',
  REGISTRY_NOT_FOUND = 'REGISTRY_NOT_FOUND',
  AGENT_NOT_FOUND = 'AGENT_NOT_FOUND',
  CONTEXT_NOT_FOUND = 'CONTEXT_NOT_FOUND',
  FEDERATION_UPSTREAM_RATE_LIMITED = 'FEDERATION_UPSTREAM_RATE_LIMITED',
  INVALID_PAYLOAD = 'INVALID_PAYLOAD',
  INVALID_SIGNATURE = 'INVALID_SIGNATURE',
  // ACDP 0.3.0 Tier 3 (RFC-ACDP-0012 §11): an inclusion proof, consistency
  // proof, or checkpoint failed the §9 verification procedures. Deliberately
  // distinct from INVALID_SIGNATURE / receipt failures — the log verdict is
  // independent (§9.3). Minted by the checkpoint-witness poller and the
  // receipt↔log inclusion cross-check (src/audit/) as the verdict/alert
  // category for locally failing proofs — the RFC's consumer-side use of the
  // `invalid_log_proof` semantic.
  INVALID_LOG_PROOF = 'INVALID_LOG_PROOF',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}
