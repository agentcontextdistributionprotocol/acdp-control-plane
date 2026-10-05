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

`errorCode: REGISTRY_NOT_ENROLLED` — the authority isn't enrolled while
`INGEST_REQUIRE_ENROLLMENT=true`. `errorCode: REGISTRY_DISABLED` — it is
enrolled but disabled. (With `INGEST_STRICT_TENANT=true` an unenrolled
authority's non-`default` tenant header is ignored, not rejected.)
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

Read the body's `errorCode` — it names the cause. Likely a tenancy rejection
(see [TENANCY.md](./TENANCY.md)):
- `TENANT_MISMATCH` — `X-Tenant-Id` disagrees with the JWT `tenant` claim or the
  API key's bound tenant.
- `TENANT_RESERVED` — an explicit assertion of the reserved `default` tenant
  (header or claim).
- `TENANT_REQUIRED` — strict mode (`AUTH_REQUIRE_TENANT=true`) and the request
  resolves only to `default` (JWT without `tenant`, or a bare/absent API key).
- `ADMIN_REQUIRED` — the route is admin-only; use a key listed in
  `AUTH_ADMIN_API_KEYS`.

### Boot fails: "Tenant bindings are configured … but `AUTH_REQUIRE_TENANT=false`"

You set `TENANT_AGENTS` or a tenant-bound `TENANT_API_KEYS` entry without strict
mode. Set `AUTH_REQUIRE_TENANT=true` or remove the bindings.

### Reads return another tenant's data (or nothing)

A handler likely forgot to thread `tenantOf(req)` — the repository defaulted to
`default`. Confirm the controller takes `@Req() req: TenantedRequest` and passes
`tenantOf(req)` into the service/repository.

---

## Policy & quota

### `403 { "errorCode": "POLICY_DENIED", "code": "…" }` on a gated route

`PolicyGuard` denied it. The `code` tells you which rule: `visibility`,
`audience`, `scope`, `tenant_mismatch`, `unauthenticated`, or `indeterminate`
(decider couldn't decide — e.g. OPA unreachable with `OPA_FAIL_OPEN=false`).

### Every request to an OPA-gated route is denied

The OPA sidecar is unreachable or slow (`OPA_URL`, `OPA_TIMEOUT_MS`) and the
decider returns `indeterminate` → deny. Fix connectivity, or set
`OPA_FAIL_OPEN=true` if availability matters more than strict enforcement.
`indeterminate` is never cached, so it re-evaluates every request.

### `429 { "errorCode": "QUOTA_EXCEEDED", "code": "rate_limited" }`

A `TENANT_QUOTAS` limit for `(tenant, action)` was exceeded. The body and
`Retry-After` header give the window and wait. Distinguish from the coarse
throttle (`THROTTLE_LIMIT`), which is per-principal and not action-scoped — it
answers `429` with `errorCode: RATE_LIMITED` and no top-level `code`.

### Every unauthenticated caller hits `429 RATE_LIMITED` together (behind a proxy)

All `@Public()` traffic (`/auth/challenge`, `/auth/token`, `/ingest/*`,
probes) is throttled per client IP. Behind a load balancer or ingress with
`TRUST_PROXY` unset, `req.ip` is the proxy's address, so every caller lands in
**one** bucket and they exhaust it together — and `signer_ip` in the issuance
ledger shows the proxy for every token. Set `TRUST_PROXY` to your proxy hop
count (e.g. `1`) or the proxies' CIDRs (docs/CONFIGURATION.md, "Behind a
reverse proxy"). Never `true` — it is rejected at startup because it lets any
client choose its own bucket.

### Boot fails: "TRUST_PROXY … is rejected" / "TRUST_PROXY entry … is invalid"

The value is outside the accepted grammar (see docs/CONFIGURATION.md). The
message names the offending entry and why: `true`, a hop count above 10, a
CIDR wider than `/8`/`/7`, an IPv4-mapped IPv6 entry, a zone id, netmask
notation or an empty entry.

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

### Shutdown takes ~6 s / exits 1 with SSE clients

Fixed by issue #192. Before the fix, every SIGTERM with an open SSE stream (or a
request that finished during the close) took about 6 s, the
`keepAliveTimeout` + buffer. With `SHUTDOWN_TIMEOUT_MS` below that, it exited **1**
and logged "graceful close timed out — forcing shutdown" even though nothing was
dropped. The handler now begins a drain before `app.close()`. Every stream gets
`event: shutdown` and ends, and sockets that go idle during the close are reaped
every 100 ms once the listener has closed (see `docs/ARCHITECTURE.md`,
Operational concerns). If you still see it:

1. A **slow client** (full TCP buffer) never finishes its last write, so its
   socket stays active and the deadline + forced close still apply. That exit 1 is
   honest, because a connection really was cut.
2. A genuinely **in-flight request** that outlives `SHUTDOWN_TIMEOUT_MS` is still
   forced, and the process exits 1. That is the documented contract.
3. Check the log for `could not begin the shutdown drain`: if the drain itself
   failed, streams fall back to the stream-hub teardown, which ends them without
   a `shutdown` event.

Clients see `event: shutdown` with a `retry:` hint (`STREAM_SSE_SHUTDOWN_RETRY_MS`)
and should reconnect after it (see `docs/API.md`, SSE).

Every shutdown logs one structured summary line, `shutdown drain complete`, with
`drainMs`, `drainDelayMs` (the `SHUTDOWN_DRAIN_DELAY_MS` wait actually spent,
0 when unset or skipped at once), `sseStreamsTerminated`, `drainRejections` and
`forcedConnections` (0 on a clean close). An overrun also logs `graceful close timed out — forcing
shutdown` with `forcedConnections`: the sockets still open when the deadline
fired (`null` if they could not be counted). Read the log, not the metrics: a
dying process is rarely scraped, so `acdp_shutdown_drain_rejections_total` and
`acdp_shutdown_forced_connections_total` are best effort.

### `503 SERVICE_DRAINING` during a deploy

Expected (issue #192). Once an instance has begun closing after
SIGTERM/SIGINT/SIGQUIT (immediately, or after `SHUTDOWN_DRAIN_DELAY_MS` when that
is set), every request whose **headers arrive after that moment** gets `503` with
`errorCode: "SERVICE_DRAINING"`, `Retry-After` (`SHUTDOWN_RETRY_AFTER_SECONDS`,
default 1) and `Connection: close`, so the client reconnects, through the load
balancer, to another replica. It is answered before authentication, so it costs
no throttle or quota budget. `/healthz` and `/readyz` get it too, which is right for
a stopping container. Things that are **not** rejected:

- A request whose headers arrived *before* the signal runs to completion, even if
  its body finishes afterwards. A request that needs the database can still fail
  if it outlives the pool, which ends during the close (a known limitation).
- A new `GET` on either SSE route is let through by the gate and, once past the
  auth guard, gets `200`, `event: shutdown` and the end of the stream (a non-2xx
  makes `EventSource` stop reconnecting). Under `AUTH_PERSISTENCE=postgres` a JWT
  client can still get a non-2xx from the guard's revocation lookup once the
  database pool has ended.
- A CORS preflight is answered `204` by the CORS layer as usual; the real request
  that follows it gets the `503` with CORS headers, so a browser can read it.

Registry webhooks (`POST /ingest/acdp`) are retried by the registry on a `503`,
but with the registry's default `max_retries = 3` the whole retry window is only
about 750 ms (250 ms + 500 ms of backoff), after which the delivery is dropped
silently. A delivery reaches another replica only if your load balancer stops
routing to the stopping one within that window. If you lose deliveries during
deploys, raise the registry's webhook `max_retries`.

Without `SHUTDOWN_DRAIN_DELAY_MS` the listener closes within milliseconds of the
signal unless a destroy hook is slow, so most clients see a refused connection
rather than this `503`; the `503` is what a client gets while the close is still
running. If your load balancer keeps routing to stopping instances, see the next
section.

### Refused connections / lost webhooks during rolling deploys behind a load balancer

The load balancer is still routing to an instance whose listener has already
closed. Set `SHUTDOWN_DRAIN_DELAY_MS` (e.g. `5000`; issue #192 Phase 3, default
`0`). For that long after the signal `/readyz` answers `503 SERVICE_DRAINING`
(without touching the database) while **every other route keeps serving**, and SSE
streams end with `event: shutdown` so clients reconnect elsewhere; only then does
the close begin. The log shows `draining before close — readiness now 503`
(`configuredDelayMs`) and the summary's `drainDelayMs` is the delay actually waited.

Still seeing it with a delay set? Check, in order:

1. **The probe is too slow to notice.** `periodSeconds × failureThreshold` (ms)
   must be well below `SHUTDOWN_DRAIN_DELAY_MS` (e.g. `1 × 2 = 2000` < `5000`),
   leaving time for the endpoint change to reach the load balancer.
2. **The process is SIGKILLed mid-drain** (exit 137, no `shutdown drain complete`
   line). The termination grace period must be at least
   `(SHUTDOWN_DRAIN_DELAY_MS + SHUTDOWN_TIMEOUT_MS)/1000 + 5` seconds: Kubernetes
   `terminationGracePeriodSeconds` (default 30), Docker/Compose
   `stop_grace_period` (default 10). Startup warns when delay + timeout exceeds
   25000 ms.
3. **A `preStop: sleep` is also configured.** Use one or the other: the two add
   up, and only the delay flips `/readyz`.
4. **Shutdown is unexpectedly short** and the log has `second signal — skipping
   drain delay`: something sent a second SIGTERM/SIGINT (a supervisor, or ctrl-c
   twice). That skips the rest of the delay by design; the close still runs once.

For local development keep `SHUTDOWN_DRAIN_DELAY_MS=0` (the default): there is no
load balancer to wait for, and every ctrl-c would otherwise pause. Pressing ctrl-c
twice skips a configured delay.

---

## Federation proxy

### `503 FEDERATION_UPSTREAM_RATE_LIMITED` from `GET /contexts/*`

The owning registry returned `429`. The CP maps it to `503` and logs the upstream
`Retry-After`. Back off and retry.

### `502 FEDERATION_UPSTREAM_ERROR` from `GET /contexts/*`

The `SafeFederationClient` blocked the fetch: SSRF policy (non-HTTPS, IP literal,
private/loopback/IMDS-resolved host), a cross-authority redirect, an oversized
body (>1 MiB), or a transport/timeout error. The specific cause is in the
`federation proxy upstream fetch failed` warn line's `fetchErrorCode` field
(`SSRF` | `FETCH` | `REDIRECT` | `BODY_TOO_LARGE`, with `detail`). A `502`
carrying `CONTEXT_ID_MISMATCH` / `CONTEXT_BINDING_UNVERIFIABLE` is different:
the registry did answer, but the served `ctx_id` binding failed.

### `404` from `GET /contexts/*`

The authority isn't enrolled **in the caller's tenant**, or its enrollment has no
`baseUrl`. Enroll it with a `baseUrl`.

---

## Receipt audit

### Audits that used to be `verified` are now `error` with `unverified: stored ctx_id … is not canonical`

Since the `acdp` `^0.14.1` bump the SDK parses `expectedCtxId` with `CtxId::parse`
(`acdp://` + a lowercase DNS authority + a lowercase v4 UUID — a port in the
authority never parses). `ReceiptAuditService` pre-checks that grammar before the
federation fetch, so an event whose **stored** `ctx_id` is non-canonical gets an
`error` verdict with an `unverified:` note instead of a `verified` one. That is the
correct verdict — a receipt cannot be verified against a ctx_id the protocol cannot
name — and it is **not** registry dishonesty, so it never reaches the `flagged` list
on `GET /runs/:runId`.

Before rolling the bump out, count the affected rows per environment:
```sql
SELECT count(*) FROM context_events WHERE ctx_id IS NOT NULL AND ctx_id !~ '^acdp://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
```
A non-zero count means exactly that many events will move from `verified` to `error`.
Expect it, don't page on it.

After the fact, each occurrence logs a `warn` with `auditCause` =
`stored_ctx_id_not_canonical` (or `sdk_rejected_ctx_id`, when the SDK refuses a
ctx_id the host pre-check allowed — the host mirror deliberately doesn't enforce the
63-character DNS-label limit) alongside `eventId` / `ctxId` / `runId` /
`registryAuthority`. Alert on `auditCause`, not on
`acdp_receipt_audits_total{status="error"}`, whose label is shared with ordinary
fetch and DID-resolution failures. To list the stored verdicts:
```sql
SELECT event_id, ctx_id, registry_authority, discrepancies
FROM receipt_audits
WHERE status = 'error' AND discrepancies::text LIKE '%ctx_id%'
ORDER BY checked_at DESC LIMIT 50;
```
Fix the producer/registry that minted the non-canonical ctx_id; re-ingested events
with a canonical `ctx_id` audit normally.

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

### `GET /readyz` returns `503 DEPENDENCY_UNAVAILABLE`

Expected while Postgres cannot serve this replica (issue #210): the load balancer
should stop routing here until it recovers. The body is the standard error envelope;
`error.details.checks.database.reason` says why:

- `"error"` — the probe failed fast: connection refused, authentication failure,
  `max_connections` exhausted, the pool ended. The driver's error text is never in
  the body (the endpoint is unauthenticated); it is in the `readiness changed` warn
  log line, logged once per transition, along with `latencyMs`.
- `"timeout"` — no answer within `READINESS_DB_TIMEOUT_MS` (default 1000 ms): a
  network partition, an overloaded database, or a **saturated pool**. The probe uses
  the shared app pool, so if every connection is busy for longer than the timeout,
  readiness reads as down too — real requests are also waiting at that point. Check
  for long-running queries and `DB_POOL_MAX` before suspecting the network.
  **Tell saturation from an outage with `/metrics`:**
  `acdp_db_pool_connections{state="waiting"} > 0` alongside `reason: "timeout"`
  (and `total` at `DB_POOL_MAX`) means the pool is saturated — requests are queued
  for a connection — while `waiting` at 0 means the pool itself is not the bottleneck and the database
  is unreachable or slow (with refused connections `total` falls; during a network
  black-hole connecting clients still count toward `total`, so it may not).

If the body also carries `checks.streamHub` or `checks.quotaStore`, those are
**report-only** (`required: false`): a Redis outage shows `status: "down"` there and
`acdp_dependency_up{dependency="redis_stream_hub"}` (or `redis_quota_store`) at `0`,
but never makes `/readyz` 503. It degrades cross-replica SSE fan-out (and quota
enforcement fails open); every replica sees the same Redis, so pulling them all out
of the load balancer would only turn that into a total outage.

Also check:

- **Kubernetes `timeoutSeconds`.** With the default 1000 ms probe timeout, set the
  `readinessProbe`'s `timeoutSeconds` to at least `2`; with the k8s default of `1`
  the kubelet gives up first and reports a failure without our label or metric.
- **A few seconds of 503 after the database is back is normal.** The verdict is
  cached for `READINESS_CACHE_MS` and the probe is single-flight, so a probe still
  stuck in a connect or checkout must finish first. Recovery takes up to
  `READINESS_CACHE_MS + max(READINESS_DB_TIMEOUT_MS, DB_POOL_CONNECTION_TIMEOUT)`
  (defaults: about 6 s), and in the worst case (wait for a connection, then a slow
  `SELECT 1`) `READINESS_CACHE_MS + DB_POOL_CONNECTION_TIMEOUT + READINESS_DB_TIMEOUT_MS`
  (about 7 s).
- **Metrics.** `acdp_dependency_up{dependency="database"}` is 0 while down;
  `acdp_readiness_checks_total{dependency="database",result="error"|"timeout"}` counts
  the real probes (cache hits are not counted). Alert on the gauge being 0 for 1m.
- **Probes used to be `429`'d.** Before #210, `/healthz` and `/readyz` were
  rate-limited per IP like any public route, so a busy load-balancer fleet or a
  shared-NAT monitor could read "unready" from a `429`. Fixed: both are now
  `@SkipThrottle()` — `/readyz`'s database cost is bounded by the cache, and
  `/healthz` never touches the database at all. Upgrade.
- **Probe request logs are now `debug`.** Successful `GET`/`HEAD` `/healthz` and
  `/readyz` request-log lines moved from `info` to `debug` (the throttle no longer
  caps their volume); a non-2xx probe answer still logs at `info`.

### `GET /healthz` reports `ok: false`

`/healthz` is liveness: it is `200` whenever the process can answer and never
touches the database (issue #210). Its `ok` field mirrors the **last readiness
verdict**, so `200` with `ok: false` means "alive, but `/readyz` last found
Postgres unavailable" — see [`GET /readyz` returns `503
DEPENDENCY_UNAVAILABLE`](#get-readyz-returns-503-dependency_unavailable) for
the cause. It is live, not latched: once the database is back, `ok` returns to
`true` by itself — immediately after the next `/readyz` probe, or, with
`/healthz` traffic alone, within about `max(READINESS_CACHE_MS, 5 s)` plus one
probe (a stale verdict triggers a background refresh). **Do not restart the pod
for it**: a restart cannot fix the database.

Before #210 a single pool `'error'` (an idle connection dropped by a Postgres
restart or failover) latched `/healthz` at `ok: false` until the process
restarted. That latch is gone. Those events are still logged (`database pool
error`) and now counted on `acdp_db_pool_errors_total`; occasional increments
around a database restart are expected and harmless — pg-pool discards the dead
client and reconnects on demand. A steadily climbing counter with a healthy
`/readyz` points at something closing idle connections (a proxy or firewall
idle timeout shorter than `DB_POOL_IDLE_TIMEOUT`).

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

### Boot fails with `EISDIR: illegal operation on a directory, read … the .env path ".env" is a directory`

`./.env` is a directory. Almost always a Docker bind mount (`-v ./.env:/app/.env` or a compose
`volumes:` entry) of a file that did not exist on the host, so Docker created a directory.
Create the file on the host (or drop the mount), delete the stray `.env/` directory, and
recreate the container. See [CONFIGURATION.md](./CONFIGURATION.md).

### Integration tests fail with `ECONNREFUSED localhost:5433`

The test Postgres isn't running. `globalSetup` starts it via
`docker compose -f docker-compose.test.yml up -d postgres-test redis-test`; if
Docker isn't running, start them manually and keep them up:
```bash
docker compose -f docker-compose.test.yml up -d postgres-test redis-test
KEEP_TEST_DB=1 npm run test:integration
```

### Integration tests fail with `database "acdp_control_plane_test" does not exist`

Different failure from the one above, and easy to misread as it. Here the TCP
connect **succeeds** — something is listening on 5433, it just isn't ours. Another
project's Postgres is squatting the port, and because `docker compose --wait`
reports its own container Healthy, everything looks fine right up to the query.

This is structural rather than unlucky: this repo publishes `5433:5432`
(`docker-compose.test.yml`), so any two ACDP-family projects on one machine collide.
A second Docker daemon makes it worse — the squatter can be invisible to the
context you are using.

Diagnose, checking **every** Docker context rather than just the active one:

```bash
lsof -nP -iTCP:5433 -sTCP:LISTEN     # who actually holds the port
docker context ls                    # more than one daemon?
docker ps --format '{{.Names}} {{.Ports}}'
```

Then either stop the squatter, or leave it alone and publish this project's test
Postgres somewhere else — `DATABASE_URL` is honored by both `global-setup.ts` and
`test/helpers/test-db.ts`, so nothing in the repo needs changing:

```bash
docker run -d --name acdp-cp-itest-alt -p 55433:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=acdp_control_plane_test postgres:16-alpine
DATABASE_URL='postgres://postgres:postgres@localhost:55433/acdp_control_plane_test' \
  npm run test:integration
```

Prefer the override to editing the published port: that port is shared with CI
(`.github/workflows/ci.yml`), so changing it to fix one machine changes it for
everyone.

> **Why `truncateAll` will not wipe the squatter.** It refuses any database whose
> name does not end in `_test`, and it reads that name from
> `select current_database()` on the connection it is about to truncate — never
> from `DATABASE_URL`. A database that *does* end in `_test` but belongs to another
> project still passes; that residual is deliberate and documented in
> `test/helpers/test-db.ts`, and `test/integration/test-db-guard.integration.spec.ts`
> pins the refusal path.

### The live-Redis spec says "no Redis at redis://127.0.0.1:6380 — SKIPPING"

`test/integration/redis-live.integration.spec.ts` needs the `redis-test`
service (published on **6380**, not 6379, so it cannot collide with your own
local Redis). Start it with the command above. The skip is local-only by
design — in CI the spec fails loudly rather than skipping, because a
wire-protocol spec that silently skips reports green while proving nothing.

## Build / TypeScript

### Boot fails: `The loaded acdp SDK binding verifies Ed25519 non-strictly … sig-004`

At startup (`bootstrap()`, before config or the database) the control plane runs the
RFC-ACDP-0001 §5.10 `sig-004` small-order forgery through `AcdpVerifier` and **refuses to
start** if the binding accepts it. Cause: an `acdp` older than 0.14.4, or a native
`optionalDependency` that resolved to an older binary than the JS package. Fix: `npm ci`
(the lockfile pins all four native packages at the strict version), then confirm
`node -e "console.log(require('@agentcontextdistributionprotocol/acdp/package.json').version)"`
prints `0.14.4` or later.

### `npm run start` fails with `Cannot find module '.../dist/main'`, but `npm run build` exited 0

Almost certainly stale incremental build state that escaped `dist/`.

`tsconfig.build.json` sets `rootDir: "./src"` (so emit lands at `dist/main.js` rather
than `dist/src/main.js`). A side effect: TypeScript derives the default `.tsbuildinfo`
path as `resolve(outDir, relative(rootDir, <config>))`, which with that `rootDir` points
at the **repo root**, not `dist/`. `nest-cli.json` sets `deleteOutDir: true`, so `dist/`
is wiped on every build while the build state survives — tsc then concludes the program
is up to date and **emits nothing, exiting 0**. The first build looks fine; every build
after it produces no `dist/` at all.

The config pins `tsBuildInfoFile` back inside `outDir` to prevent this, so it should not
recur. If it does:

```bash
rm -f *.tsbuildinfo && rm -rf dist && npm run build
npm run check:build      # builds TWICE and asserts the emit shape
```

`npm run check:build` (also a CI step) is the guard: it checks `dist/main.js` and
`dist/db/migrate.js` exist, that there is no `dist/src/`, that no stray `.tsbuildinfo`
sits at the repo root, and that `dist/main.js` actually loads. It builds twice because a
single build cannot detect this failure mode.

### `error TS5107` / `TS5108`: `Option 'moduleResolution=node10' is deprecated` / `has been removed`

`tsconfig.json` uses `moduleResolution: "bundler"` (issue #156), which TypeScript 6 and 7
both accept with `module: "commonjs"`. Seeing either error means someone reintroduced
`moduleResolution: "node"` (node10): TS 6 rejects it as deprecated (`TS5107`) and TS 7
removed it (`TS5108`). Put `bundler` back — do **not** add `ignoreDeprecations` to
silence it; that only works on 6.x and would also swallow the next deprecation.

### `dist/main.js` crashes with `ERR_PACKAGE_PATH_NOT_EXPORTED` / `ERR_REQUIRE_ESM`, but typecheck passed

`bundler` resolution matches a package's `types` export condition, so an import of a
package whose `exports` only offers `import` (ESM-only, no `require`/`default`) typechecks
cleanly — yet the emitted CommonJS `require()` throws at runtime. `npm run check:build`
boots `dist/main.js` and fails on these codes; any spec that imports the module fails
too, via jest's CJS resolver. Fix by using a CJS-compatible version of the package
(a dynamic `import()` does not help: with `module: "commonjs"` it is emitted as
`require()` too). Neither the `check:build` boot nor `release.yml`'s image boot
exercises lazily `import()`ed modules (`ioredis` under `STREAM_HUB_STRATEGY=redis`) or
`dist/db/migrate.js`.

### Which TypeScript does `nest build` actually use?

**TypeScript 6, by design** — the top-level `typescript` package, the same compiler
`ts-jest`, `ts-node` and `eslint` load. TypeScript 7 is installed too, but **only
typechecks** (issue #156 Phase 2): it lives under the npm alias
`"@typescript/native": "npm:typescript@^7.0.2"`, because TS 7.0 ships no JS compiler API
and every tool above needs one. `npm run typecheck` runs TS 7 over `tsconfig.json` and
`test/tsconfig.test.json`; `npm run typecheck:ts6` runs TS 6 over `tsconfig.json`; CI
runs both, and `nest build` (via `check:build`) typechecks with TS 6 again.

**Bare `npx tsc` is ambiguous.** Both packages declare a `tsc` bin, and npm currently
links `node_modules/.bin/tsc → ../@typescript/native/bin/tsc` — so `npx tsc` runs **TS 7**
while `nest build` runs TS 6. That is a name collision, not a contract; use the npm
scripts (explicit paths) or `node node_modules/typescript/bin/tsc` for TS 6.

If the two compilers disagree (a TS-7-only error): fix the code when both readings are
legal; if TS 7 is wrong, file upstream and pin `@typescript/native` to the last good
patch — never weaken `tsconfig.json`. Dependabot skips `npm:` alias specifiers, so the
TS 7 line is bumped by hand (`npm install -D "@typescript/native@npm:typescript@^7.x"`).

How `nest build` picks its compiler is worth stating explicitly, because it is easy to get
wrong by reading `npm ls`. `@nestjs/cli` resolves its compiler with `process.cwd()` **first**:

```js
// node_modules/@nestjs/cli/lib/compiler/typescript-loader.js
const tsBinaryPath = require.resolve('typescript', {
  paths: [process.cwd(), ...this.getModulePaths()],
});
```

and npm scripts run with cwd = package root. So even when the CLI ships its own pinned
`typescript` nested under `node_modules/@nestjs/cli/node_modules/`, that copy is **never
loaded**. To confirm on any checkout:

```bash
node -e "const {TypeScriptBinaryLoader}=require('@nestjs/cli/lib/compiler/typescript-loader');
         console.log(new TypeScriptBinaryLoader().load().version)"
```

Don't infer the compiler in use from `npm ls` — it reports what is *installed*, not what is
*loaded*. (On CLI 11 the two disagreed and `npm ls typescript` showed two nodes; since the
CLI 12 bump it pins a range the repo already satisfies, so npm dedupes and there is one.)

### `npm warn EBADENGINE Unsupported engine` on install

Expected on some Node versions, and **not** fatal — `npm ci` still exits 0.

`@nestjs/schematics@12` and `@angular-devkit/*@22` (build tooling, dev-only) declare:

```
node: ^22.22.3 || ^24.15.0 || >=26.0.0
```

which **excludes Node 23 and 25 entirely**, plus any Node 22 below 22.22.3. Since the
NestJS 12 bump (#155) the repo also declares its own floor, `"engines": { "node": ">=24.15" }`
in `package.json`: the tightest real floor among the tooling it runs (`@nestjs/schematics`'
24.15; the Nest 12 runtime itself ≥ 20.19/22.12). Jest no longer imposes a floor of its own:
since #191 it down-compiles `@nestjs/*` to CommonJS with `@swc/jest` instead of relying on
Node's experimental vm-modules API (see [TESTING.md](TESTING.md)). On Node 22 you will
therefore see EBADENGINE for this package too, and the suites are untested there. Node 25 passes this
package's own `>=24.15` check but still warns via `@nestjs/schematics`. Use Node 24.15+
(24.x) or 26.

Where it stands today: CI and the Docker images both run **Node 26** (`node:26-bookworm-slim`
in the Dockerfile, `node-version: '26'` in every workflow), which satisfies the range. CI ran
Node 22 until issue #137's finalization pass raised it so the pipeline validates the same major
that actually ships. If you see this warning locally you are below the floor (or on Node 25). Installs still
work, but nothing below 24.15 is tested. Moving to Node 24.15+ or 26+ silences the warning. Only if you have
`engine-strict=true` in your own npm config does the warning become a hard install failure.
