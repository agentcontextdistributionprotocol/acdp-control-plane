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
  A trusted issuer flagged `read_only` is limited to GET/HEAD/OPTIONS (403
  `ISSUER_READ_ONLY`; `POST /auth/introspect` exempt).

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

`errorCode` (mirrored as `error.code`) is one of the values below
(`src/errors/error-codes.ts`; the set is pinned by `src/errors/error-codes.spec.ts`,
which also checks that every code appears in this table). Codes are
SCREAMING_SNAKE so they never collide with a registry's lowercase
RFC-ACDP-0007 `error.code` vocabulary.

**Generic fallbacks** are assigned by `GlobalExceptionFilter`, keyed on the HTTP
status, when the error's producer set no code; a **specific** code is used
wherever one exists. `INTERNAL_ERROR` is reserved for genuine server faults
(5xx) — it is in RFC-ACDP-0007 §5's retryable set, so no `4xx` ever carries it
(#182).

| Code | HTTP | Kind | Meaning |
|------|------|------|---------|
| `INVALID_PAYLOAD` | 400 | fallback | Request body/query failed validation or parsing (ValidationPipe, ingest checks). |
| `UNAUTHORIZED` | 401 | fallback | Credentials missing or rejected (API key, bearer JWT, challenge/token checks). |
| `FORBIDDEN` | 403 | fallback | Authenticated but not permitted (e.g. revoking a token that is not yours). |
| `NOT_FOUND` | 404 | fallback | No such route or resource. |
| `PAYLOAD_TOO_LARGE` | 413 | fallback | Body over the configured limit (`INGEST_MAX_BODY_BYTES`). |
| `RATE_LIMITED` | 429 | fallback | Coarse per-principal throttle (`THROTTLE_LIMIT`); see `Retry-After`. |
| `REQUEST_REJECTED` | other 4xx | fallback | Any other client error (405, 409, 415, 422, …). |
| `INTERNAL_ERROR` | 5xx | fallback | Genuine server fault; retryable. Never on a 4xx. |
| `RUN_NOT_FOUND` | 404 | specific | No such run in the caller's tenant (also the cross-tenant SSE guard). |
| `REGISTRY_NOT_FOUND` | 404 | specific | Registry authority unknown in the caller's tenant, or no witness/cosigning state for it. |
| `AGENT_NOT_FOUND` | 404 | specific | No such agent DID in the caller's tenant. |
| `CONTEXT_NOT_FOUND` | 404 | specific | Declared for a missing context body; reserved. |
| `ADMIN_REQUIRED` | 403 | specific | Admin-only route; use a key in `AUTH_ADMIN_API_KEYS`. |
| `TENANT_RESERVED` | 403 | specific | The reserved `default` tenant was explicitly asserted. |
| `TENANT_MISMATCH` | 403 | specific | `X-Tenant-Id` disagrees with the JWT claim / key-bound tenant. |
| `TENANT_REQUIRED` | 403 | specific | `AUTH_REQUIRE_TENANT` and no bound tenant. |
| `POLICY_DENIED` | 403 | specific | `PolicyGuard` denied (legacy top-level `code` names the rule; `indeterminate` = could not decide). |
| `QUOTA_EXCEEDED` | 429 | specific | Per-tenant per-action `TENANT_QUOTAS` limit; see `Retry-After`. |
| `REGISTRY_NOT_ENROLLED` | 403 | specific | Ingest from an unenrolled authority under `INGEST_REQUIRE_ENROLLMENT`. |
| `REGISTRY_DISABLED` | 403 | specific | Ingest from an enrolled but disabled registry. |
| `ISSUER_READ_ONLY` | 403 | specific | The bearer token is from a `TRUSTED_ISSUERS` entry flagged `read_only` and the method is not GET/HEAD/OPTIONS (`POST /auth/introspect` is exempt). Use a CP-issued token, or have the operator lift the flag. |
| `INVALID_WEBHOOK_SIGNATURE` | 401 | specific | HMAC `X-ACDP-Signature` failed on `/ingest/acdp` or `/runs/*` notify. |
| `INVALID_SIGNATURE` | 401 | specific | Ed25519/ECDSA-P256 signature over a challenge or capability assertion failed. |
| `VALIDATION_ERROR` | 400 | specific | Malformed witness query parameter (`schema_violation`). |
| `FEDERATION_UPSTREAM_RATE_LIMITED` | 503 | specific | The federated registry answered 429. |
| `SERVICE_DRAINING` | 503 | specific | This instance is shutting down; retry (honour `Retry-After`) — another replica will serve it. Transient. |
| `DEPENDENCY_UNAVAILABLE` | 503 | specific | A required backing dependency (today: Postgres) failed the readiness probe; `error.details.checks` names it. Readiness only. Transient; retry with backoff. CP-local SCREAMING_SNAKE code with no RFC-ACDP-0007 §5 mapping (that closed enum has no 503 member). |
| `FEDERATION_UPSTREAM_ERROR` | 502 | specific | No usable response from the federated registry: SSRF-refused base URL, transport/timeout failure, rejected redirect, or body over 1 MiB. |
| `CONTEXT_ID_MISMATCH` | 502 | specific | The registry served a different `ctx_id` than requested. |
| `CONTEXT_BINDING_UNVERIFIABLE` | 502 | specific | The served body's `ctx_id` could not be checked. |
| `INVALID_LOG_PROOF` | — | verdict | Transparency-log proof/checkpoint failed (audit verdict/alert category). |
| `INVALID_WITNESS_COSIGNATURE` | — | verdict | A witness cosignature failed (diagnostic category). |

`SERVICE_DRAINING` (issue #192) is returned by `GET /readyz` from the moment a
shutdown signal arrives, and by the shutdown drain gate to any
request whose headers arrive after the instance began closing (after the
optional `SHUTDOWN_DRAIN_DELAY_MS`, during which other routes still serve), before
authentication (so it costs no throttle or quota budget), with `Retry-After`
(`SHUTDOWN_RETRY_AFTER_SECONDS`, default 1), `Connection: close`, the usual
JSON envelope, CORS headers and an `X-Request-Id`. A request whose headers
arrived *before* the drain runs to completion even if its body finishes later.
A CORS preflight is still answered `204` by the CORS layer. The two SSE routes
are exempt (see `GET /runs/:runId/events/stream`). It is a CP-local
SCREAMING_SNAKE code: RFC-ACDP-0007 §5's closed enum has no 503 code, so no
RFC code is minted or reused.

`DEPENDENCY_UNAVAILABLE` (issue #210) is returned by `GET /readyz` while the
instance is serving but a required dependency failed its readiness probe —
Postgres refused, timed out (`READINESS_DB_TIMEOUT_MS`), or the pool could not
hand out a connection in time. It is distinct from `SERVICE_DRAINING` (this
process is leaving, not broken) and from `INTERNAL_ERROR` (the CP itself is
fine). The body is the standard envelope; `error.details` (= `metadata`)
carries the legacy `ok: false` / `database: "unhealthy"` keys plus
`checks.database = { status: "down", reason: "error" | "timeout", latencyMs }`
— an enum reason, never the driver's error text, host or port. No
`Retry-After` (an outage has no known duration).

`INVALID_LOG_PROOF` and `INVALID_WITNESS_COSIGNATURE` are deliberately
distinct (RFC-ACDP-0015 §10): the former indicts a transparency-log proof or
checkpoint, the latter a witness's own cosignature — an independent verdict
over an independent signer, never collapsed into one code.

Policy denials return `403 POLICY_DENIED` and keep the legacy top-level
`{ message, code, reason }`; quota exceeded returns `429 QUOTA_EXCEEDED` with
the legacy top-level `{ code: "rate_limited", tenantId, action, limit, … }` and
a `Retry-After` header (see [POLICY.md](./POLICY.md)). In both, the same
fields also appear as `error.details`.

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
| POST | `/runs/started` | Public (HMAC) | Run-start notify (scenario attribution) |
| POST | `/runs/:runId/complete` | Public (HMAC) | Mark run terminal |
| GET  | `/events` | key/JWT | Cross-run event history |
| GET  | `/events/stream` | key/JWT | SSE — global firehose |
| GET  | `/contexts/*ctxId` | key/JWT (policy) | Federation proxy (SSRF-gated, served `ctx_id` bound) |
| GET  | `/agents` | key/JWT | Known agents |
| GET  | `/agents/*did` | key/JWT | Agent detail |
| POST | `/capabilities` | key/JWT (policy+quota) | Declare a signed capability |
| GET  | `/capabilities/search` | key/JWT | Find agents by capability |
| GET  | `/capabilities/by-agent/*did` | key/JWT | One agent's capabilities |
| GET  | `/registries` | key/JWT | Known registries |
| GET  | `/registries/enrollments` | key/JWT | Enrolled registries (secrets hidden) |
| POST | `/registries/enroll` | admin | Enroll/update a registry |
| GET  | `/registries/:authority/log-witness` | key/JWT | Witnessed checkpoints + alert state (RFC-ACDP-0012) |
| GET  | `/registries/log-witness/alerts` | key/JWT | Alerted registries worklist |
| POST | `/registries/:authority/log-witness/ack` | admin | Acknowledge a witness alert |
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
| GET  | `/healthz` `/readyz` `/metrics` | Public | Probes / Prometheus (probes unthrottled; `/healthz` = liveness, never touches the DB; `/readyz` 503 when not ready) |
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
| `400` | Malformed JSON, missing required fields, JSON too deep, or domain-pack-gated `context_type`. (An oversized JSON body is a `413`, below — the body parser enforces the same `INGEST_MAX_BODY_BYTES` limit first.) |
| `401` | `INVALID_WEBHOOK_SIGNATURE` — bad or missing HMAC signature. |
| `403` | `REGISTRY_NOT_ENROLLED` (when `INGEST_REQUIRE_ENROLLMENT=true`) or `REGISTRY_DISABLED`. |
| `413` | `PAYLOAD_TOO_LARGE` — a JSON body over `INGEST_MAX_BODY_BYTES`, rejected by the body parser before the handler runs. |
| `429` | `QUOTA_EXCEEDED` (`TENANT_QUOTAS`) or `RATE_LIMITED` (coarse throttle), with `Retry-After`. |

### `GET /ingest/health`

**Public**. Liveness for registry config tests. Returns `{ ok: true }`.

---

## Runs

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/runs` | List runs with optional filters and pagination. |
| `GET`  | `/runs/:runId` | Fetch a single run. `404 RUN_NOT_FOUND` if not found. |
| `GET`  | `/runs/:runId/lineage` | Lineage DAG: `{ runId, nodes[], edges[] }`. |
| `GET`  | `/runs/:runId/events` | Context events for the run, ordered by `event_ts`. |
| `GET`  | `/runs/:runId/events/stream` | **SSE** — live events for this run. |
| `POST` | `/runs/started` | **Public (HMAC)** run-start notify. Body: `{ run_id, scenario_id, started_at?, inputs? }`. Records scenario attribution before the first ingest event lands. Tenant via `X-Tenant-Id`. Returns `204`. |
| `POST` | `/runs/:runId/complete` | **Public (HMAC)** — authenticated with the same `WEBHOOK_SECRET` HMAC as `/ingest/acdp`, not a bearer token. Mark the run terminal. Body: `{ status, result? }`. Returns `204`. |

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

### `GET /runs/:runId` response

A `Run` row plus a `trust` member — `null` when the run's events have not yet
been through the receipt-audit sweep, otherwise the run's rollup from
`ReceiptAuditRepository.summarizeByRun` (ACDP 0.2.0, RFC-ACDP-0010; the
`keyRevocation*` / `revoked` members are RFC-ACDP-0014 §7, Phase 14).
Every timestamp below (`startedAt`, `boundary`) is a `timestamp with time
zone` column read back through Drizzle's `mode: 'string'`, which returns the
Postgres driver's own textual rendering — a space, `+00`, no
milliseconds — not strict RFC3339; parse with `new Date(...)`, never a
string comparison against a value your own client formatted itself:

```json
{
  "runId": "run-001",
  "scenarioId": "scenario-a",
  "status": "completed",
  "startedAt": "2026-06-12 00:00:00+00",
  "contextsCount": 3,
  "trust": {
    "audited": 3,
    "verified": 2,
    "verifiedHistorical": 0,
    "structural": 0,
    "noReceipt": 0,
    "errors": 1,
    "flagged": [
      { "eventId": "...", "ctxId": "acdp://registry-a/...", "status": "discrepancy", "discrepancies": ["ctx_id_mismatch: ..."] }
    ],
    "keyRevocationPreCompromise": 0,
    "keyRevocationRevokedAtOrAfter": 1,
    "keyRevocationRevokedTimeUnverifiable": 0,
    "revoked": [
      {
        "eventId": "...",
        "ctxId": "acdp://registry-a/...",
        "status": "revoked_at_or_after",
        "boundary": "2026-06-01 00:00:00+00",
        "trustClass": "producer_signed",
        "sources": [ { "ctxId": "acdp://registry-a/...", "publisher": "did:web:agent-1.example" } ]
      }
    ]
  }
}
```

`flagged` carries only `discrepancy`-status rows — registry dishonesty
signals. An `error`-status row's `unverified:`-prefixed notes are
environmental (a fetch/DID failure, a non-canonical stored `ctx_id`, an
unsupported receipt/producer signature algorithm) and never appear here.

`revoked` is separate from `flagged` for the same reason: a §7 fail-closed
verdict is not evidence the *registry* misbehaved — an otherwise honest
registry can serve a context signed by a key its own producer has since
revoked. Each entry's `status` is one of `pre_compromise` (the receipt-
attested `created_at` verified strictly before the compromise boundary),
`revoked_at_or_after` (the verified `created_at` landed at or after it), or
`revoked_time_unverifiable` (no receipt-verified `created_at` exists at all —
fails closed the same as `revoked_at_or_after`, just for a different reason).
`trustClass` is `producer_signed` or `registry_attested` per RFC-ACDP-0014 §6;
`sources` lists every verified revocation fact that fed the classification
(their `ctxId` + `publisher`), not just the one that set the boundary. Only
populated when `KEY_REVOCATION_CHECK_ENABLED=true`; disabled (the default)
every event classifies `none` and `revoked` is always `[]`. See
[ARCHITECTURE.md](./ARCHITECTURE.md) — "Producer key-revocation verification".

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
      "step": 1,
      "retracted": false
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

**Graceful shutdown (`event: shutdown`).** Both SSE routes (this one and
`GET /events/stream`) end every stream with a final `shutdown` event when the
instance is shutting down, then close the response cleanly:

```
event: shutdown
id: 7
retry: 1000
data: {"reason":"server_shutdown"}
```

A stream opened while the instance is already draining gets `200` (for requests that reach
the handler), this event and then the end of the stream at once. The drain gate
that answers every other new request with `503 SERVICE_DRAINING` deliberately
lets `GET` on both SSE routes through, so the gate itself never 503s an SSE
request. The handler is still behind the guards, though: a JWT client under
`AUTH_PERSISTENCE=postgres` can still see a non-2xx in the brief window after the
database pool has ended, because the auth guard's revocation lookup runs first. A
`503` is avoided because a non-2xx
response makes `EventSource` give up for good. Clients should treat `shutdown`
as "reconnect after `retry` ms". A browser `EventSource` does this on its own
when the stream ends, and the `retry:` line sets the delay, so the reconnect
lands on a live replica. A non-browser consumer that treats an unknown event
type as fatal must ignore or handle `shutdown`. The `retry` value is
`STREAM_SSE_SHUTDOWN_RETRY_MS` (default 1000 ms).

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
that owns the context. `ctxId` format: `acdp://<authority>/<uuid>`, parsed under
the SDK's own `CtxId::parse` grammar — a **lowercase DNS authority** (so no
port, no IP literal, no path, no scheme) and a **lowercase v4 UUID**. Anything
else is a local `400`; the reference registry parses the same grammar in its own
retrieve handler, so such a request could only ever have earned an upstream
`400` anyway. The authority is looked up in the caller's tenant enrollments, and
the request is forwarded to `<base_url>/contexts/<ctxId>` through the
**SSRF-safe** `SafeFederationClient` (the same defense model as the SDK —
[acdp-rs · Security](https://github.com/agentcontextdistributionprotocol/acdp-rs/blob/main/docs/security.md),
RFC-ACDP-0006 §7 / RFC-ACDP-0008):

- HTTPS-only; DNS-resolved IPs must not be private/loopback/link-local/IMDS.
- Redirects followed manually, max 3, same-authority only (else `502 FEDERATION_UPSTREAM_ERROR`).
- Response body capped at 1 MiB; 10 s deadline.

**`ctx_id` binding (RFC-ACDP-0006 §4.1 step 7).** On a `2xx` the proxy verifies
that the served `body.ctx_id` is the `ctx_id` that was requested, via the SDK's
`AcdpVerifier.verifyCtxIdBinding`, **before** relaying anything. `ctx_id` is
registry-assigned and excluded from both `content_hash` and the producer
signature (RFC-ACDP-0001 §5.7), so without this comparison a compromised or
confused registry could serve a different, validly signed context under this URL
and every other check would pass. The check reads `body.ctx_id` only — it is not
a schema gate, and a `FullContext` carrying members the control plane does not
know about still relays. It fails **closed**: a mismatch is never relayed, not
even with a warning logged.

Status mapping:

| Condition | Response |
|-----------|----------|
| Upstream `2xx`, served `ctx_id` matches | Relayed verbatim (status, content-type, body). |
| Upstream non-`2xx` (e.g. the registry's own `401`/`403`/`404`) | Relayed verbatim, no binding check. |
| Upstream `2xx`, served `ctx_id` **differs** | `502` `CONTEXT_ID_MISMATCH` — the upstream body is discarded. |
| Upstream `2xx` that is not JSON, has no `body` member, or names a `ctx_id` the protocol grammar refuses | `502` `CONTEXT_BINDING_UNVERIFIABLE` — the binding could not be established, so nothing is relayed. |
| Upstream `429` | `503` `FEDERATION_UPSTREAM_RATE_LIMITED` (upstream `Retry-After` logged). |
| Unknown / unenrolled authority | `404 REGISTRY_NOT_FOUND` |
| Malformed / non-canonical `ctxId` | `400` |
| SSRF / transport / oversized / cross-authority redirect | `502` `FEDERATION_UPSTREAM_ERROR` (cause logged as `fetchErrorCode`, not returned). |

`CONTEXT_ID_MISMATCH` and `CONTEXT_BINDING_UNVERIFIABLE` are deliberately
distinct: the first means the proxy checked and the registry served the wrong
context (it may be hostile), the second that the proxy could not check at all
(the registry is most likely misconfigured).

---

## Agents

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/agents` | List known agents (tenant-scoped, ordered by `last_seen`). |
| `GET`  | `/agents/*did` | Agent detail by DID. `404 AGENT_NOT_FOUND` if not seen. |

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
| `GET`  | `/registries/:authority/log-witness` | Witness state + latest witnessed checkpoints for a registry. |
| `GET`  | `/registries/log-witness/alerts` | Unacknowledged witness alerts for this tenant (worklist). |
| `POST` | `/registries/:authority/log-witness/ack` | **Admin-only**. Acknowledge an active witness alert. |

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
  `"default"` is rejected (`403 TENANT_RESERVED`).
- `baseUrl` (optional) — used by the federation proxy.
- `webhookSecret` (optional, ≥16 chars) — per-registry HMAC secret; omit to use
  the global `WEBHOOK_SECRET`.
- `enabled` (optional, default `true`) — whether ingest from this authority is accepted.

Response echoes the enrollment **without** `webhookSecret`.

### `GET /registries/:authority/log-witness`

Transparency-log witness state for a registry: the cursor (retained head, last
success, alert state) and the latest witnessed checkpoints (signed tree heads,
retained as evidence). Each checkpoint carries the RFC-ACDP-0015 §8 quorum trust
signal when quorum consumption is enabled:

- `witnessedCount` — DISTINCT trusted witnesses whose aggregated cosignature over
  this exact `(logId, treeSize, rootHash)` tuple the CP independently verified
  (`null` when `WITNESS_QUORUM_ENABLED=false`).
- `meetsQuorum` — whether `witnessedCount ≥ WITNESS_QUORUM_MIN_WITNESSES`.
- `freshWitnessedCount` — the §8.1 freshness-split SUBSET of `witnessedCount` whose
  cosignature is also within `WITNESS_QUORUM_MAX_AGE_SECONDS` (`null` under the same
  condition as `witnessedCount`). A stale cosignature still counts toward
  `witnessedCount`/`meetsQuorum` above — this is never a failure, just excluded here.
- `meetsFreshQuorum` — whether `freshWitnessedCount ≥ WITNESS_QUORUM_MIN_WITNESSES`.
- `historicalWitnessedCount` — RFC-ACDP-0015 §9 (RFC-ACDP-0010 §9 key lifecycle
  applied to a witness's own key): DISTINCT trusted witnesses whose cosignature
  verified under a RETIRED key (rotated out of `assertionMethod`, retained in
  `verificationMethod`) — same as the registry's own `verified_historical`
  receipt-key treatment, but this is a SEPARATE sub-count, never folded into
  `witnessedCount`/`meetsQuorum` above: historical evidence is real but must
  never by itself satisfy quorum (`null` under the same condition as
  `witnessedCount`). A `did:key` witness never contributes here — that DID has
  no document, so no key ever "retires" out of it.

### `GET /registries/log-witness/alerts?includeAcknowledged=true`

A durable, pollable worklist of witness dishonesty detections (root rewrite, split
view, tree-size regression, log reset) for this tenant. Persisted on detection, so
it survives a failed SSE/webhook fan-out. Returns **unacknowledged** alerts by
default; pass `includeAcknowledged=true` for the full set. Each entry carries
`authority`, `reason`, `detail`, `at`, `acknowledgedAt`, `acknowledgedBy`.

### `POST /registries/:authority/log-witness/ack`

**Admin-only.** Acknowledge an active alert — records who saw it and when, without
touching the retained head (the alert still auto-clears only when the underlying
condition resolves). Acknowledged alerts drop off the default worklist; a **new**
alert reason resurfaces it. `404` if the authority has no active alert.

---

## Dashboard

### `GET /dashboard/overview?window=1h|6h|24h|7d|30d`

KPIs over the window (default `24h`), tenant-scoped:

```json
{
  "window": "24h",
  "totalRuns": 12,
  "totalContexts": 87,
  "totalRetracted": 2,
  "totalContextsLive": 85,
  "totalAgents": 5,
  "recentRuns": [ /* last 10 runs */ ],
  "byScenario": [ { "scenario_id": "...", "run_count": 4 } ],
  "byRegistry": [ { "registry_authority": "...", "event_count": 31 } ],
  "receiptCoverage": [ { "registry_authority": "...", "publish_count": 40, "receipt_count": 38 } ],
  "didMethods": [ { "method": "did:web", "publish_count": 61 } ],
  "logWitness": {
    "witnessedLogs": 1,
    "activeAlerts": 0,
    "unacknowledgedAlerts": 0,
    "headsMeetingQuorum": 3
  },
  "keyRevocation": {
    "preCompromise": 0,
    "revokedAtOrAfter": 1,
    "revokedTimeUnverifiable": 0
  },
  "features": {
    "receiptAudit": true,
    "keyRevocationCheck": true,
    "logWitness": true,
    "logInclusionAudit": false,
    "witnessCosigning": false,
    "witnessQuorum": false
  }
}
```

`totalRetracted` / `totalContextsLive` are the ACDP 0.3.0 lifecycle tiles
(currently-retracted contexts from the window, and published − retracted).
`receiptCoverage` / `didMethods` are the ACDP 0.2.0 trust tiles
(RFC-ACDP-0010), always present — they read ingest-time columns and don't
depend on any sweep being enabled. `logWitness` is the RFC-ACDP-0012/0015
witness posture (not window-scoped — it reflects current state). `keyRevocation`
is the RFC-ACDP-0014 §7 tile (Phase 14) — window-scoped on
`receipt_audits.checked_at` like `receiptCoverage`/`didMethods` above, not a
current-posture tile like `logWitness`; see `GET /runs/:runId`'s
`trust.revoked` above for the per-event detail these counts summarize. A
retroactive amendment (Phase 15) deliberately never touches `checked_at`
(see `docs/ARCHITECTURE.md`'s "Retroactive re-audit" section), so a row
this tile's window has already scrolled past stays invisible here even
after being amended — `trust.revoked` on the row's own `GET /runs/:runId`
is unaffected by the window and always current.

**`logWitness` and `keyRevocation` are `null`, not a zeroed object, when
their respective sweep is disabled** (`LOG_WITNESS_ENABLED=false` /
`KEY_REVOCATION_CHECK_ENABLED=false` — issue #176). Before this, both tiles
were always built with `?? 0` defaults, so a tenant that never enabled the
check was indistinguishable from one running it and genuinely finding
nothing — a consumer had no way to tell "off" from "on and clean". The
gated queries are also skipped entirely (not run-then-discarded) when their
flag is off, so this fix costs nothing extra in the common (off-by-default)
deployment posture.

**`features`** exposes every audit/witness enable flag as a boolean, so a
consumer can resolve the same ambiguity for a flag with no top-level tile of
its own — e.g. whether `logWitness.headsMeetingQuorum` reflects live quorum
consumption (`features.witnessQuorum`) rather than guessing from a `0`.
`features.logWitness` (the flag) and the top-level `logWitness` (the tile)
are deliberately both present at their own distinct JSON paths — the field
names mirror `AppConfigService`'s own flag names 1:1
(`logWitnessEnabled` → `logWitness`, `keyRevocationCheckEnabled` →
`keyRevocationCheck`).

---

## Webhooks (outbound subscriptions)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/webhooks` | Create. Body: `{ url, events?, secret }`. |
| `GET`  | `/webhooks` | List. |

The `secret` is **write-only**: it is accepted on create/update and used to sign deliveries, but never appears in any response (create, list, update) — #230. Rotate it with `PATCH`.

| Method | Path | Description |
|--------|------|-------------|
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
signature; `400` on unsupported algorithm or an over-long field (`agent_id`, `key_id`,
`nonce`, `signature` ≤ 2048 chars, `algorithm` ≤ 64; `INVALID_PAYLOAD`, rejected before the
nonce is consumed). `/auth/challenge` and `/auth/token`
carry a tighter per-IP throttle than the global limit (an IPv6 caller is
counted per `/64` network, not per address — `THROTTLE_IPV6_SUBNET_PREFIX`).

### `POST /auth/introspect` — RFC 7662 introspection

Body: `{ "token": "<jwt>" }` (`token` ≤ 8192 chars, else `400 INVALID_PAYLOAD`). Active tokens (local **or** trusted-issuer) return
canonical claims; anything that fails verification collapses to `{ "active": false }`
(no oracle).

### `POST /auth/token/revoke` — RFC 7009 revocation

Body (`token` ≤ 8192 chars, else `400 INVALID_PAYLOAD`): `{ "token": "<jwt>", "reason"?: "user_logout" | "admin_revoke" | "key_rotation" | "security_incident" | "unspecified" }`.
Allowed for an **admin** key or the **token's own subject** (self-revoke); else
`403 FORBIDDEN`. Always returns `200 { "revoked": <bool> }` (no oracle).

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

The §5 mint (and the §8 verify / §8 quorum) run through the native `acdp` binding
(`AcdpVerifier.buildWitnessCosignature` / `verifyWitnessCosignature` /
`evaluateWitnessQuorum`, 0.7.0+); a binding that predates the cosignature surface
(≤ 0.6.0) transparently falls back to the byte-identical host-TS construction.
**The dependency's pinned floor is `^0.14.4` (which also makes every Ed25519
verification strict per RFC-ACDP-0001 §5.10 — `verify_strict`, pinned by the `sig-004`
conformance spec), which is above every floor named in
this section**, so on a correctly installed deployment the native path is always
the one taken — the feature detection guards a mis-resolved native
`optionalDependency`, not a supported configuration. The
active mode is reported in the checkpoint-witness boot log (`mint=…`), and the two
paths are pinned byte-identical by the wit-001 golden parity test. Likewise the
RFC-ACDP-0012 log inclusion/consistency verification uses the native binding
(0.6.0+) with a host-TS fold as the fallback.

**Quorum consumption (§8), the mirror of cosigning.** With `WITNESS_QUORUM_ENABLED=true`,
the same checkpoint-witness fetch of `GET /log/checkpoint` *also* reads the cosignatures
the registry **aggregates** and serves as the top-level `witness_signatures` sibling
(§6.1). Each is verified against its witness's **own** key via `evaluateWitnessQuorum`,
and DISTINCT `WITNESS_QUORUM_TRUSTED` witnesses over the checkpoint's exact tuple are
counted — external attestations only, never the CP's own mint. **§9 witness key
resolution** (B2/B3) branches by DID method: a `did:key` witness is self-describing (the
multibase-encoded key IS the identity, RFC-ACDP-0001 §5.11.1), so it resolves LOCALLY
with no DID document fetch at all; a `did:web` witness's own key resolves through the
SAME RFC-ACDP-0010 §9 lifecycle tolerance the registry's receipt key already gets — a key
rotated out of `assertionMethod` but retained in `verificationMethod` still verifies, as
**historical** (`historicalWitnessedCount`, a separate sub-count, never counted toward
`witnessedCount`/`meetsQuorum`). The `witnessedCount` / `meetsQuorum` land on the
witnessed head (see `GET /registries/:authority/log-witness`). A did:web `WITNESS_ID`'s
host is asserted to match `PUBLIC_HOST` at boot (§9) so the witness's own DID document is
actually resolvable. §8.1 layers a **freshness split** (`freshWitnessedCount` /
`meetsFreshQuorum`, `WITNESS_QUORUM_MAX_AGE_SECONDS`) on top: a stale-but-otherwise-valid
cosignature still counts toward the base `witnessedCount` — never a failure — but not the
fresh count. Both the native (`AcdpVerifier.evaluateWitnessQuorum`) and host-TS fallback
quorum paths compute the freshness split and the historical sub-count identically
(parity-tested).

**B1 re-mint (§4/§8.1/§15).** A witness MUST cosign on **every** observation, including
at an unchanged `tree_size` — a silent stop is indistinguishable from merely being
offline. So `log_cosignatures` carries one row per *observation*, not per head; only a
genuine same-millisecond re-mint is a true duplicate.

### `GET /log/witness` (Public)

This witness's cosignatures, most-recent first (RFC-ACDP-0015 §6.2). Optional query
params `log_id` (a `did:web:…/log/<instance>` id) and `tree_size` (a non-negative
integer) filter the result; a malformed value returns `400` (`schema_violation`). The
default view collapses B1's per-observation series to the **latest cosignature per
distinct head** — pass `all=true` for the full per-observation series (the §8.1
anti-backdating use: an older surviving cosignature for a head is *stronger* evidence it
existed early). `Content-Type: application/acdp+json`.

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
| `GET`  | `/healthz` | Liveness (`{ ok, service, version }`). **Public**, not throttled, `Cache-Control: no-store`. **Never touches the database** (issue #210): it never awaits any I/O, so it is **200** whenever the process can answer, whatever the state of Postgres — the only non-200 is the drain gate's `503 SERVICE_DRAINING` once a shutdown has entered `closing` (issue #192). `ok` mirrors the **last readiness verdict** (`true` before the first probe), so `200` + `ok: false` means "alive but degraded". When that verdict is missing or older than `max(READINESS_CACHE_MS, 5000 ms)` the request starts a background refresh (single-flight, bounded; never while draining) and still answers from the old verdict at once. `HEAD` gets the same status. |
| `GET`  | `/readyz` | Readiness. **Public**, not throttled (issue #210), `Cache-Control: no-store` on every arm. Drain first: once a shutdown signal has arrived it answers `503 SERVICE_DRAINING` (with `Retry-After`) without consulting readiness or the database, so a load balancer stops routing here; with `SHUTDOWN_DRAIN_DELAY_MS` set that happens while every other route still serves (issue #192). Otherwise **200** `{ ok: true, database: "ok", checks }` when Postgres answers `SELECT 1` within `READINESS_DB_TIMEOUT_MS` (default 1000 ms), else **503** `DEPENDENCY_UNAVAILABLE` (standard envelope; `error.details` = `{ ok: false, database: "unhealthy", checks }`). `checks.database` = `{ status: "up" \| "down", reason?: "error" \| "timeout", latencyMs }`. Report-only members (issue #210 Phase 3) appear only where the dependency is in use and **never** affect the status: `checks.streamHub` (`STREAM_HUB_STRATEGY=redis`) and `checks.quotaStore` (`TENANT_QUOTAS` with `REDIS_URL`), each `{ status: "up" \| "down", required: false }`, read from the Redis client's connection state on every request (no round-trip). The verdict is cached for `READINESS_CACHE_MS` (default 1000 ms) and the probe is single-flight, so any probe rate costs at most one DB query per window and at most one pool connection. `HEAD` gets the same status. |
| `GET`  | `/metrics` | Prometheus text-format metrics. **Public.** |
| `GET`  | `/docs` | Swagger UI (dev / opt-in). |

**Deploying the probes (issue #210).** Kubernetes: `livenessProbe` → `/healthz`,
`startupProbe` → `/healthz`, `readinessProbe` → `/readyz` with `timeoutSeconds ≥ 2`
(the default `READINESS_DB_TIMEOUT_MS` is 1000 ms). `/healthz` never touches the
database, so a database outage pulls replicas out of rotation via `/readyz` but never
restarts them. Docker has no readiness concept: the image's `HEALTHCHECK` stays on
`/healthz`. See [ARCHITECTURE.md](./ARCHITECTURE.md#deploying-behind-a-load-balancer)
for the drain-delay arithmetic.

Key metrics (all constructed in `InstrumentationService`):

| Metric | Type | Labels | Measures |
|--------|------|--------|----------|
| `http_request_duration_seconds` | histogram | `method`, `path`, `status_code` | Request latency (buckets 0.01–10 s) |
| `http_requests_total` | counter | `method`, `path`, `status_code` | Request count |
| `active_sse_connections` | gauge | — | Live SSE connections (both stream routes) |
| `acdp_sse_streams_terminated_total` | counter | `reason` | SSE streams ended by the server (`shutdown` = graceful drain, issue #192). Best effort: a dying process is rarely scraped. |
| `acdp_shutdown_drain_rejections_total` | counter | — | New requests answered `503 SERVICE_DRAINING` by the drain gate (issue #192). Best effort; the `shutdown drain complete` log line is the primary signal. |
| `acdp_shutdown_forced_connections_total` | counter | — | Sockets still open when a graceful close overran `SHUTDOWN_TIMEOUT_MS` and was forced (issue #192). Best effort. |
| `acdp_readiness_checks_total` | counter | `dependency`, `result` | Readiness probes actually executed (not cache hits) by result `ok` \| `error` \| `timeout` (issue #210). `dependency` is `database`. |
| `acdp_dependency_up` | gauge | `dependency` | 1 if the dependency is up, else 0 (issue #210). `database`: its last real readiness probe; alert on `acdp_dependency_up{dependency="database"} == 0` for 1m. Report-only, read at scrape time, present only where in use: `redis_stream_hub`, `redis_quota_store` (never gate readiness). |
| `acdp_db_pool_errors_total` | counter | — | pg pool `'error'` events: an *idle* pooled client lost its connection (a Postgres restart or failover). Recoverable — pg-pool reconnects on demand — and it changes no probe answer (issue #210). |
| `acdp_db_pool_connections` | gauge | `state` | pg pool clients at scrape time: `total`, `idle`, `waiting` (checkouts queued for a connection; `> 0` = saturation) (issue #210). |
| `acdp_events_ingested_total` | counter | `event_type` | Ingested events |
| `acdp_webhook_deliveries_total` | counter | `status` | Outbound deliveries by status |
| `acdp_ingest_rejected_total` | counter | `reason` | Ingest rejections (e.g. `pack_gate`) |

Plus Node.js default metrics (`process_cpu`, gc, memory, event-loop lag, etc.)
via `collectDefaultMetrics()`.
