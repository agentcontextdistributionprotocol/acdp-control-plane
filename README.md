# ACDP Control Plane

Scenario-agnostic control plane for the Agent Context Distribution Protocol
(ACDP). Ingests webhook events from ACDP registries, correlates them into runs
via the `X-Run-Id` header, persists raw events + lineage edges, and broadcasts
the firehose via Server-Sent Events.

Also acts as the federation **IdP**: issues bearer JWTs via challenge/sign/token,
introspects them per RFC 7662, and revokes them per RFC 7009. The auth surface
is tenant-aware (per-tenant API keys), policy-gated, and audited via an
append-only hash-chain ledger.

## Architecture

```
              ┌──────────────────────────────────────────┐
              │              ACDP Registry               │
              └────────────────────┬─────────────────────┘
                                   │ POST /ingest/acdp (HMAC, X-Run-Id)
                                   ▼
   ┌───────────────────────────────────────────────────────┐
   │                  ACDP Control Plane                   │
   │                                                       │
   │  Guards: Auth → Throttle → Policy → Quota             │
   │       │  (pins req.tenantId, actorDid, scopes)        │
   │       ▼                                               │
   │  IngestController → IngestService (HMAC verify,       │
   │       │              enrollment + domain-pack gate)   │
   │       ▼                                               │
   │  EventProcessorService                                │
   │     ├─ dedup (fingerprint) + persist raw event        │
   │     ├─ upsert run (X-Run-Id)                          │
   │     ├─ insert lineage edges                           │
   │     ├─ upsert agent + registry                        │
   │     ├─ publish per-run + global SSE                   │
   │     └─ fire outbound webhooks (outbox-tracked)        │
   │                                                       │
   │  /runs /events /contexts /agents /capabilities        │
   │  /registries /dashboard /webhooks /domain-packs       │
   │  /routing /auth/* /healthz /readyz /metrics /docs     │
   └───────────────────────────────────────────────────────┘
```

Every request crosses four guards in order — **Auth → Throttle → Policy →
Quota** — and resolves to a **tenant** that scopes all reads and writes. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

```bash
docker compose up -d postgres
npm install
cp .env.example .env
npm run start:dev
# → http://localhost:3001/docs
```

## Testing

```bash
npm test                       # unit tests (mocked deps, no DB)
npm run test:integration       # boots app + real Postgres on :5433
```

See [docs/TESTING.md](docs/TESTING.md) for the test harness, helpers, and how to
add a new spec.

## Capabilities

Beyond the core ingest → correlate → broadcast pipeline, the control plane adds
auth/federation, multi-tenancy, governance, and discovery. Everything below is
opt-in via env var; defaults keep single-tenant deployments behavior-identical.
Full env reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

### Auth / federation — [docs/AUTH.md](docs/AUTH.md)

| Capability | Endpoint(s) | Env var | Notes |
|---|---|---|---|
| Token issuance (IdP) | `POST /auth/challenge`, `POST /auth/token` | `TOKEN_ISSUANCE_ENABLED=true`, `JWT_SECRET` (≥32 bytes) or `JWT_PRIVATE_KEY_PEM`, `JWT_SIGNING_ALG=HS256\|EdDSA`, `JWT_AUTHORITY`, `JWT_AUDIENCE`, `JWT_TTL_SECONDS`, `CHALLENGE_TTL_SECONDS` | Challenge → sign with Ed25519 or ECDSA-P256 → HS256 or EdDSA JWT |
| Token revocation (RFC 7009) | `POST /auth/token/revoke` | — | Admin or self-revoke; RFC §2.2 no-oracle behavior |
| Token introspection (RFC 7662) | `POST /auth/introspect` | — | Dispatches on `iss` so peer-issued tokens are also accepted |
| Cross-issuer federation | (validation) + `GET /.well-known/jwks.json` | `TRUSTED_ISSUERS=iss\|HS256\|secret\|audience[\|scope],... ` or `iss\|EdDSA\|jwks-url\|audience` | HS256 (shared secret) **and** EdDSA (remote JWKS) peers; `audience` required per entry |
| Bidirectional revocation | serves `GET /auth/revocations`; consumes peers | `REVOCATION_FEEDS=issuer\|url\|admin_token[\|poll_seconds],...` | Issuer-confined, durable per-issuer cursor |
| did:web key resolution | (used by `/auth/token` fallback) | — | SSRF-guarded, content-type checked, body-capped |
| Pinned-key directory | `POST /admin/pinned-keys/reload` | `CONTROL_PLANE_PINNED_KEYS=did=B64KEY[:alg][:from..until],...` | Admin-reloadable; default alg `ed25519` |
| Persistent auth stores | — | `AUTH_PERSISTENCE=memory\|postgres`, `AUTH_SWEEP_INTERVAL_SECONDS` | `postgres` required for multi-replica |
| Issuance audit ledger | — | (same `AUTH_PERSISTENCE`) | Append-only SHA-256 hash chain; tamper detection via `verifyChain()` |

