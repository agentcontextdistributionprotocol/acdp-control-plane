# ACDP Control Plane — API Reference

Base URL: `http://localhost:3001` (dev). Swagger UI is served at `/docs`
(development; opt-in in production via `SWAGGER_ENABLED=true`, path
`SWAGGER_PATH`).

## Authentication

Every non-`@Public()` route requires a credential in the `Authorization` header:

- **API key** — `Authorization: Bearer <key>` where `<key>` ∈ `AUTH_API_KEYS`
  (or a tenant-bound key in `TENANT_API_KEYS`). When `AUTH_API_KEYS` is empty
  (dev only, non-production), auth is bypassed.
- **Bearer JWT** — a token issued by `/auth/token` or by a trusted external
  issuer (`TRUSTED_ISSUERS`). The guard auto-detects JWT vs opaque key by shape.

Admin-only routes additionally require the key to be in `AUTH_ADMIN_API_KEYS`.
See [AUTH.md](./AUTH.md).

### Tenancy headers

All tenant-owned reads/writes are scoped to the caller's resolved tenant. An
`X-Tenant-Id` header may be sent but is **rejected** if it disagrees with the
JWT `tenant` claim or an API key's bound tenant, or if it asserts the reserved
`default` tenant. With `AUTH_REQUIRE_TENANT=true`, a request that resolves only
to `default` is denied. See [TENANCY.md](./TENANCY.md).

### Error responses

All non-`2xx` responses use a consistent shape (normalized by
`GlobalExceptionFilter`):

```json
{ "statusCode": 404, "errorCode": "RUN_NOT_FOUND", "message": "run X not found" }
```

`errorCode` is one of (`src/errors/error-codes.ts`):
`RUN_NOT_FOUND`, `REGISTRY_NOT_FOUND`, `AGENT_NOT_FOUND`, `CONTEXT_NOT_FOUND`,
`FEDERATION_UPSTREAM_RATE_LIMITED`, `INVALID_PAYLOAD`, `INVALID_SIGNATURE`,
`VALIDATION_ERROR`, `INTERNAL_ERROR`.

Policy denials return `403` with `{ message, code, reason }`; quota exceeded
returns `429` with a `Retry-After` header (see [POLICY.md](./POLICY.md)).

---

