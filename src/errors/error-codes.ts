export enum ErrorCode {
  RUN_NOT_FOUND = "RUN_NOT_FOUND",
  REGISTRY_NOT_FOUND = "REGISTRY_NOT_FOUND",
  AGENT_NOT_FOUND = "AGENT_NOT_FOUND",
  CONTEXT_NOT_FOUND = "CONTEXT_NOT_FOUND",
  FEDERATION_UPSTREAM_RATE_LIMITED = "FEDERATION_UPSTREAM_RATE_LIMITED",
  // RFC-ACDP-0006 §4.1 step 7 (NORMATIVE): the federation proxy compares the
  // `ctx_id` a registry SERVED against the `ctx_id` that was REQUESTED.
  // `ctx_id` is registry-assigned and excluded from both `content_hash` and
  // the producer signature (RFC-ACDP-0001 §5.7), so a validly-signed body
  // served under the wrong URL passes every other check the control plane
  // makes — this comparison is the only thing that can catch it.
  //
  // TWO codes, deliberately not one. They answer different operator questions
  // and collapsing them would overload one semantic across two unrelated
  // upstream faults — the same collapse RFC-ACDP-0015 §10 forbids for
  // `invalid_log_proof` / `invalid_witness_cosignature`. An `ErrorCode` is a
  // public surface, so the distinction is cheap now and permanent later:
  //
  // - CONTEXT_ID_MISMATCH — we DID check, and the upstream served a different
  //   context than the one requested. The registry may be hostile.
  // - CONTEXT_BINDING_UNVERIFIABLE — we COULD NOT check (a 2xx body that is
  //   not JSON, carries no `body` member, or names a `ctx_id` the protocol
  //   grammar refuses), so we refuse to relay. The registry is most likely
  //   misconfigured. No mismatch was ever established, so claiming one here
  //   would be a lie.
  //
  // Both are HTTP 502 (the upstream misbehaved, not the caller) and both fail
  // closed: a substitution the proxy detected and forwarded anyway is worse
  // than one it never looked for, because downstream consumers then hold a
  // false assurance that the proxy checked.
  CONTEXT_ID_MISMATCH = "CONTEXT_ID_MISMATCH",
  CONTEXT_BINDING_UNVERIFIABLE = "CONTEXT_BINDING_UNVERIFIABLE",
  INVALID_PAYLOAD = "INVALID_PAYLOAD",
  INVALID_SIGNATURE = "INVALID_SIGNATURE",
  // ACDP 0.3.0 Tier 3 (RFC-ACDP-0012 §11): an inclusion proof, consistency
  // proof, or checkpoint failed the §9 verification procedures. Deliberately
  // distinct from INVALID_SIGNATURE / receipt failures — the log verdict is
  // independent (§9.3). Minted by the checkpoint-witness poller and the
  // receipt↔log inclusion cross-check (src/audit/) as the verdict/alert
  // category for locally failing proofs — the RFC's consumer-side use of the
  // `invalid_log_proof` semantic.
  INVALID_LOG_PROOF = "INVALID_LOG_PROOF",
  // RFC-ACDP-0015 §10 registers `invalid_witness_cosignature` as its own wire
  // code (HTTP 502) and is emphatic it must not collapse into
  // `invalid_log_proof`: "an `invalid_log_proof` indicts the LOG … an
  // `invalid_witness_cosignature` indicts a WITNESS's attestation, an
  // independent verdict over an independent signer. Collapsing them would
  // overload a single semantic." A cosignature failing §8 never indicts the
  // checkpoint itself (§8: "it does not, by itself, fail the checkpoint … it
  // simply does not count toward N") — so this is a verdict/diagnostic
  // category for a locally failing cosignature (mirrors INVALID_LOG_PROOF's
  // "verdict/alert category for locally failing proofs" role), never a new
  // `WitnessAlertReason`.
  INVALID_WITNESS_COSIGNATURE = "INVALID_WITNESS_COSIGNATURE",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  // RESERVED for genuine server faults (5xx). RFC-ACDP-0007 §5 lists
  // `internal_error` as RETRYABLE, so a 4xx carrying it makes a client retry a
  // permanent refusal forever (#182) — the filter never assigns it to a 4xx.
  INTERNAL_ERROR = "INTERNAL_ERROR",

  // Generic status-keyed FALLBACKS (#182), minted by GlobalExceptionFilter for
  // a 4xx whose body carries no `errorCode`. A specific code always wins where
  // one exists; these only guarantee no 4xx is ever labelled INTERNAL_ERROR.
  // SCREAMING_SNAKE like every CP code, so they can never collide with a
  // registry's lowercase RFC-ACDP-0007 `error.code` vocabulary.
  /** 401 — generic fallback: credentials missing or rejected. */
  UNAUTHORIZED = "UNAUTHORIZED",
  /** 403 — generic fallback: authenticated but not permitted. */
  FORBIDDEN = "FORBIDDEN",
  /** 404 — generic fallback: no such route/resource (aligned with RFC `not_found`). */
  NOT_FOUND = "NOT_FOUND",
  /** 413 — generic fallback: request body over the configured limit (RFC `payload_too_large`). */
  PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE",
  /** 429 — generic fallback: coarse per-principal throttle (RFC `rate_limited`). */
  RATE_LIMITED = "RATE_LIMITED",
  /** Any other 4xx (405, 409, 415, 422, …) — generic fallback, never INTERNAL_ERROR. */
  REQUEST_REJECTED = "REQUEST_REJECTED",
}
