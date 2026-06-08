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
                                   │ POST /ingest/acdp (HMAC)
                                   ▼
   ┌───────────────────────────────────────────────────────┐
   │                  ACDP Control Plane                   │
   │                                                       │
   │  IngestController → IngestService (HMAC verify)       │
   │       │                                               │
   │       ▼                                               │
   │  EventProcessorService                                │
   │     ├─ persist raw event                              │
   │     ├─ upsert run (X-Run-Id)                          │
   │     ├─ insert lineage edges                           │
   │     ├─ upsert agent + registry                        │
   │     ├─ publish per-run + global SSE                   │
   │     └─ fire outbound webhooks                         │
   │                                                       │
   │  /runs, /events, /dashboard, /contexts (federation)   │
   │  /healthz /readyz /metrics /docs                      │
   └───────────────────────────────────────────────────────┘
```

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

## V2 features

These landed across PRs #4–#25 closing the deferred-plan items.
Everything is opt-in via env var; defaults keep V1 single-tenant
deployments behavior-identical.

### Auth / federation

| Capability | Endpoint(s) | Env var | Notes |
|---|---|---|---|
| Token issuance (IdP) | `POST /auth/challenge`, `POST /auth/token` | `TOKEN_ISSUANCE_ENABLED=true`, `JWT_SECRET` (≥32 bytes), `JWT_AUTHORITY`, `JWT_TTL_SECONDS`, `CHALLENGE_TTL_SECONDS` | Challenge → sign with Ed25519 or ECDSA-P256 → HS256 JWT |
| Token revocation (RFC 7009) | `POST /auth/token/revoke` | — | Bearer-auth gated; RFC §2.2 no-oracle behavior |
| Token introspection (RFC 7662) | `POST /auth/introspect` | — | Dispatches on `iss` so peer-issued tokens are also accepted |
| Cross-issuer federation | (validation only) | `TRUSTED_ISSUERS=iss\|HS256\|secret[\|audience[\|scope]],...` | HS256 only in V1; JWKS later |
| did:web key resolution | (used by `/auth/token` fallback) | — | SSRF-guarded, content-type checked, body-capped |
| Pinned-key directory | — | `CONTROL_PLANE_PINNED_KEYS=did=B64KEY[:ecdsa-p256],...` | `:ecdsa-p256` suffix is optional; default `ed25519` |
| Persistent challenge/revocation stores | — | `AUTH_PERSISTENCE=memory\|postgres`, `AUTH_SWEEP_INTERVAL_SECONDS` | `postgres` is required for multi-replica deployments |
| Issuance audit ledger | — | (same `AUTH_PERSISTENCE`) | Append-only SHA-256 hash chain; tamper detection via `verifyChain()` |

### Multi-tenancy

| Capability | Env var | Notes |
|---|---|---|
| Tenant-scoped API keys | `TENANT_API_KEYS=tenant-a:key1,tenant-b:key2,bareKey` | `bareKey` (no `tenant:` prefix) binds to `default` tenant |
| Tenant-tagged event ingestion | `X-Tenant-Id` header on `POST /ingest/acdp` | `@Public()` endpoint; header is the tenant signal |
| Repository-level isolation | — | Every read filters `WHERE tenant_id = ?`; writes stamp tenantId |

### Discovery / governance

| Capability | Endpoint(s) | Notes |
|---|---|---|
| Agent capability registry | `POST /capabilities`, `GET /capabilities/search`, `GET /capabilities/by-agent/*did` | URN `urn:acdp:cap:<verb>:<type>:<domain>`; Ed25519-signed |
| Policy engine | `@CheckPolicy(action)` decorator + `PolicyGuard` | Static-rules backend; OPA plugin shape |
| Bandit routing scaffold | (programmatic) | Thompson Sampling; no reward channel yet |
| Domain packs scaffold | (programmatic) | `FINANCE_PACK` reference impl |

### Swagger / docs

Set `SWAGGER_ENABLED=true` to serve `/docs` in production (defaults on
in dev). `SWAGGER_PATH` overrides the mount path.

## Documentation

| Doc | What's in it |
|-----|--------------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)   | System context, module layout, the 6-step pipeline, SSE strategies, webhook outbox |
| [docs/API.md](docs/API.md)                     | Full route reference with request/response shapes |
| [docs/INGEST.md](docs/INGEST.md)               | The webhook contract: HMAC signing, run correlation, event shape, idempotency |
| [docs/TESTING.md](docs/TESTING.md)             | Unit + integration test layout and how to write a new spec |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common errors and how to diagnose them |
| `CLAUDE.md`                                    | Project conventions for agents working in this repo |