## Route index

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/ingest/acdp` | Public (HMAC) | Registry webhook in |
| GET  | `/ingest/health` | Public | Registry config liveness |
| GET  | `/runs` | key/JWT | List runs |
| GET  | `/runs/:runId` | key/JWT | Run detail |
| GET  | `/runs/:runId/lineage` | key/JWT | Lineage DAG |
| GET  | `/runs/:runId/events` | key/JWT | Run events |
| GET  | `/runs/:runId/events/stream` | key/JWT | SSE — per-run |
| POST | `/runs/:runId/complete` | key/JWT | Mark run terminal |
| GET  | `/events` | key/JWT | Cross-run event history |
| GET  | `/events/stream` | key/JWT | SSE — global firehose |
| GET  | `/contexts/*ctxId` | key/JWT (policy) | Federation proxy |
| GET  | `/agents` | key/JWT | Known agents |
| GET  | `/agents/*did` | key/JWT | Agent detail |
| POST | `/capabilities` | key/JWT (policy+quota) | Declare a signed capability |
| GET  | `/capabilities/search` | key/JWT | Find agents by capability |
| GET  | `/capabilities/by-agent/*did` | key/JWT | One agent's capabilities |
| GET  | `/registries` | key/JWT | Known registries |
| GET  | `/registries/enrollments` | key/JWT | Enrolled registries (secrets hidden) |
| POST | `/registries/enroll` | admin | Enroll/update a registry |
| GET  | `/dashboard/overview` | key/JWT | KPIs |
| POST | `/webhooks` | key/JWT | Create subscription |
| GET  | `/webhooks` | key/JWT | List |
| PATCH | `/webhooks/:id` | key/JWT | Update |
| DELETE | `/webhooks/:id` | key/JWT | Remove |
| GET  | `/domain-packs` | key/JWT | List active packs |
| GET  | `/routing/stats` | admin | Bandit router arm state |
| POST | `/auth/challenge` | Public | Request a signing nonce |
| POST | `/auth/token` | Public | Exchange a signed nonce for a JWT |
| POST | `/auth/introspect` | key/JWT | RFC 7662 token introspection |
| POST | `/auth/token/revoke` | self/admin | RFC 7009 token revocation |
| GET  | `/auth/revocations` | admin | Cross-issuer revocation feed |
| GET  | `/.well-known/jwks.json` | Public | CP public JWKS |
| GET  | `/log/witness` | Public | This witness's log cosignatures (RFC-ACDP-0015) |
| GET  | `/.well-known/acdp-witness.json` | Public | Witness capabilities (RFC-ACDP-0015 §9) |
| GET  | `/.well-known/did.json` | Public | Witness DID document (assertionMethod key) |
| POST | `/admin/pinned-keys/reload` | admin | Reload pinned keys from env |
| GET  | `/healthz` `/readyz` `/metrics` | Public | Probes / Prometheus |
| GET  | `/docs` | dev | Swagger UI |

> The list is authoritative against the controllers as of this writing, but
> confirm against `src/**/*.controller.ts` if in doubt.

---

## Ingest

### `POST /ingest/acdp` — receive a registry webhook

**Public** (no Bearer token). Authenticated via HMAC-SHA256. Full contract:
[INGEST.md](./INGEST.md).

**Headers**

| Header | Description |
|--------|-------------|
| `x-acdp-signature` | `sha256=<hex>` of HMAC-SHA256(rawBody, WEBHOOK_SECRET). Skipped when WEBHOOK_SECRET is empty. |
| `x-acdp-event-id` | Optional. Registry-minted event id, used for idempotency. |
| `x-run-id` | Optional. Correlates this event into a run. Takes precedence over `payload.run_id`. |
| `x-tenant-id` | Optional. Tenant binding (subject to enrollment / strict-tenant rules). |
| `Content-Type` | `application/json` |

**Body** — see [INGEST.md](./INGEST.md). Required fields: `type`,
`registry_authority`, and `agent_id` (required for `context_published`).

**Responses**

| Status | Meaning |
|--------|---------|
| `204` | Accepted (persisted and broadcast), **or** silently deduplicated. |
| `400` | Malformed JSON, missing required fields, oversized body, JSON too deep, or domain-pack-gated `context_type`. |
| `401` | Bad or missing HMAC signature. |
| `403` | Unenrolled authority (when `INGEST_REQUIRE_ENROLLMENT=true`) or tenant assertion rejected. |

### `GET /ingest/health`

**Public**. Liveness for registry config tests. Returns `{ ok: true }`.

---

## Runs

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/runs` | List runs with optional filters and pagination. |
| `GET`  | `/runs/:runId` | Fetch a single run. `404` if not found. |
| `GET`  | `/runs/:runId/lineage` | Lineage DAG: `{ runId, nodes[], edges[] }`. |
| `GET`  | `/runs/:runId/events` | Context events for the run, ordered by `event_ts`. |
| `GET`  | `/runs/:runId/events/stream` | **SSE** — live events for this run. |
| `POST` | `/runs/:runId/complete` | Mark the run terminal. Body: `{ status, result? }`. Returns `204`. |

### `GET /runs` query parameters

| Param | Type | Notes |
|-------|------|-------|
| `status` | enum | `running` \| `completed` \| `failed` \| `cancelled` |
| `scenarioId` | string | Filter by `scenario_id` |
| `limit` | int | 1–200, default 50 |
| `offset` | int | ≥ 0, default 0 |

Response:
```json
{ "data": [ /* Run */ ], "total": 42, "limit": 50, "offset": 0 }
```

### `GET /runs/:runId/lineage` response

```json
{
  "runId": "run-001",
  "nodes": [
    {
      "ctxId": "acdp://registry-a/ctx-001",
      "agentId": "did:web:agent-a.example",
      "contextType": "task",
      "visibility": "public",
      "registryAuthority": "registry-a.example",
      "step": 1
    }
  ],
  "edges": [ { "from": "acdp://registry-a/ctx-001", "to": "acdp://registry-a/ctx-002" } ]
}
```

### SSE: `GET /runs/:runId/events/stream`

Each event is emitted as `event: <event_type>\ndata: <json>\n\n`. A `heartbeat`
frame is emitted every `STREAM_SSE_HEARTBEAT_MS` (default 15 s).

```
event: context_published
data: {"type":"context_published","ts":"...","runId":"r-1",...}

event: heartbeat
data: {"ts":"2026-05-24T12:00:00Z"}
```

---

