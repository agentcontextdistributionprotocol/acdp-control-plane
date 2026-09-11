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

### `error TS5107: Option 'moduleResolution=node10' is deprecated`

Expected under TypeScript 6 and silenced by `ignoreDeprecations: "6.0"` in
`tsconfig.json`. If you removed that line, put it back. Note TS 7.0 **removes** both the
option and the escape hatch (`TS5108`) — see the TODO in `tsconfig.json` for the
migration options.

### Which TypeScript does `nest build` actually use?

The top-level one — the same compiler as `tsc`, `ts-jest`, `ts-node` and `eslint`.

This is worth stating explicitly because it is easy to get wrong by reading `npm ls`.
`@nestjs/cli` resolves its compiler with `process.cwd()` **first**:

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

which **excludes Node 23 and 25 entirely**, plus any Node 22 below 22.22.3. This repo
declares no `engines` field of its own, so npm reports the transitive constraint directly.

Where it stands today: CI and the Docker images both run **Node 26** (`node:26-bookworm-slim`
in the Dockerfile, `node-version: '26'` in every workflow), which satisfies the range. CI ran
Node 22 until issue #137's finalization pass raised it so the pipeline validates the same major
that actually ships. If you see this warning locally you are on an excluded version — installs
and tests still work, but moving to Node 22.22.3+, 24.15+ or 26+ silences it. Only if you have
`engine-strict=true` in your own npm config does the warning become a hard install failure.
