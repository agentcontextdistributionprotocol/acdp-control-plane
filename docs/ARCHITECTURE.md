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
├── storage/                   # Repositories: context-event, run, lineage, agent, registry
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

For every **accepted, non-duplicate** event the processor performs **six**
ordered steps:

| # | Step                       | Mutation                                                                       |
|---|----------------------------|--------------------------------------------------------------------------------|
| 0 | dedup                      | skip if `(tenant_id, fingerprint)` already seen — no side effects (see [INGEST.md](./INGEST.md#idempotency)) |
| 1 | persist raw                | `INSERT INTO context_events` (the full payload is kept as `raw_payload`)        |
| 2 | run correlation            | `INSERT … ON CONFLICT` into `runs` — bumps `contexts_count`, dedupes registries |
| 3 | lineage edges              | one `INSERT … ON CONFLICT DO NOTHING` into `lineage_edges` per `derived_from`  |
| 4 | agent upsert               | `INSERT … ON CONFLICT (tenant_id, agent_did) DO UPDATE` — bumps `last_seen`, `context_count` |
| 5 | registry upsert            | same shape, on `registries`                                                    |
| 6 | broadcast + webhooks       | publish to per-run + global SSE; fire matching outbound webhooks (fire-and-forget) |

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

## Operational concerns

- **Migrations** run programmatically at boot (`src/db/migrate.ts`) from SQL
  files committed under `drizzle/` (no `drizzle-kit` at runtime). Applied
  migrations are tracked in `_migrations`.
- **Graceful shutdown** via `enableShutdownHooks()`: `DatabaseService` drains its
  pool, `StreamHubService` completes all Subjects, background timers are cleared.
- **Background services**: `WebhookService` retry sweep, `AuthSweeperService` (GCs
  expired challenges / revocations / ledger), `RevocationPollerService` (consumes
  peer feeds), `DataRetentionService` (off unless `DATA_RETENTION_ENABLED`).
- **Observability**: pino structured logs (per-request JSON), Prometheus metrics
  on `/metrics` (all constructed in `InstrumentationService`), optional OTel SDK
  (`OTEL_ENABLED=true`). Metric inventory in [API.md](./API.md#observability).
- **Multi-instance**: requires `AUTH_PERSISTENCE=postgres` (shared challenge /
  revocation / ledger state), `STREAM_HUB_STRATEGY=redis`, and a Redis-backed
  quota store — otherwise per-process state diverges. Startup warns when it
  detects production + a single-process default.
- **Dev sandbox**: when `WEBHOOK_SECRET` is empty, HMAC verification is
  **skipped** (the config service warns at boot). Never use in production.
</content>