## Events (cross-run)

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/events` | Cross-run event history with filters. |
| `GET`  | `/events/stream` | **SSE** — global firehose of all events. |

`GET /events` query parameters: `runId`, `eventType`, `agentId`,
`registryAuthority`, `afterTs` (ISO), `beforeTs` (ISO), `limit` (default 500).

---

## Contexts (federation proxy)

### `GET /contexts/*ctxId`

Gated by `@CheckPolicy('context.retrieve')`. Proxies the request to the registry
that owns the context. `ctxId` format: `acdp://<authority>/<id>` (authority
matches `^[a-zA-Z0-9.:-]+$` — no path, no scheme, no IP literal). The authority
is looked up in the caller's tenant enrollments, and the request is forwarded to
`<base_url>/contexts/<ctxId>` through the **SSRF-safe** `SafeFederationClient`
(the same defense model as the SDK — [acdp-rs · Security](https://github.com/agentcontextdistributionprotocol/acdp-rs/blob/main/docs/security.md),
RFC-ACDP-0006 §7 / RFC-ACDP-0008):

- HTTPS-only; DNS-resolved IPs must not be private/loopback/link-local/IMDS.
- Redirects followed manually, max 3, same-authority only (else `502`).
- Response body capped at 1 MiB; 10 s deadline.

Status mapping:

| Condition | Response |
|-----------|----------|
| Upstream `2xx`/`4xx` | Relayed verbatim (status, content-type, body). |
| Upstream `429` | `503` `FEDERATION_UPSTREAM_RATE_LIMITED` (upstream `Retry-After` logged). |
| Unknown / unenrolled authority | `404` |
| Malformed `ctxId` | `400` |
| SSRF / transport / oversized / cross-authority redirect | `502` |

---

## Agents

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/agents` | List known agents (tenant-scoped, ordered by `last_seen`). |
| `GET`  | `/agents/*did` | Agent detail by DID. `404` if not seen. |

---

## Capabilities

Agents self-declare capabilities by signing a canonical assertion. See
[ARCHITECTURE.md](./ARCHITECTURE.md#capabilities-routing--domain-packs).

### `POST /capabilities` — declare a capability

Gated by `@CheckPolicy('capability.declare')` + `@CheckQuota('capability.declare')`.

**Body** (`DeclareCapabilityRequestDto`):
```json
{
  "agent_did": "did:web:cp.example.com:agents:alice",
  "capability_uri": "urn:acdp:cap:publish:data_snapshot:finance",
  "declared_at": "2026-05-25T18:00:00Z",
  "key_id": "did:web:cp.example.com:agents:alice#key-1",
  "algorithm": "ed25519",
  "signature": "<base64>"
}
```

The agent signs `acdp-cap:v1:<agent_did>:<capability_uri>:<declared_at>` with its
pinned key. The server validates the URN form (`urn:acdp:cap:<verb>:<type>:<domain>`,
each segment `[a-z0-9_]+`), a ±300 s clock-skew window, algorithm-match (downgrade
defense), and the signature, then persists idempotently on
`(tenant_id, agent_did, capability_uri)`.

**Response** (`CapabilityResponseDto`):
```json
{
  "agent_did": "did:web:cp.example.com:agents:alice",
  "capability_uri": "urn:acdp:cap:publish:data_snapshot:finance",
  "declared_at": "2026-05-25T18:00:00Z",
  "signed_by": "did:web:cp.example.com:agents:alice#key-1"
}
```
Re-declaring the same pair returns the **original** server-pinned `declared_at`.

### `GET /capabilities/search?capability=<uri>`

Returns agents declaring the given capability:
`{ "data": [ CapabilityResponse… ], "total": N }`.

### `GET /capabilities/by-agent/*did`

Returns one agent's capabilities: `{ "data": [ … ], "total": N }`.

---

## Registries

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/registries` | Known registries (observed via events), tenant-scoped, with `eventCount`. |
| `GET`  | `/registries/enrollments` | Enrolled registries. `webhookSecret` is always omitted. |
| `POST` | `/registries/enroll` | **Admin-only**. Upsert an enrollment. |

### `POST /registries/enroll`

**Body** (`EnrollRegistryDto`):
```json
{
  "authority": "registry-a.example",
  "tenantId": "tenant-a",
  "baseUrl": "https://registry-a.example",
  "registryDid": "did:web:registry-a.example",
  "webhookSecret": "per-registry-secret-min-16-chars",
  "enabled": true
}
```
- `authority` (required) — ACDP authority / hostname.
- `tenantId` (optional) — defaults to the caller's tenant. Explicitly passing
  `"default"` is rejected (`403`).
- `baseUrl` (optional) — used by the federation proxy.
- `webhookSecret` (optional, ≥16 chars) — per-registry HMAC secret; omit to use
  the global `WEBHOOK_SECRET`.
- `enabled` (optional, default `true`) — whether ingest from this authority is accepted.

Response echoes the enrollment **without** `webhookSecret`.

---

## Dashboard

### `GET /dashboard/overview?window=1h|6h|24h|7d|30d`

KPIs over the window (default `24h`), tenant-scoped:

```json
{
  "window": "24h",
  "totalRuns": 12,
  "totalContexts": 87,
  "totalAgents": 5,
  "recentRuns": [ /* last 10 runs */ ],
  "byScenario": [ { "scenario_id": "...", "run_count": 4 } ],
  "byRegistry": [ { "registry_authority": "...", "event_count": 31 } ]
}
```

---

## Webhooks (outbound subscriptions)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/webhooks` | Create. Body: `{ url, events?, secret }`. |
| `GET`  | `/webhooks` | List. |
| `PATCH`| `/webhooks/:id` | Update any of `{ url, events, secret, active }`. |
| `DELETE` | `/webhooks/:id` | Remove. Returns `204`. |