### Multi-tenancy — [docs/TENANCY.md](docs/TENANCY.md)

| Capability | Env var | Notes |
|---|---|---|
| Tenant-scoped API keys | `TENANT_API_KEYS=tenant-a:key1,tenant-b:key2,bareKey` | `bareKey` (no `tenant:` prefix) binds to `default` |
| Tenant-bound agents (JWT claim) | `TENANT_AGENTS=tenant-a:did:web:…` | Stamps the `tenant` claim on issued JWTs |
| Strict-tenant default-deny | `AUTH_REQUIRE_TENANT=true` | Rejects anything resolving only to `default`; spoofed `X-Tenant-Id` and explicit `default` are rejected |
| Repository-level isolation | — | Every read filters `WHERE tenant_id = ?`; writes stamp `tenantId` (composite conflict keys) |

### Governance / discovery — [docs/POLICY.md](docs/POLICY.md)

| Capability | Endpoint(s) / hook | Notes |
|---|---|---|
| Policy engine | `@CheckPolicy(action)` + `PolicyGuard` | Static-rules **or** OPA backend (`POLICY_BACKEND`), caching decider |
| Per-tenant quota | `@CheckQuota(action)` + `QuotaGuard` | Windowed counters (`TENANT_QUOTAS`); memory or Redis; `429` + `Retry-After` |
| Agent capability registry | `POST /capabilities`, `GET /capabilities/search`, `GET /capabilities/by-agent/*did` | URN `urn:acdp:cap:<verb>:<type>:<domain>`; Ed25519/ECDSA-P256 signed, idempotent |
| Bandit routing | `GET /routing/stats` | Thompson sampling over capability-matched arms; reward channel + `BANDIT_EXPLORATION_FRACTION` |
| Domain packs | `GET /domain-packs` | `DOMAIN_PACKS` gates ingest `context_type` (base RFC types always allowed) |
| Registry enrollment | `POST /registries/enroll`, `GET /registries/enrollments` | Admin-only trust anchor; per-registry webhook secret + `baseUrl`; gates ingest when `INGEST_REQUIRE_ENROLLMENT=true` |

### Swagger / docs

Set `SWAGGER_ENABLED=true` to serve `/docs` in production (defaults on in dev).
`SWAGGER_PATH` overrides the mount path.

## Documentation

Start at the docs index: **[docs/README.md](docs/README.md)** — it maps the
subsystems and the ecosystem (which sibling repo owns what).

| Doc | What's in it |
|-----|--------------|
| [docs/README.md](docs/README.md)               | Index, request-path model, subsystem map, ecosystem & sources of truth |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)   | System context, module layout, the pipeline, the four-guard chain, SSE strategies, webhook outbox |
| [docs/API.md](docs/API.md)                     | Full route reference with request/response shapes |
| [docs/INGEST.md](docs/INGEST.md)               | The webhook contract: HMAC, run correlation, event shape, enrollment, idempotency |
| [docs/AUTH.md](docs/AUTH.md)                   | Auth guard, JWT issuance, did:web, federation, bidirectional revocation |
| [docs/TENANCY.md](docs/TENANCY.md)             | Tenant resolution, strict mode, reserved-`default` rule, isolation |
| [docs/POLICY.md](docs/POLICY.md)               | Policy + quota guards, static/OPA backends, `TENANT_QUOTAS` |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Complete env-var reference + startup validation |
| [docs/TESTING.md](docs/TESTING.md)             | Unit + integration test layout and how to write a new spec |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common errors and how to diagnose them |
| `CLAUDE.md`                                    | Project conventions for agents working in this repo |

This service is part of the ACDP ecosystem — the
[spec](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol),
the [`acdp` SDK](https://github.com/agentcontextdistributionprotocol/acdp-rs), and
the [registry](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs).
See [docs/README.md](docs/README.md#ecosystem--sources-of-truth) for how they fit together.
