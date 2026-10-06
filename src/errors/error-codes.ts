export enum ErrorCode {
  RUN_NOT_FOUND = "RUN_NOT_FOUND",
  REGISTRY_NOT_FOUND = "REGISTRY_NOT_FOUND",
  AGENT_NOT_FOUND = "AGENT_NOT_FOUND",
  CONTEXT_NOT_FOUND = "CONTEXT_NOT_FOUND",
  FEDERATION_UPSTREAM_RATE_LIMITED = "FEDERATION_UPSTREAM_RATE_LIMITED",
  // 502 from the federation proxy (`GET /contexts/*`, #200): NO usable
  // upstream response was obtained — the SSRF policy refused the registry's
  // base_url, the fetch failed or timed out, a redirect was rejected
  // (cross-authority / too many), or the body exceeded the 1 MiB cap
  // (`FederationFetchError` SSRF | FETCH | REDIRECT | BODY_TOO_LARGE; the
  // specific cause is logged, never put on the wire). Disjoint from its
  // siblings: an upstream 429 is FEDERATION_UPSTREAM_RATE_LIMITED (503), and a
  // 2xx whose served ctx_id fails the binding is CONTEXT_ID_MISMATCH /
  // CONTEXT_BINDING_UNVERIFIABLE (502). Before #200 this case reported the
  // 5xx fallback INTERNAL_ERROR, blaming the control plane for an upstream
  // fault. Deliberately SCREAMING_SNAKE, not the registry's lowercase
  // RFC-ACDP-0007 `cross_registry_resolution_failed`.
  FEDERATION_UPSTREAM_ERROR = "FEDERATION_UPSTREAM_ERROR",
  // 503 from the drain gate (#192, `src/middleware/drain-gate.middleware.ts`):
  // this instance is shutting down and the request's headers arrived after the
  // drain began. Transient — retry (honour `Retry-After`) and another replica
  // will serve it; the response also carries `Connection: close`. Like
  // RATE_LIMITED / FEDERATION_* it is a CP-local SCREAMING_SNAKE code:
  // RFC-ACDP-0007 §5's closed enum has no 503 code, so no RFC code is minted
  // or reused. The gate never 503s the two SSE routes (a non-2xx kills
  // EventSource); a new stream that passes the guards gets 200 +
  // `event: shutdown` instead.
  SERVICE_DRAINING = "SERVICE_DRAINING",
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
  // 401 on /auth/token and /capabilities: the Ed25519/ECDSA-P256 signature
  // over a challenge or capability assertion failed verification (#182).
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

  // Specific authorization / tenancy 403s (#182). Each names a distinct
  // operator remedy, so they are deliberately NOT one TENANT_FORBIDDEN code.
  /** 403 — the route requires an admin API key (`assertAdmin`). */
  ADMIN_REQUIRED = "ADMIN_REQUIRED",
  /** 403 — the reserved `default` tenant was explicitly asserted; stop naming it. */
  TENANT_RESERVED = "TENANT_RESERVED",
  /** 403 — `X-Tenant-Id` disagrees with the JWT claim / key-bound tenant; fix the header. */
  TENANT_MISMATCH = "TENANT_MISMATCH",
  /** 403 — AUTH_REQUIRE_TENANT strict mode and no bound tenant; bind the key or claim. */
  TENANT_REQUIRED = "TENANT_REQUIRED",
  /**
   * 403 — a JWT with no `tenant` claim sent `X-Tenant-Id` while
   * `TENANT_HEADER_TRUST=none` (the default). The header is only trusted when
   * the operator declares a gateway boundary (`any_peer`) — otherwise use a
   * tenant-bound token. Distinct from TENANT_MISMATCH (a claim exists and
   * disagrees) and TENANT_REQUIRED (strict mode: bind the token).
   */
  TENANT_HEADER_UNTRUSTED = "TENANT_HEADER_UNTRUSTED",

  // Credentials, ingest gating, policy and quota (#182 Phase 3).
  /**
   * 401 — the HMAC-SHA256 webhook signature (`X-ACDP-Signature`) on
   * `/ingest/acdp` or `/runs/*` notify failed. A shared-secret MAC, NOT a
   * producer signature — the fix is the webhook secret, not a DID key, so it
   * is deliberately distinct from INVALID_SIGNATURE.
   */
  INVALID_WEBHOOK_SIGNATURE = "INVALID_WEBHOOK_SIGNATURE",
  /** 403 — the ingesting registry is enrolled but disabled. */
  REGISTRY_DISABLED = "REGISTRY_DISABLED",
  /**
   * 403 — the bearer token came from a `TRUSTED_ISSUERS` entry flagged
   * `read_only` and the request method is not GET/HEAD/OPTIONS. The remedy is
   * distinct from ADMIN_REQUIRED/POLICY_DENIED: use a control-plane-issued
   * token, or have the operator lift `read_only` for that issuer.
   */
  ISSUER_READ_ONLY = "ISSUER_READ_ONLY",
  /** 403 — INGEST_REQUIRE_ENROLLMENT and the registry is not enrolled. */
  REGISTRY_NOT_ENROLLED = "REGISTRY_NOT_ENROLLED",
  /**
   * 403 — PolicyGuard denied (or could not decide: the legacy top-level
   * `code: "indeterminate"` distinguishes that case). The body keeps its
   * documented top-level `code`/`reason`.
   */
  POLICY_DENIED = "POLICY_DENIED",
  /**
   * 429 — a per-tenant per-action TENANT_QUOTAS limit was exceeded. Distinct
   * from RATE_LIMITED (the coarse per-principal throttle): different remedy.
   * The body keeps its documented top-level `code: "rate_limited"` etc.
   */
  QUOTA_EXCEEDED = "QUOTA_EXCEEDED",

  // 503 from `GET /readyz` (#210, `src/health/readiness.service.ts`): a
  // REQUIRED backing dependency of this instance (today: Postgres) failed the
  // readiness probe — refused, timed out, or pool-starved. Readiness-only for
  // now. Deliberately generic over dependencies: `error.details.checks` names
  // which one (an enum `status`/`reason`, never the driver's error text).
  // Distinct from INTERNAL_ERROR (the CP itself is fine; its dependency is
  // not), from SERVICE_DRAINING (that process is leaving, not broken), and
  // from FEDERATION_UPSTREAM_* (a REMOTE registry, not our own backing store).
  // Transient — retry with backoff. CP-local SCREAMING_SNAKE like
  // SERVICE_DRAINING: RFC-ACDP-0007 §5's closed enum has no 503 code.
  DEPENDENCY_UNAVAILABLE = "DEPENDENCY_UNAVAILABLE",
}
