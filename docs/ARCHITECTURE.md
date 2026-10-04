# ACDP Control Plane — Architecture

## System Context

The ACDP Control Plane is a NestJS service that sits **downstream** of the ACDP
registries (which authoritatively store contexts and emit lifecycle webhooks) and
**upstream** of any UI / playground / observer. It:

1. **Ingests** webhook events from registries (HMAC-SHA256 authenticated).
2. **Correlates** events into *runs* via the `X-Run-Id` header.
3. **Persists** raw events, run records, and a lineage adjacency table.
4. **Broadcasts** the firehose via SSE — both per-run and global feeds.
5. **Proxies** federated context retrievals to the authoring registry (SSRF-gated).
6. **Authenticates & authorizes** callers (API keys + JWT issuance + federation),
   isolates them by **tenant**, and gates actions with **policy** and **quota**.
7. **Audits & witnesses** registry honesty: cross-checks embedded registry
   receipts (RFC-ACDP-0010), witnesses transparency-log checkpoints and audits
   inclusion proofs (RFC-ACDP-0012), verifies producer key-revocation contexts
   (RFC-ACDP-0014), and mints/consumes witness cosignatures with N-witnessed
   quorum (RFC-ACDP-0015).

> Where this service mirrors protocol or registry behavior (crypto, SSRF, did:web,
> auth challenge-response, tenancy, webhook event shapes), it relies on the
> [`acdp` SDK](https://github.com/agentcontextdistributionprotocol/acdp-rs) and
> tracks the [registry](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs)
> rather than re-implementing. See the ecosystem map in [README.md](./README.md#ecosystem--sources-of-truth).

```
              ┌──────────────────────┐
              │   ACDP Registry A    │──┐
              └──────────────────────┘  │  POST /ingest/acdp
              ┌──────────────────────┐  │  (HMAC-SHA256,
              │   ACDP Registry B    │──┼──  X-Run-Id header)
              └──────────────────────┘  │
                                        ▼
   ┌──────────────────────────────────────────────────────────────┐
   │                     ACDP Control Plane                         │
   │                                                                │
   │  Four global guards (in order):                                │
   │    AuthGuard ─► ThrottleByUserGuard ─► PolicyGuard ─► QuotaGuard│
   │       │ pins req.tenantId, actorDid, scopes                    │
   │       ▼                                                        │
   │  IngestController ─► IngestService (HMAC verify, JSON parse,   │
   │       │              enrollment + domain-pack gate)            │
   │       ▼                                                        │
   │  EventProcessorService (the pipeline core)                     │
   │     ├─ dedup (fingerprint) + persist raw (context_events)      │
   │     ├─ upsert run (X-Run-Id correlation)                       │
   │     ├─ insert lineage edges (context_published only)          │
   │     ├─ upsert agent / registry                                │
   │     ├─ publish per-run + global SSE                            │
   │     └─ fire outbound webhooks (outbox-tracked)                 │
   │                                                                │
   │  /runs /events /contexts /agents /capabilities /registries    │
   │  /dashboard /webhooks /domain-packs /routing /auth/*          │
   │  /log/witness /.well-known/* /admin/pinned-keys/reload        │
   │  /registries/:authority/log-witness (+alerts, ack)            │
   │  /healthz /readyz /metrics /docs                              │
   └──────────────────────────────────────────────────────────────┘
                 │                │                  │
                 ▼                ▼                  ▼
        ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
        │ PostgreSQL   │  │ Redis (opt.) │  │ SSE consumers    │
        │ (Drizzle ORM)│  │ SSE / quota  │  │ UI / playground  │
        └──────────────┘  └──────────────┘  └──────────────────┘
```

## Module layout

```
src/
├── main.ts                    # Entry: .env preload (load-env.ts), then bootstrap()
├── load-env.ts                # Side-effect preload: applyEnvFile(process.env)
├── env-file.ts                # .env parser/merger (util.parseEnv; env wins; missing = no-op)
├── bootstrap.ts               # Boot wiring: pino, helmet, swagger, OTel, migrations, rawBody, shutdown
├── shutdown.ts                # Signal handler: idempotent close, deadline, exit code
├── shutdown-failures.ts       # Destroy-hook failure collector (exit 1 under Nest 12)
├── app.module.ts              # Wiring + the four APP_GUARDs + StreamHub strategy factory
│
├── config/                    # AppConfigService (single home for all process.env reads)
├── db/                        # Drizzle schema, Pool wrapper, programmatic migrate runner
├── middleware/                # Correlation-ID (AsyncLocalStorage), request logger
│
├── auth/                      # AuthGuard, JWT issuance, did:web, federation, revocation
│   └── did-web/               # did:web resolver + SSRF guard (acdp SDK wrappers)
├── tenant/                    # Tenant resolution + DEFAULT_TENANT_ID + lookups
├── policy/                    # PolicyGuard + static/OPA deciders + caching
├── quota/                     # QuotaGuard + memory/Redis windowed counters
│
├── ingest/                    # POST /ingest/acdp + HMAC verify + body caps + gates
├── processor/                 # EventProcessorService — the pipeline core
│
├── storage/                   # Repositories: context-event, run, lineage, agent, registry,
│                              #   context-lifecycle, registry-enrollment, receipt-audit,
│                              #   log-witness, log-cosignature, log-inclusion-audit, key-revocation
├── audit/                     # Receipt audit (RFC-ACDP-0010), checkpoint witness +
│                              #   log-inclusion audit (RFC-ACDP-0012), Merkle log-verify,
│                              #   cosignature helpers, registry-profile probe,
│                              #   key-revocation audit (RFC-ACDP-0014)
├── witness/                   # Witness cosigning (RFC-ACDP-0015): signing service +
│                              #   /log/witness, /.well-known/acdp-witness.json, did.json
├── webhooks/                  # Outbound webhook subs + outbox-tracked delivery + retry sweep
├── events/                    # StreamHub (memory + redis strategies), /events controller
├── runs/                      # /runs controller + service
├── contexts/                  # Federation proxy + SafeFederationClient (SSRF)
├── agents/                    # /agents + signed capability declare/discovery
├── routing/                   # BanditRouterService (Thompson-sampling agent selection)
├── registries/                # /registries + admin enrollment
├── domain-packs/              # Vertical context_type packs + admin reload
├── dashboard/                 # /dashboard/overview KPIs (tenant-scoped)
├── retention/                 # DataRetentionService (periodic purge)
├── health/                    # /healthz, /readyz + ReadinessService (bounded DB probe)
├── metrics/                   # /metrics (Prometheus)
│
├── contracts/                 # Wire types (AcdpWebhookEvent, AcdpStreamEvent, LineageDag)
├── errors/                    # AppException + ErrorCode + GlobalExceptionFilter
├── telemetry/                 # OTel SDK init + InstrumentationService (all prom-client metrics)
└── common/                    # Shared helpers (retry-after parser, etc.)
```

## The pipeline (`EventProcessorService.process`)

For every **accepted, non-duplicate** event the processor performs these
ordered steps:

| # | Step                       | Mutation                                                                       |
|---|----------------------------|--------------------------------------------------------------------------------|
| 0 | dedup                      | skip if `(tenant_id, fingerprint)` already seen — no side effects (see [INGEST.md](./INGEST.md#idempotency)) |
| 1 | persist raw                | `INSERT INTO context_events` — full payload kept as `raw_payload`, with the ACDP 0.2.0 trust columns (`key_fingerprint`, `receipt_present`) lifted out |
| 2 | run correlation            | `INSERT … ON CONFLICT` into `runs` — bumps `contexts_count`, dedupes registries |
| 3 | lineage edges              | one `INSERT … ON CONFLICT DO NOTHING` into `lineage_edges` per `derived_from`  |
| 3b | lifecycle projection      | `context_retracted` / `context_republished` events upsert `context_lifecycle` (RFC-ACDP-0013 mark-not-delete; lifts `actor` + `reason`) |
| 4 | agent upsert               | `INSERT … ON CONFLICT (tenant_id, agent_did) DO UPDATE` — bumps `last_seen`, `context_count` |
| 5 | registry upsert            | same shape, on `registries`                                                    |
| 6 | broadcast + webhooks       | publish to per-run + global SSE (trust signals pass through as `keyFingerprint`/`receiptPresent`); fire matching outbound webhooks (fire-and-forget) |

Lineage edges are only inserted when `type === 'context_published'` and there is
at least one `derived_from` entry. The DAG is therefore a property of
*published* contexts only. Every write is stamped with the resolving `tenant_id`.

## Request guards (the four-guard chain)

Registered in `app.module.ts` as `APP_GUARD`s and evaluated **in registration
order**. Each later guard depends on state pinned by an earlier one.

| # | Guard                  | Always on? | Opt-in                | Responsibility |
|---|------------------------|------------|-----------------------|----------------|
| 1 | `AuthGuard`            | yes        | `@Public()` bypasses  | API-key or bearer-JWT auth; pins `req.tenantId`, `req.actorDid`, `req.actorScopes`, `req.actorIsAdmin` |
| 2 | `ThrottleByUserGuard`  | yes        | —                     | Coarse per-principal request rate limit (`THROTTLE_LIMIT`/`THROTTLE_TTL_MS`); unauthenticated → client IP, IPv6 per `/64` (`THROTTLE_IPV6_SUBNET_PREFIX`) |
| 3 | `PolicyGuard`          | no-op      | `@CheckPolicy(action)`| Per-action authorization via a pluggable `PolicyDecider` |
| 4 | `QuotaGuard`           | no-op      | `@CheckQuota(action)` | Per-tenant per-action windowed counters; runs **last** so denied requests don't burn an increment |

`/ingest/acdp` is `@Public()` because HMAC is its authentication. See
[POLICY.md](./POLICY.md) for policy/quota detail and [AUTH.md](./AUTH.md) for the
auth model.

## Tenancy

The **tenant** is the unit of data isolation. `AuthGuard` resolves it (from a
tenant-bound API key, the JWT `tenant` claim, or — only in non-strict mode — the
absence of any assertion → `default`) and pins `req.tenantId`. Controllers read
it with `tenantOf(req)` and thread it into every repository call; repositories
filter `WHERE tenant_id = …` and stamp it on writes, with composite conflict
targets that include `tenantId`. A spoofed `X-Tenant-Id` that disagrees with the
signed/bound tenant is rejected. See [TENANCY.md](./TENANCY.md).

## SSE strategies

`StreamHubService` consumes a strategy injected via the `STREAM_HUB_STRATEGY`
token in `AppModule` — services never depend on a concrete strategy.

| Strategy | When to use | Behavior |
|----------|-------------|----------|
| `memory` (default) | single instance | Per-run RxJS `Subject` map + one global `Subject`; per-run subjects GC'd ~60s after the last subscriber disconnects |
| `redis`            | multi-instance HA | Wraps a Redis pub/sub channel (`REDIS_URL`); each instance re-emits inbound messages on local Subjects so any subscriber on any instance receives events |

Heartbeat frames (`event: heartbeat`) are emitted every `STREAM_SSE_HEARTBEAT_MS`
(default 15 s) to keep intermediaries from closing idle connections.

## Webhook outbox + retry

Outbound webhooks are **outbox-tracked**. `EventProcessorService` step 6 writes a
`webhook_deliveries` row (`status='pending'`) **before** HTTP fan-out;
`WebhookService` fires fire-and-forget and updates the row with `status`,
`attempts`, `responseStatus`. The delivery body is signed with HMAC-SHA256 using
the subscription's `secret` (header `X-ACDP-Signature: sha256=…`, event type in
`X-ACDP-Event`).

A background **retry sweep** runs on an interval (`WEBHOOK_RETRY_INTERVAL_MS`,
default 5 min; `≤0` disables) and re-attempts failed/pending deliveries. On a
subscriber `429`, the sweep honors the `Retry-After` header (delta-seconds or
HTTP-date) by persisting `next_attempt_at` to defer the next attempt. Failed
deliveries stay in the table for inspection / replay. Subscriber URLs are
SSRF-gated (HTTPS-only, no IP literals / loopback / private ranges unless
explicitly relaxed for dev).

## Auth, federation & revocation (summary)

- **API keys** (`AUTH_API_KEYS`, tenant-mapped `TENANT_API_KEYS`) and **bearer
  JWTs** issued via `/auth/challenge` + `/auth/token` (Ed25519/ECDSA-P256
  challenge-response). The guard accepts either.
- JWTs from **trusted external issuers** (`TRUSTED_ISSUERS`, each with a required
  `audience`) are accepted via `CrossIssuerValidatorService` (remote JWKS).
- **Revocation is bidirectional**: the CP serves `/auth/revocations` and consumes
  peer feeds (`REVOCATION_FEEDS`) with issuer confinement + durable per-issuer
  cursors, so a single `isRevoked(jti)` check honors local *and* propagated
  revocations.

Full detail in [AUTH.md](./AUTH.md).

## Capabilities, routing & domain packs

- **Signed capability declarations**: agents sign
  `acdp-cap:v1:<agent_did>:<capability_uri>:<declared_at>` with their pinned key;
  `CapabilityService` validates URN/skew/algorithm/signature and persists
  idempotently. Discovery via `/capabilities/search` and `/capabilities/by-agent/*did`.
- **BanditRouterService** layers Thompson-sampling reward-based selection on top
  of capability discovery (state per-instance in V1). Inspect arms at `/routing/stats`.
- **Domain packs** gate inbound `context_type`: when ≥1 pack is registered
  (`DOMAIN_PACKS`), the allowlist is the union of every pack's declared types;
  the base RFC-ACDP-0001 types (`data_snapshot`, `analysis`, `prediction`,
  `alert`) are never gated. See [INGEST.md](./INGEST.md#domain-pack-context_type-gate).

## Transparency, audit & witness (RFC-ACDP-0010 / 0012 / 0014 / 0015)

> **Sources of truth.** The receipt, checkpoint, Merkle-proof, revocation, and
> cosignature wire formats and verification procedures are normative in the
> spec —
> [RFC-ACDP-0010](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/main/rfcs/RFC-ACDP-0010-registry-receipts.md)
> (receipts),
> [RFC-ACDP-0012](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/main/rfcs/RFC-ACDP-0012-transparency-log.md)
> (transparency log),
> [RFC-ACDP-0014](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/main/rfcs/RFC-ACDP-0014-key-revocation.md)
> (producer key-revocation),
> [RFC-ACDP-0015](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/main/rfcs/RFC-ACDP-0015-witness-cosigning.md)
> (cosigning) — and the registry side is documented in
> [acdp-registry-rs/docs/RECEIPTS.md](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/RECEIPTS.md).
> This section is **not** a restatement of those — it describes only what *this
> service* does as an observer: which sweeps run, what each records, and where
> the verdicts surface.

Four independent, advisory-locked sweeps make the control plane a second
observer of registry honesty — each gated by its own env flag and each
recording verdicts in its own table so the signals stay independent:

| Sweep | Verifies | Evidence table | Surfaces |
|-------|----------|----------------|----------|
| `ReceiptAuditService` | Embedded `registry_receipt` vs the event: profile coverage, structural equality, `created_at` skew, full signature (keys from producer/registry DID docs); when enabled, ALSO classifies the signer against verified revocations (RFC-ACDP-0014 §7, below) and retroactively AMENDS already-sealed verdicts a later-discovered revocation predates (Phase 15, below) | `receipt_audits` | `trust` member on `GET /runs/:runId`; `acdp_receipt_audits_total{status}`; `acdp_receipt_audit_key_revocation_total{status}`; `acdp_receipt_audit_revocation_reaudits_total{status}`; dashboard `receiptCoverage`, `keyRevocation` |
| `CheckpointWitnessPollerService` | Fetches each log-advertising registry's `GET /log/checkpoint` and runs the RFC-ACDP-0012 checkpoint + consistency checks against the head it retains | `log_witness_checkpoints` + `log_witness_cursors` | `GET /registries/:authority/log-witness`; `log_witness_alert` SSE/webhook on state transition; `acdp_log_witness_alerts_total{reason}` |
| `LogInclusionAuditService` | Rebuilds the leaf from OUR stored receipt, fetches `/log/proof?ctx_id=`, runs the RFC-ACDP-0012 inclusion check, and cross-binds against witnessed heads | `log_inclusion_audits` | verdicts `included` \| `invalid_proof` \| `not_logged` \| `no_log` \| `error` |
| `RevocationAuditService` | Discovers `key-revocation` contexts by `context_type`, recomputes `content_hash`, verifies the body signature, then `AcdpVerifier.parseKeyRevocation` for the RFC-ACDP-0014 §4/§5 shape + not-self-signed checks; a `registry_attested` result additionally requires the §6 registry-binding cross-check; then walks the revocation's full lineage (RFC-ACDP-0014 §7, below); every pass, also triggers `ReceiptAuditService`'s retroactive re-audit fan-out (Phase 15, below) for every known-revoked fingerprint | `key_revocations` (permanent, retention-exempt) + `key_revocation_lineage_cursors` (TTL freshness markers) | `acdp_key_revocation_checks_total{status, trust_class}`; `acdp_key_revocation_lineage_members_total{status}` |

**The §7 lineage walk.** A single webhook-delivered revocation only proves
one context exists; RFC-ACDP-0014 §4's earliest-`compromised_since` rule is
defined over the *whole lineage*, including members this control plane was
never webhooked about (published before enrollment, or naming an earlier
key). After persisting a freshly-verified event's own fact,
`RevocationAuditService` walks that lineage via `GET /lineages/{lineage_id}`
— **never** `GET /lineages/{lineage_id}/current`, because a lineage whose
members are all superseded or retracted 404s there (RFC-ACDP-0013 §8.3),
which is exactly the case the fold most needs. Two rules are easy to get
backwards and are worth stating plainly: **supersession does not disarm** a
revocation unless the superseding context is itself a revocation of the same
signer class (RFC-ACDP-0003 §3.1 constrains supersession by `agent_id`/
version/lineage, but not by `type`), and **retraction does not un-revoke** —
a retracted revocation still counts in the fold. The walk's failure
discipline (`src/audit/revocation-lineage.ts`) is deliberately asymmetric: a
member that fails verification *permanently* is dropped with a warning and
the rest still fold (otherwise one injected garbage member suppresses every
genuine revocation in the lineage — a denial of service the walk exists to
avoid), while a member that fails *transiently* (DID host unreachable,
registry erroring) aborts the **whole** walk with no partial fold recorded —
a dropped-but-would-have-been-earlier member would silently move the fold
later, a genuine false authorization rather than a mere omission.
`classifyLineageFailure` is the one place this transient/permanent (plus a
third, "hard" — a lineage too large to fetch safely, aborted the same as
exceeding `MAX_LINEAGE_WALKS`) classification lives, shared by this walk and
the per-event fetch above. A `key_revocation_lineage_cursors` row is a
TTL-bounded freshness marker only, written *exclusively* on a fully
successful walk — every failure kind leaves it unset so the next sweep
retries — and its presence alone is never sufficient to skip a walk: if
`key_revocations` currently holds zero facts for a lineage, the walk runs
regardless of cursor freshness, because a cached "walked, found nothing"
marker suppressing a walk is precisely how a revocation gets missed.
Every member verdict the walk computes — including on an aborted walk, for
whichever members were evaluated before the abort — is counted on
`acdp_key_revocation_lineage_members_total{status}` (issue #173), a metric
kept genuinely distinct from `acdp_key_revocation_checks_total` above despite
sharing the identical status vocabulary: that counter is the webhook-CANDIDATE
sweep's own outcomes, this one is the PER-MEMBER outcomes a lineage walk
discovers on its own, and folding them would both double-count and make
"how many candidates" vs. "how many lineage members" unrecoverable from the
metric. A failed walk leaves no cursor, so an unresolved lineage's members
are re-counted every sweep — read this counter as a rate of observations,
not a census of affected members.

**§7 consumer classification (Phase 14).** The revocation FACTS above are
inert until something CONSUMES them against actual receipt-audited traffic —
that's `ReceiptAuditService`'s job when `KEY_REVOCATION_CHECK_ENABLED`.
`classifyKeyRevocation` (`src/audit/receipt-audit.service.ts`) wraps the
SDK's `AcdpVerifier.classifyUnderRevocation`, and is a separate verification
verdict from the receipt audit's own `status` — a registry can be perfectly
honest about a receipt whose signer has since had their key revoked. The one
thing worth knowing about the SDK's response shape: a fail-closed verdict
(§7 steps 3-4 — the publish landed at/after the compromise boundary, or no
receipt-verified time exists to compare at all) reports
`authorization:"none"`, the SAME value the "no revocation applies at all"
case reports — so this code disambiguates on the PRESENCE of the response's
`boundary` field, never on `authorization` alone. `KEY_REVOCATION_ATTESTED_SCOPE`
/ `KEY_REVOCATION_IGNORE_FINGERPRINTS` (§6/§13 policy) are enforced HERE, at
classification time — `RevocationAuditService` above always records every
binding-verified fact regardless of scope; only the consumer decides whether
to act on it. Verdicts land in four new `receipt_audits` columns and surface
on `trust.revoked` (`GET /runs/:runId`), the dashboard `keyRevocation` tile,
and a metric kept deliberately separate from `RevocationAuditService`'s own
(`acdp_receipt_audit_key_revocation_total{status}` vs.
`acdp_key_revocation_checks_total{status, trust_class}`) — the two use
disjoint status vocabularies (boundary classification vs. revocation-body
verification outcome) that a shared metric name would make meaningless.

**Retroactive re-audit (Phase 15).** §7 classification above only fires at
AUDIT TIME. A revocation whose `compromised_since` predates already-sealed
history — RFC-ACDP-0014 §4's own advice to producers to choose T
conservatively, i.e. *early* — would otherwise leave those old verdicts
reporting `verified` forever: `findUnauditedPublishes` excludes anything
already audited, and its lookback window means old rows are never revisited.
`ReceiptAuditService.reauditForFingerprint` closes that gap by AMENDING an
already-sealed `receipt_audits` row IN PLACE, called by
`RevocationAuditService.sweep()` for every fingerprint it currently holds a
verified fact for, every pass — not only newly-recorded ones, so a
fingerprint whose fan-out exceeds one batch (`RECEIPT_AUDIT_BATCH_SIZE`,
reused rather than a dedicated knob) converges over subsequent sweeps.
The amendment is deliberately in-place rather than a parallel table (unlike
`log_inclusion_audits`'s independence from `receipt_audits` under
RFC-ACDP-0012 §9.3): a §7 fail-closed changes the MEANING of the receipt
verdict itself — the receipt stays cryptographically valid, that is exactly
what places it inside the compromise window — so reporting `verified` in one
table while a fail-closed sits unnoticed in a second table would be a worse
trap than a documented in-place amendment. Three guarantees, all enforced at
the SQL layer, not just in application code
(`ReceiptAuditRepository.amendKeyRevocation`): **monotone** — the `UPDATE`'s
own `WHERE key_revocation_status = 'none' OR compromise_boundary >
:newBoundary` means the column can only ever move EARLIER (more severe),
never later, and a row at its tightest known boundary can never be reached
by this statement again — which is also what makes batching self-advancing
with no separate cursor table (a row simply stays, or leaves, the candidate
set based on whether a strictly tighter boundary currently exists for it);
**column-scoped** — the `SET` clause touches only the four §7 columns, never
`status`/`discrepancies`/`skew_ms`/`receipt_created_at`/`event_arrived_at`/
`checked_at`; **auditable** — `key_revocation_sources` on the amended row
names the revocation `ctx_id`(s) that drove it, same as at live audit time.
A SECOND, earlier-dated revocation for a fingerprint already amended by a
first correctly RE-TIGHTENS every affected row, not just the ones still at
`'none'` — `findRevocationAmendmentCandidates` takes the fact set's current
minimum boundary as a parameter and widens its own eligibility predicate to
match; an earlier "amend-once" design that didn't do this was flagged as
fail-open during Phase 15's verification gate and fixed (ASSUMPTIONS.md).
Two accepted, permanent limitations remain (ASSUMPTIONS.md): candidate
selection joins on `context_events.key_fingerprint`, the registry-CLAIMED
value at publish time, so a pre-ACDP-0.2.0 event that never populated the
column is permanently unreachable by this fan-out; and because
`DataRetentionService` purges `context_events` but never `receipt_audits`,
a `receipt_audits` row for a retention-purged event becomes a permanent
orphan — invisible to this fan-out from then on, frozen at its last verdict.

On top of witnessing, the CP can **cosign**: a checkpoint that passes the
RFC-ACDP-0015 witness obligation is signed with a dedicated Ed25519 witness key
(`WITNESS_ID` + `WITNESS_SIGNING_PRIVATE_KEY_PEM` — never the JWT key) and
served at `GET /log/witness`; the mirror side consumes registry-aggregated
cosignatures and evaluates the **N-witnessed quorum** (`WITNESS_QUORUM_*`),
recording `meets_quorum` per witnessed head. All the crypto is delegated — JCS,
Ed25519, DID/key lifecycle, and the receipt/log verification come from the
`acdp` SDK: the log surface reached the published binding in `acdp` 0.6.0 and
the pinned floor is now `^0.14.1`, so `sdkHasLogSurface()` feature-detects it
and the §9.1/§9.2 folds delegate to the binding in practice, with
`src/audit/log-verify.ts` (RFC 9162 folds transcribed from the RFC) kept as
the fallback for an older binding and cross-checked against the SDK path by
`log-verify.parity.spec.ts`. Registry-side *aggregation* of cosignatures into
`/log/checkpoint` (RFC-ACDP-0015 §6.1) is NOT implemented here — the CP is a
witness (and, independently, an optional quorum consumer of another
registry's aggregated cosignatures), never a registry itself. Transport/DID
failures are treated as environmental
(`consecutive_failures`), never dishonesty alerts; the retained head advances
only on full success.

## Operational concerns

- **Migrations** run programmatically at boot (`src/db/migrate.ts`) from SQL
  files committed under `drizzle/` (no `drizzle-kit` at runtime). Applied
  migrations are tracked in `_migrations`.
- **Readiness** (issue #210): `GET /readyz` is drain-first (`DrainState`, #192),
  then asks `ReadinessService` (`src/health/readiness.service.ts`) — the single
  authority for dependency health, itself drain-agnostic. Its database check is
  `SELECT 1` on the **shared** app pool (so it measures what a request would get,
  checkout included), bounded by pg's `query_timeout` and an outer deadline of
  `READINESS_DB_TIMEOUT_MS`, **single-flight** (one probe query at a time, held
  until the query really settles, so probes never pin more than one pool client)
  and **cached** for `READINESS_CACHE_MS`. Not ready → `503
  DEPENDENCY_UNAVAILABLE` with an enum reason (`error`/`timeout`), never driver
  text. Because cost is bounded by the cache rather than the request rate, the
  whole `HealthController` is `@SkipThrottle()`; successful probe request-log
  lines are `debug`. State changes log once (`readiness changed`) and move
  `acdp_dependency_up` / `acdp_readiness_checks_total`. Single-flight relies on
  the pool's own bounds releasing a stuck probe, hence `DB_POOL_CONNECTION_TIMEOUT
  > 0` at boot.
- **Liveness** (issue #210 Phase 2): `GET /healthz` answers "is this process
  wedged?" and **never awaits I/O** — the CP equivalent of the registry's
  `/livez`. A database outage is not fixed by a restart, so its status is 200
  whenever the process can answer (only the #192 drain gate 503s it, in
  `closing`). Its in-band `ok` mirrors `ReadinessService.snapshot()`, the last
  readiness verdict; a missing or stale (older than `max(READINESS_CACHE_MS,
  5000)` ms) snapshot starts a fire-and-forget `evaluate()` — the same
  single-flight probe — except while draining. There is no pool-error latch: a
  pool `'error'` (an idle client lost its socket; pg-pool reconnects on demand)
  is logged by `DatabaseService` and counted on `acdp_db_pool_errors_total` by
  a second listener `ReadinessService` attaches (it, not the global
  `DatabaseModule`, can see `InstrumentationService`).
- **Report-only dependencies and pool gauges** (issue #210 Phase 3):
  `ReadinessService` adds `checks.streamHub` / `checks.quotaStore`
  (`{ status, required: false }`) when Redis backs the stream hub or the quota
  store, read synchronously from the ioredis connection state. They **never**
  affect `ready`: Redis loss degrades cross-replica SSE fan-out (quota fails
  open) and hits every replica alike, so gating would turn a partial
  degradation into a total outage. The same sources feed
  `acdp_dependency_up{dependency="redis_stream_hub"|"redis_quota_store"}`, and
  `acdp_db_pool_connections{state="total"|"idle"|"waiting"}` reads the pool at
  scrape time, so operators can tell "DB down" from "pool saturated".
- **Graceful shutdown** via `src/shutdown.ts`: a single idempotent handler on
  SIGINT/SIGTERM first **begins the drain** (issue #192), optionally waits
  `SHUTDOWN_DRAIN_DELAY_MS`, and then calls `app.close()`. `DrainState` moves
  through three monotone phases, `serving → draining → closing`. Drain sequence:
  1. `DrainState.begin()` (`src/shutdown-drain.ts`, a global provider with no
     lifecycle hooks, resolved once in `bootstrap.ts`) enters `draining` — the
     single "are we shutting down?" source — and fires its replaying
     `drained$`. From this moment `GET /readyz` answers `503 SERVICE_DRAINING`
     **without querying the database**: the health controller checks the drain
     first (readiness = `!draining && deps ok`, one code path), so a load
     balancer stops routing here. Every open SSE
     stream (both routes share `src/events/sse-drain.ts`) writes a terminal
     `event: shutdown` with a `retry:` hint and completes. A stream opened
     *after* this point gets the same event at once and never subscribes to the
     stream hub, and `/runs/:runId/events/stream` skips its DB lookup. This runs
     before any destroy hook, so it does not depend on module destroy order or
     on the stream-hub strategy. `StreamHubService`'s teardown stays as the
     backstop.

     **Optional drain delay (Phase 3).** With `SHUTDOWN_DRAIN_DELAY_MS` > 0 the
     handler now waits that long in `draining` before going on. During the
     delay **every other route keeps serving** (the pool is still alive) — the
     point is that a lagging load balancer's requests still succeed while it
     notices the failing readiness probe and deregisters the instance. The
     wait is `unref()`'d and cancellable: a second signal skips the rest of it
     (log `second signal — skipping drain delay`) and never re-enters
     `close()`. The deadline covers only `close()`, so the worst case is delay
     + timeout. Default 0: no timer, and the next step follows in the same
     tick — the Phase 1–2 timing exactly.

     Then `DrainState.beginClosing()` enters `closing`. From that moment, every
     **new** non-SSE request is answered
     `503 SERVICE_DRAINING` (`Retry-After`, `Connection: close`, the JSON
     envelope, CORS and helmet headers, an `X-Request-Id` and a request-log
     line). "New" is decided **at arrival**: a plain Express middleware
     registered in `bootstrap.ts` *before* the body parsers stamps
     `DrainState.phase()` onto the request as soon as its headers are
     parsed (`createDrainArrivalMarker`), and the drain gate
     (`src/middleware/drain-gate.middleware.ts`, module middleware after the
     correlation-id and request-logger middleware, so before every guard)
     decides from that stamp alone — `closing` is rejected, `serving` and
     `draining` pass (the gate has no readiness rule; in `closing` its generic
     503 covers `/readyz` too). Module middleware only runs after the body
     parsers, so a gate reading the live flag would 503 a request whose headers
     arrived before the signal and whose body finished after it. `GET` on the
     two SSE routes is exempt and takes the subscribe-after-drain path above,
     because a non-2xx would stop an `EventSource` from ever reconnecting. A
     CORS preflight is ended by `cors()` (204) before it reaches the gate.
  2. `app.close()` runs the destroy hooks, then Nest's `dispose()` calls
     `httpServer.close()`. That stops the listener and closes the sockets that
     are idle at that moment, once. A 100 ms idle-socket reaper started when the
     close begins calls `server.closeIdleConnections()` on every tick, but **only once
     `server.listening` is false**: `closeIdleConnections()` also destroys a
     just-accepted socket that has not sent its request line yet. Sockets that go
     idle during the close (every SSE stream after its `shutdown` event, every
     request that finishes) are reaped within ~100 ms. Without the reaper they
     would linger for `keepAliveTimeout` + buffer (~6 s), which made shutdowns
     with SSE clients take ~6 s and, with `SHUTDOWN_TIMEOUT_MS` below that,
     exit 1 spuriously. Measured: SIGTERM → exit 0 in ~110 ms with two open
     streams, down from ~6000 ms. In-flight requests are never touched by the
     reaper and keep their full grace.

  Nest's `forceCloseConnections` and `return503OnClosing` adapter options stay
  off: the first drops in-flight requests and still exits 0, and the second's
  bare `text/html` 503 bypasses the error envelope, CORS and `Retry-After`, and
  503s SSE reconnects too (see `plans/graceful-drain-192.md`).

  Each shutdown ends with one structured `shutdown drain complete` line
  (`drainMs`, `drainDelayMs`, `sseStreamsTerminated`, `drainRejections`,
  `forcedConnections`).
  On an overrun the handler first reads a synchronous open-socket count
  (`trackOpenConnections`, never the callback-async `getConnections()`) and logs
  it as `forcedConnections` before `closeAllConnections()`.

  `app.close()` runs every `OnModuleDestroy`, so
  `DatabaseService` drains its pool, `StreamHubService` completes all Subjects and
  background timers are cleared — then flushes OpenTelemetry, then exits 0. The
  close is bounded by `SHUTDOWN_TIMEOUT_MS` (default 10s, an integer ≥ 1000 or boot fails; keep it below the
  platform's termination grace period): `http.Server.close()` waits for active
  connections, so one in-flight request would otherwise hold shutdown open until
  the orchestrator SIGKILLed the process. On overrun the handler drops lingering
  sockets and exits **1**, because a shutdown that dropped live requests is not a
  clean one. A failed destroy hook also exits **1**. NestJS 12 runs destroy
  hooks under `Promise.allSettled` and only *logs* a rejection, so `app.close()`
  resolves even when `pool.end()` throws. To catch this, every hook that releases
  an external resource (`DatabaseService`, `IssuanceLedgerService`, `QuotaModule`,
  `StreamHubService`) runs its teardown through `ShutdownFailures.track()`
  (`src/shutdown-failures.ts`). The handler reads the collector after the close
  (issue #155). A new resource-owning hook must do the same. The boot wiring lives
  in `src/bootstrap.ts`. `main.ts` only preloads `.env` and calls it, so
  `test/fixtures/faulty-teardown.main.ts` can drive a real failing teardown.
  `enableShutdownHooks()` is deliberately **not** called: it would register Nest's
  own signal listeners *in addition* to ours, running the destroy hooks twice
  (`pool.end()` throws "Called end on pool more than once", the process exits 1 and
  telemetry is never flushed — issue #158). `app.close()` already runs the destroy
  and shutdown hooks by itself, and nothing in `src/` implements
  `OnApplicationShutdown`.
- **Background services**: `WebhookService` retry sweep, `AuthSweeperService` (GCs
  expired challenges / revocations / ledger), `RevocationPollerService` (consumes
  peer feeds), `DataRetentionService` (off unless `DATA_RETENTION_ENABLED`),
  plus the four advisory-locked audit sweeps — `ReceiptAuditService`
  (`RECEIPT_AUDIT_ENABLED`), `CheckpointWitnessPollerService`
  (`LOG_WITNESS_ENABLED`), `LogInclusionAuditService`
  (`LOG_INCLUSION_AUDIT_ENABLED`), and `RevocationAuditService`
  (`KEY_REVOCATION_CHECK_ENABLED`, requires `RECEIPT_AUDIT_ENABLED=true`).
- **Boot assertions (witness)**: with `WITNESS_COSIGNING_ENABLED=true`, a
  `did:web` `WITNESS_ID` whose host disagrees with `PUBLIC_HOST` is fatal at
  boot (RFC-ACDP-0015 §9), and cosigning without `LOG_WITNESS_ENABLED=true`
  refuses to start — the cosigner rides the checkpoint witness.
- **Observability**: pino structured logs, Prometheus metrics
  on `/metrics` (all constructed in `InstrumentationService`), optional OTel SDK
  (`OTEL_ENABLED=true`). Metric inventory in [API.md](./API.md#observability).
- **Logging shape**: `CorrelationIdMiddleware` assigns (or honours an inbound)
  `x-request-id`, echoes it on the response, and holds it in an
  `AsyncLocalStorage` (`src/common/correlation.ts`). `PinoLogger` merges that
  id into **every** line as `requestId`, so a failure logged inside a service
  ties back to the request that caused it; outside a request — the retention,
  receipt-audit and witness sweeps — the field is omitted rather than
  placeholdered. An **object** passed as the message becomes top-level pino
  fields (`msg` is the human summary), which is how the per-request HTTP
  summary emits `method` / `path` / `statusCode` / `durationMs` / `requestId`
  as indexable fields instead of a JSON string. `LOG_LEVEL` sets the
  threshold; dev mode routes through `pino-pretty` when it resolves.
- **Multi-instance**: requires `AUTH_PERSISTENCE=postgres` (shared challenge /
  revocation / ledger state), `STREAM_HUB_STRATEGY=redis`, and a Redis-backed
  quota store — otherwise per-process state diverges. Startup warns when it
  detects production + a single-process default.
- **Dev sandbox**: when `WEBHOOK_SECRET` is empty, HMAC verification is
  **skipped** (the config service fails startup in production). Never use in
  production.

### Deploying behind a load balancer

The listener closes within milliseconds of SIGTERM unless something holds it, so
a load balancer that has not yet noticed the stopping instance routes requests to
a closed port (refused/reset). `SHUTDOWN_DRAIN_DELAY_MS` (issue #192, Phase 3,
default `0`) is the opt-in fix: for that long after the signal `/readyz` returns
`503 SERVICE_DRAINING` while every other route keeps serving, and only then does
the close begin. Set it **or** a Kubernetes `preStop: exec: sleep N` hook, not
both — `preStop` delays the SIGTERM itself but does not flip `/readyz`, and
stacking the two simply adds them. Two inequalities must hold:

- **Termination grace covers the whole drain.**
  `terminationGracePeriodSeconds ≥ (SHUTDOWN_DRAIN_DELAY_MS + SHUTDOWN_TIMEOUT_MS)/1000 + 5`.
  Otherwise the platform SIGKILLs (exit 137) before the forced path can run.
  With `5000` + the default `10000` that is ≥ 20 s (Kubernetes' default 30 s is
  enough). Startup warns when delay + timeout exceeds 25000 ms. For Docker
  Compose the equivalent is `stop_grace_period` (default 10 s, equal to the
  default `SHUTDOWN_TIMEOUT_MS`; `docker-compose.yml` sets 15 s).
- **The readiness probe notices the drain inside the delay.**
  `periodSeconds × failureThreshold` (in ms) must be **shorter** than
  `SHUTDOWN_DRAIN_DELAY_MS`, with margin for the endpoint change to propagate
  to the load balancer. Example: `periodSeconds: 1`, `failureThreshold: 2` →
  2000 ms < 5000 ms. Otherwise the listener closes before the probe has failed
  often enough to deregister the pod.

```yaml
# Illustrative pod spec fragment (the repo ships no manifests).
env:
  - { name: SHUTDOWN_DRAIN_DELAY_MS, value: "5000" }
  - { name: SHUTDOWN_TIMEOUT_MS, value: "10000" }
terminationGracePeriodSeconds: 30   # >= (5000 + 10000)/1000 + 5 = 20
readinessProbe:
  httpGet: { path: /readyz, port: 3001 }
  periodSeconds: 1
  timeoutSeconds: 2                 # > READINESS_DB_TIMEOUT_MS (default 1000 ms, #210)
  failureThreshold: 2               # 2 s to notice < 5 s delay
livenessProbe:
  httpGet: { path: /healthz, port: 3001 }   # never touches the DB (#210)
startupProbe:
  httpGet: { path: /healthz, port: 3001 }
```

**Which probe goes where (issue #210).** Point `livenessProbe` and
`startupProbe` at `/healthz` — it never awaits the database, so a DB outage can
never restart-storm the fleet — and `readinessProbe` at `/readyz` with
`timeoutSeconds ≥ 2`. Docker has no readiness concept, so the image's
`HEALTHCHECK` stays on `/healthz` (2xx = healthy); read `/readyz` (or the
`ok` field of `/healthz`) for dependency health.

Registry webhooks benefit too: the registry's default webhook `max_retries = 3`
gives a retry window of only ~750 ms. During the delay `/ingest/acdp` is still
served, so deliveries keep succeeding while the load balancer deregisters this
instance instead of hitting a 503 or a refused port and being dropped after
three quick retries.
