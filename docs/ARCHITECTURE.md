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
├── main.ts                    # Bootstrap: pino, helmet, swagger, OTel, migrations, rawBody
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
├── health/                    # /healthz, /readyz
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
| 2 | `ThrottleByUserGuard`  | yes        | —                     | Coarse per-principal request rate limit (`THROTTLE_LIMIT`/`THROTTLE_TTL_MS`) |
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
- **Graceful shutdown** via `src/shutdown.ts`: a single idempotent handler on
  SIGINT/SIGTERM calls `app.close()` — which runs every `OnModuleDestroy`, so
  `DatabaseService` drains its pool, `StreamHubService` completes all Subjects and
  background timers are cleared — then flushes OpenTelemetry, then exits 0. The
  close is bounded by `SHUTDOWN_TIMEOUT_MS` (default 10s, keep it below the
  platform's termination grace period): `http.Server.close()` waits for active
  connections, so one in-flight request would otherwise hold shutdown open until
  the orchestrator SIGKILLed the process. On overrun the handler drops lingering
  sockets and exits **1**, because a shutdown that dropped live requests is not a
  clean one.
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
