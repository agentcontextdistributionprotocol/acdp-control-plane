# Troubleshooting

## Ingest

### `401 Unauthorized` from `POST /ingest/acdp`

The HMAC signature didn't verify. Causes:
- The `x-acdp-signature` header is missing.
- The signature is computed over a different body than what's on the wire (most
  often a re-serialized JSON with different key order or whitespace).
- The secret doesn't match. Note a registry **enrollment** with a per-registry
  `webhookSecret` overrides the global `WEBHOOK_SECRET` for that authority.

Checklist:
1. Sign the **exact** byte string you POST (sign once, send that buffer).
2. Confirm the secret is byte-identical on both sides (no trailing newlines).
3. Temporarily clear `WEBHOOK_SECRET` (dev only) to confirm the path works.

### `400 Bad Request` from `POST /ingest/acdp`

One of: body isn't valid JSON; a required field is missing (`type`,
`registry_authority`, and `agent_id` for `context_published`); the body exceeds
`INGEST_MAX_BODY_BYTES` (1 MiB); JSON nesting exceeds `INGEST_MAX_JSON_DEPTH`
(64); or a custom `context_type` is rejected by an active domain pack. See
[INGEST.md](./INGEST.md#event-shape).

### `403 Forbidden` from `POST /ingest/acdp`

Either the authority isn't enrolled while `INGEST_REQUIRE_ENROLLMENT=true`, or an
unenrolled authority asserted a non-`default` tenant while `INGEST_STRICT_TENANT=true`.
Enroll the registry (`POST /registries/enroll`) or relax the flag. See
[INGEST.md](./INGEST.md#registry-trust--enrollment).

### A custom `context_type` silently never appears

A pack-gated `context_type` returns `400` to the registry's webhook worker, which
treats `4xx` as permanent and gives up — the publish persists at the registry but
never reaches the CP. The CP's side is observable: a `warn` log and
`acdp_ingest_rejected_total{reason="pack_gate"}`. Register a pack that declares
the type, or unset `DOMAIN_PACKS`. See [INGEST.md](./INGEST.md#domain-pack-context_type-gate).

### Run shows `scenario_id: "unknown"`

The first event for a run sets `scenario_id`. If neither top-level `scenario_id`
nor `metadata.scenario_id` was present, it's `"unknown"`. Re-emitting won't
backfill — the run row is set on first sight only.

---

## Auth & tokens

### `401` on a route that worked with an API key, now using a JWT

The JWT failed verification. Common causes:
- `TOKEN_ISSUANCE_ENABLED` is false (the JWT path / validator isn't wired).
- `aud` mismatch — local tokens must carry `aud == JWT_AUDIENCE`; trusted-issuer
  tokens must carry the `aud` bound in their `TRUSTED_ISSUERS` entry.
- The token's `jti` is revoked (locally or propagated from a peer feed).
- `kid` doesn't match a key in JWKS (rotate carefully; publish before signing).

Use `POST /auth/introspect` with the token — `{ "active": false }` confirms the
CP rejects it (it won't tell you *why*, by design).

### `POST /auth/token` returns `401`

The challenge/signature step failed: unknown or expired nonce (re-run
`/auth/challenge`), `agent_id`/`expires_at` not matching the challenge, no pinned
key for the agent (and no resolvable did:web), or the signature didn't verify.
`400` means an unsupported `algorithm`. The **issuance ledger** records the exact
`reject_*` reason (`issuance_ledger.decision`) for each attempt.

### Federated peer tokens rejected

- The peer's `iss` must be in `TRUSTED_ISSUERS`, with the correct algorithm and a
  required `audience`.
- For EdDSA peers, the `jwks-url` must be HTTPS and reachable; the client caches
  failures for 30 s, so fix the URL and wait out the cache.

### Multi-instance: tokens or revocations behave inconsistently

`AUTH_PERSISTENCE=memory` keeps challenge/revocation state per process. Across
replicas a nonce minted on one isn't consumable on another, and a revocation on
one isn't seen by another. Set `AUTH_PERSISTENCE=postgres`.

---

## Tenancy

### `403` with a valid credential

Likely a tenancy rejection (see [TENANCY.md](./TENANCY.md)):
- `X-Tenant-Id` disagrees with the JWT `tenant` claim or the API key's bound tenant.
- An explicit assertion of the reserved `default` tenant (header or claim).
- Strict mode (`AUTH_REQUIRE_TENANT=true`) and the request resolves only to `default`
  (JWT without `tenant`, or a bare/absent API key).

### Boot fails: "Tenant bindings are configured … but `AUTH_REQUIRE_TENANT=false`"

You set `TENANT_AGENTS` or a tenant-bound `TENANT_API_KEYS` entry without strict
mode. Set `AUTH_REQUIRE_TENANT=true` or remove the bindings.

### Reads return another tenant's data (or nothing)

A handler likely forgot to thread `tenantOf(req)` — the repository defaulted to
`default`. Confirm the controller takes `@Req() req: TenantedRequest` and passes
`tenantOf(req)` into the service/repository.

---

## Policy & quota

### `403 { "code": "…" }` on a gated route

`PolicyGuard` denied it. The `code` tells you which rule: `visibility`,
`audience`, `scope`, `tenant_mismatch`, `unauthenticated`, or `indeterminate`
(decider couldn't decide — e.g. OPA unreachable with `OPA_FAIL_OPEN=false`).

### Every request to an OPA-gated route is denied

The OPA sidecar is unreachable or slow (`OPA_URL`, `OPA_TIMEOUT_MS`) and the
decider returns `indeterminate` → deny. Fix connectivity, or set
`OPA_FAIL_OPEN=true` if availability matters more than strict enforcement.
`indeterminate` is never cached, so it re-evaluates every request.

### `429 { "code": "rate_limited" }`

A `TENANT_QUOTAS` limit for `(tenant, action)` was exceeded. The body and
`Retry-After` header give the window and wait. Distinguish from the coarse
throttle (`THROTTLE_LIMIT`), which is per-principal and not action-scoped.

---

## SSE

### Subscribers don't receive events

1. Confirm `Accept: text/event-stream` (browsers' `EventSource` does this).
2. Confirm no intermediary buffers (nginx: `proxy_buffering off;`,
   `proxy_read_timeout` > heartbeat).
3. `curl -N http://localhost:3001/events/stream` to confirm the server emits.

### Stream stalls after idle

Raise `STREAM_SSE_HEARTBEAT_MS` if your proxy is aggressive about idle connections
(default 15 s).

### `memory` strategy: subscribers on different replicas miss events

Expected. Use `STREAM_HUB_STRATEGY=redis` + `REDIS_URL`. The CP warns at boot when
it detects production + memory strategy.

---

## Federation proxy

### `503 FEDERATION_UPSTREAM_RATE_LIMITED` from `GET /contexts/*`

The owning registry returned `429`. The CP maps it to `503` and logs the upstream
`Retry-After`. Back off and retry.

### `502 Bad Gateway` from `GET /contexts/*`

The `SafeFederationClient` blocked the fetch: SSRF policy (non-HTTPS, IP literal,
private/loopback/IMDS-resolved host), a cross-authority redirect, an oversized
body (>1 MiB), or a transport/timeout error. Check the logged error code.

### `404` from `GET /contexts/*`

The authority isn't enrolled **in the caller's tenant**, or its enrollment has no
`baseUrl`. Enroll it with a `baseUrl`.

---

## Database

### `relation "..." does not exist`

Migrations didn't run at boot. Causes: `dist/` built without copying `drizzle/`;
`DATABASE_URL` points elsewhere. Fix: `npm run migrate` (dev) / `npm run
migrate:prod`, then verify:
```sql
SELECT name FROM _migrations ORDER BY name;
```

### `pool error: too many clients`

`DB_POOL_MAX` (default 20) × replicas may exceed Postgres `max_connections`. Raise
`max_connections` or lower `DB_POOL_MAX` (must stay ≥ 2; the config service
refuses `< 2`).

### `GET /readyz` reports `database: "unhealthy"` though Postgres is up

The pool hit a fatal error (`hasFatalError=true`), which sticks for the process
lifetime. Restart the pod; look for prior `database pool error: …` logs.

---

## Webhooks (outbound)

### Deliveries stuck on `status='pending'` or `failed`

Delivery is outbox-tracked with an **automatic** retry sweep on an interval
(`WEBHOOK_RETRY_INTERVAL_MS`, default 5 min; `≤0` disables). On a subscriber
`429` the sweep honors `Retry-After` and defers via `next_attempt_at`. If rows
aren't progressing, confirm the sweep is enabled and the subscriber URL passes the
SSRF policy. Inspect:
```sql
SELECT id, webhook_id, event, status, attempts, response_status, next_attempt_at, error_message
FROM webhook_deliveries ORDER BY created_at DESC LIMIT 20;
```
You can also force a sweep for a tenant via `WebhookService.retryPending(tenantId)`.

### Subscriber gets the body but the signature doesn't verify

The CP signs the **stringified payload as sent**. Compute the expected HMAC over
the raw HTTP request body before any framework re-serialization.

---

## Local dev

### `npm run start:dev` exits with `AUTH_API_KEYS must be set …`

`NODE_ENV=production` leaked from the shell or `.env`. Fail-fast runs whenever
`NODE_ENV !== 'development'`. Set `NODE_ENV=development` or supply the required
vars. See [CONFIGURATION.md](./CONFIGURATION.md#startup-validation).

### Integration tests fail with `ECONNREFUSED localhost:5433`

The test Postgres isn't running. `globalSetup` starts it via
`docker compose -f docker-compose.test.yml up -d postgres-test`; if Docker isn't
running, start it manually and keep it up:
```bash
docker compose -f docker-compose.test.yml up -d postgres-test
KEEP_TEST_DB=1 npm run test:integration
```
</content>