When the control plane ingests an event, every active webhook whose `events`
list is empty (= all events) or contains the event type is dispatched. The body
is HMAC-SHA256 signed with the subscription's `secret` (`X-ACDP-Signature:
sha256=<hex>`, event type in `X-ACDP-Event`). Delivery is outbox-tracked with a
background retry sweep; see [ARCHITECTURE.md](./ARCHITECTURE.md#webhook-outbox--retry).

---

## Domain packs

### `GET /domain-packs` — list active packs

```json
{
  "packs": [
    {
      "id": "finance",
      "version": "0.1.0",
      "label": "Finance (reference)",
      "contextTypes": [
        { "contextType": "earnings_report", "requiredFields": ["fiscal_quarter","ticker","currency"], "defaultVisibility": "restricted" }
      ]
    }
  ]
}
```

Packs are registered at boot from `DOMAIN_PACKS`. Their declared `contextType`s
extend the ingest allowlist; the base RFC-ACDP-0001 types are always accepted.
See [INGEST.md](./INGEST.md#domain-pack-context_type-gate).

---

## Routing

### `GET /routing/stats` — bandit router arm state (admin-only)

```json
{
  "arms": [
    { "taskClass": "finance_summary", "agentDid": "did:web:agent-a.example",
      "alpha": 12, "beta": 3, "mean": 0.8, "observations": 13 }
  ],
  "total": 1
}
```

`alpha`/`beta` are the Beta-posterior parameters (successes+1 / failures+1);
`mean = alpha/(alpha+beta)`. Selection uses Thompson sampling over arms that pass
the capability-match gate, with an exploration fraction
(`BANDIT_EXPLORATION_FRACTION`, default 5%). State is per-instance in V1.

---

## Auth

Full flows in [AUTH.md](./AUTH.md). Endpoints:

### `POST /auth/challenge` — request a signing nonce (Public)

Body: `{ "agent_id": "did:web:…" }`. Returns:
```json
{
  "nonce": "<base64url>",
  "registry_authority": "control-plane.local",
  "expires_at": 1716661234,
  "signing_input": "acdp-registry-auth:v1:<nonce>:<agent_did>:<authority>:<expires_at>"
}
```

### `POST /auth/token` — exchange a signed nonce for a JWT (Public)

Body:
```json
{
  "agent_id": "did:web:…",
  "key_id": "key-1",
  "nonce": "<from challenge>",
  "expires_at": 1716661234,
  "algorithm": "ed25519",
  "signature": "<base64 over signing_input>"
}
```
Returns `{ "token": "<jwt>", "token_type": "Bearer", "expires_at": <unix> }`.
`401` on unknown/expired nonce, agent mismatch, missing pinned key, or bad
signature; `400` on unsupported algorithm. `/auth/challenge` and `/auth/token`
carry a tighter per-IP throttle than the global limit.

### `POST /auth/introspect` — RFC 7662 introspection

Body: `{ "token": "<jwt>" }`. Active tokens (local **or** trusted-issuer) return
canonical claims; anything that fails verification collapses to `{ "active": false }`
(no oracle).

### `POST /auth/token/revoke` — RFC 7009 revocation

Body: `{ "token": "<jwt>", "reason"?: "user_logout" | "admin_revoke" | "key_rotation" | "security_incident" | "unspecified" }`.
Allowed for an **admin** key or the **token's own subject** (self-revoke); else
`403`. Always returns `200 { "revoked": <bool> }` (no oracle).

### `GET /auth/revocations` — cross-issuer revocation feed (admin-only)

Query: `since` (unix-ms cursor, default 0), `limit` (default 200, max 500).
Returns `{ "entries": [ { jti, sub, iss, exp, revoked_at_ms } ], "next_cursor": <ms|null> }`.
Peers poll this; this CP polls *their* feeds via `REVOCATION_FEEDS`.

### `GET /.well-known/jwks.json` (Public)

Publishes the CP's public verification key(s). For `HS256` returns
`{ "keys": [] }`; for `EdDSA` returns the active `OKP`/`Ed25519` JWK. `Cache-Control: public, max-age=300`.

### `POST /admin/pinned-keys/reload` (admin-only)

Reloads `CONTROL_PLANE_PINNED_KEYS` from the environment and atomically swaps the
in-memory directory. Returns `{ "ok": true, "count": <n> }`.

---

## Witness cosigning (RFC-ACDP-0015)

When `WITNESS_COSIGNING_ENABLED=true`, the control plane acts as a transparency-log
**witness**: after the checkpoint witness verifies a registry checkpoint's signature
**and** its RFC-ACDP-0015 §7 consistency obligation against the retained head, it mints
a signed `acdp-log-cosignature` over the observed `{log_id, tree_size, root_hash,
timestamp}` tuple with the witness's own Ed25519 `assertionMethod` key. A consumer
trusting this witness inherits split-view protection. A checkpoint that **fails** the
obligation is never cosigned — it stays on the detect/alert path. These endpoints are
served only when cosigning is enabled (else `404`).

### `GET /log/witness` (Public)

This witness's cosignatures, most-recent first (RFC-ACDP-0015 §6.2). Optional query
params `log_id` (a `did:web:…/log/<instance>` id) and `tree_size` (a non-negative
integer) filter the result; a malformed value returns `400` (`schema_violation`).
`Content-Type: application/acdp+json`.

```json
{
  "witness_id": "did:web:witness.example.org",
  "witness_signatures": [
    {
      "cosignature_version": "acdp-cosig/1",
      "witness_id": "did:web:witness.example.org",
      "witnessed_checkpoint": { "log_id": "…/log/1", "tree_size": 5, "root_hash": "sha256:…", "timestamp": "2026-07-04T12:00:00.000Z" },
      "witnessed_at": "2026-07-04T12:00:05.000Z",
      "signature": { "algorithm": "ed25519", "key_id": "did:web:witness.example.org#witness-key-1", "value": "…" }
    }
  ]
}
```

### `GET /.well-known/acdp-witness.json` (Public)

Witness capabilities document (RFC-ACDP-0015 §9): the witness DID, the
`acdp-log-witness` profile, the logs it has cosigned (`covered_logs`, advisory), and
the cosignature endpoint. `Cache-Control: public, max-age=300`.

```json
{
  "witness_id": "did:web:witness.example.org",
  "profiles": ["acdp-log-witness"],
  "covered_logs": ["did:web:registry.example.com/log/1"],
  "cosignature_endpoint": "/log/witness"
}
```

### `GET /.well-known/did.json` (Public)

The witness DID document. Carries the single active `assertionMethod` Ed25519 key
(as `Ed25519VerificationKey2020` / `publicKeyMultibase`) a consumer resolves
`signature.key_id` to when verifying a cosignature (RFC-ACDP-0015 §8 step 2).
`Content-Type: application/did+json`. `WITNESS_ID`'s host MUST point at this CP for
the `did:web` document to resolve.

> The witness key is **dedicated** — never the federation IdP JWT key at
> `/.well-known/jwks.json` (RFC-ACDP-0015 §5/§15 require an independent witness signing
> role; the JWT key may be HS256 with no publishable public half).

---

## Observability

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/healthz` | Liveness (`{ ok, service }`); pings DB. **Public.** |
| `GET`  | `/readyz` | Readiness (`{ ok, database }`). **Public.** |
| `GET`  | `/metrics` | Prometheus text-format metrics. **Public.** |
| `GET`  | `/docs` | Swagger UI (dev / opt-in). |

Key metrics (all constructed in `InstrumentationService`):

| Metric | Type | Labels | Measures |
|--------|------|--------|----------|
| `http_request_duration_seconds` | histogram | `method`, `path`, `status_code` | Request latency (buckets 0.01–10 s) |
| `http_requests_total` | counter | `method`, `path`, `status_code` | Request count |
| `active_sse_connections` | gauge | — | Live SSE connections |
| `acdp_events_ingested_total` | counter | `event_type` | Ingested events |
| `acdp_webhook_deliveries_total` | counter | `status` | Outbound deliveries by status |
| `acdp_ingest_rejected_total` | counter | `reason` | Ingest rejections (e.g. `pack_gate`) |

Plus Node.js default metrics (`process_cpu`, gc, memory, event-loop lag, etc.)
via `collectDefaultMetrics()`.
</content>
