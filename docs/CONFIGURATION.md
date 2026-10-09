# Configuration Reference

Every environment variable the control plane reads is parsed in **one place** —
`AppConfigService` (`src/config/app-config.service.ts`). The only files allowed to
read `process.env` directly are `main.ts`, `load-env.ts`, `db/migrate.ts`, `telemetry/telemetry.ts`,
the `auth/{pinned-keys.service,pinned-keys-admin.controller,auth.module}.ts` set,
and `domain-packs/domain-packs.module.ts`. Start from `.env.example`.

`.env` is loaded automatically at process start by `src/load-env.ts` — the
first import in `main.ts`, before anything else runs — so it's populated
before `AppConfigService` is ever constructed (including the manual instance
`bootstrap()` (`src/bootstrap.ts`) uses to drive database migrations, ahead of
Nest's own bootstrap). It uses Node's built-in `util.parseEnv` (the parser
behind `node --env-file`) via `src/env-file.ts`; no `dotenv` package.
A variable already set in the environment wins over `.env` (an empty value
still wins); a missing `.env` is not an error and the load is silent; an
`.env` that exists but cannot be read (permissions, a directory) **fails boot**
rather than silently dropping config (an `EISDIR` names the usual cause: a Docker
bind mount `-v ./.env:/app/.env` of a host file that does not exist). A UTF-8 BOM is tolerated, there is no
`${VAR}` expansion, and `KEY: value` lines are not supported. The former
`DOTENV_OVERRIDE` / `DOTENV_QUIET` / `DOTENV_CONFIG_PATH` knobs no longer have
any effect; for a different file, export the variables or run
`node --env-file=<file> dist/main.js`. `src/env-file.spec.ts` and
`src/load-env.spec.ts` pin all of this.

Defaults below are the code defaults. Startup checks come in two tiers: some
run in **every** environment, the rest only when `NODE_ENV` is anything other
than `development` (so `test` and `staging` count as "production" here). A
misconfiguration in the second tier boots silently under `NODE_ENV=development`
— see [Startup validation](#startup-validation) for which check is which.

> Several keys are env-var equivalents of the registry's TOML config (e.g.
> `AUTH_REQUIRE_TENANT` ↔ `auth.require_tenant`, `TENANT_AGENTS` ↔
> `[[auth.tenant_agents]]`, `REVOCATION_FEEDS` ↔ `[[auth.revocation_feeds]]`,
> `CONTROL_PLANE_PINNED_KEYS` ↔ `[[playground.pinned_keys]]`). They exist so the
> CP enforces the same rules; the model behind them lives in the registry's
> [CONFIGURATION.md](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/CONFIGURATION.md),
> [AUTHENTICATION.md](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/AUTHENTICATION.md),
> and [MULTI-TENANCY.md](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/MULTI-TENANCY.md).

## Core server

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `NODE_ENV` | string | `development` | Exactly `development` skips the production-only startup checks and turns Swagger on by default; any other value (`production`, `test`, …) runs them. |
| `PORT` | number | `3001` | HTTP listen port. |
| `HOST` | string | `0.0.0.0` | Bind address. |
| `PUBLIC_HOST` | string | `''` | Externally-resolvable host (`example.com` / `example.com:8443`) a consumer's `did:web` resolver hits for `/.well-known/did.json`. Distinct from `HOST`. Used to assert the `did:web` witness↔host binding at boot. |
| `CORS_ORIGIN` | string | `http://localhost:3000` | Allowed CORS origin. |
| `SHUTDOWN_TIMEOUT_MS` | integer (ms), 1000–2147483647 | `10000` | Max ms `app.close()` may take on SIGTERM/SIGINT/SIGQUIT before lingering sockets are dropped and the process exits 1 (the overrun log names how many, `forcedConnections`). Keep below the platform termination grace period (Docker 10 s, Kubernetes 30 s). Strict: a non-integer or a value below 1000 fails startup (it used to fall back to 10000 silently). |
| `SHUTDOWN_RETRY_AFTER_SECONDS` | integer (s), 1–300 | `1` | `Retry-After` on the `503 SERVICE_DRAINING` sent to every new non-SSE request once the close has begun, and on `/readyz`'s drain 503 (issue #192, see [API.md](./API.md)). Strict. |
| `SHUTDOWN_DRAIN_DELAY_MS` | integer (ms), 0–2147483647 | `0` | Opt-in pre-close drain delay (issue #192, Phase 3). On SIGTERM/SIGINT/SIGQUIT the process first spends this long *draining*: `/readyz` answers `503 SERVICE_DRAINING` (without querying the DB), SSE streams end with `event: shutdown`, and **every other route keeps serving**, so a load balancer can deregister the instance before the listener closes. Only then does `app.close()` run under `SHUTDOWN_TIMEOUT_MS`, so the worst-case shutdown is delay + timeout; startup **warns** (does not fail) when that exceeds 25000 ms. A second signal skips the rest of the delay. `0` keeps the pre-Phase-3 timing exactly. Use it *or* a Kubernetes `preStop: sleep`, not both. See [ARCHITECTURE.md](./ARCHITECTURE.md#deploying-behind-a-load-balancer) for the grace-period and readiness-probe arithmetic. Strict. |

## Database

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `DATABASE_URL` | string | `postgres://postgres:postgres@localhost:5432/acdp_control_plane` | Postgres connection string. |
| `DB_POOL_MAX` | number | `20` | Max pool connections per replica. **Must be ≥ 2** (checked only outside `development`). |
| `DB_POOL_IDLE_TIMEOUT` | number (ms) | `30000` | Idle connection timeout. |
| `DB_POOL_CONNECTION_TIMEOUT` | integer (ms), 1–2147483647 | `5000` | Connection-acquisition timeout: bounds both waiting for a pool checkout and opening a new connection. **Must be an integer > 0** (every environment, issue #210); 0 would disable pg-pool's checkout/connect timeouts — an unbounded wait on a black-holed database — and a negative value makes every connect fail at once. Strict: a set value that is not a plain decimal integer (`5s`, `1.5`, empty) fails startup instead of falling back to `5000`. |
| `READINESS_DB_TIMEOUT_MS` | integer (ms), 50–30000 | `1000` | `GET /readyz` database probe deadline (issue #210): `SELECT 1` with this `query_timeout`, raced against an outer deadline of the same length that also covers the checkout and connect wait. Past it, `/readyz` answers `503 DEPENDENCY_UNAVAILABLE` with `reason: "timeout"`. Keep it below your probe's own timeout — with the default, a Kubernetes `readinessProbe` needs `timeoutSeconds: 2` (the k8s default of 1 would time out first). A value ≥ `DB_POOL_CONNECTION_TIMEOUT` only **warns**: the pool's bound then fires first and a slow connect reads as `reason: "error"`. Strict. |
| `READINESS_CACHE_MS` | integer (ms), 0–60000 | `1000` | How long a readiness verdict is reused (issue #210). Caps probe-driven database load at about one `SELECT 1` per window per replica, whatever the probe rate (which is why the probes are not throttled). `0` disables the cache; the probe stays single-flight (never more than one probe query, so never more than one pool connection). Strict. |

`GET /healthz` reads none of these at request time: it is liveness and never
touches the database (issue #210). It mirrors the last readiness verdict, and
refreshes it in the background once that verdict is older than
`max(READINESS_CACHE_MS, 5000)` ms. Point Kubernetes `livenessProbe` /
`startupProbe` at `/healthz` and `readinessProbe` at `/readyz`
(`timeoutSeconds ≥ 2`); see [API.md](./API.md#observability).

## Authentication & issuance

See [AUTH.md](./AUTH.md).

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `AUTH_API_KEYS` | CSV | `''` | Bearer API keys. Empty = auth bypassed (dev only). |
| `AUTH_ADMIN_API_KEYS` | CSV | `''` | Subset allowed admin ops (revoke any jti, reload pinned keys, read revocation feed, enroll registry, routing stats). |
| `AUTH_REQUIRE_TENANT` | bool | `false` | Strict-tenant default-deny. See [TENANCY.md](./TENANCY.md). |
| `TENANT_HEADER_TRUST` | enum | `none` | `none` \| `any_peer`. Who may assert a tenant via `X-Tenant-Id` on a JWT with no `tenant` claim (registry `tenant_header_trust` parity). `none` → `403 TENANT_HEADER_UNTRUSTED`; `any_peer` honours it (warns at boot on a non-loopback `HOST`). Anything else fails startup. Older builds ignore it (behave as `any_peer`). |
| `AUTH_PERSISTENCE` | `memory`\|`postgres` | `memory` | Backend for challenges/revocations/ledger. `postgres` required for multi-instance. Any other value fails startup (every environment). |
| `AUTH_SWEEP_INTERVAL_SECONDS` | number | `300` | Expired-state GC interval; `≤0` disables. |
| `TOKEN_ISSUANCE_ENABLED` | bool | `false` | Master switch for the whole JWT side: mounts `/auth/challenge`, `/auth/token`, `/auth/token/revoke`, `/auth/introspect`, `/auth/revocations` and `/.well-known/jwks.json`, and wires JWT verification — **including** federated `TRUSTED_ISSUERS` tokens and the `REVOCATION_FEEDS` poller. Off = API keys only; every bearer JWT is rejected. |
| `JWT_SECRET` | string | `''` | HS256 signing secret. **≥32 bytes** when issuance + HS256 (checked only outside `development`). |
| `JWT_SIGNING_ALG` | `HS256`\|`EdDSA` | `HS256` | Issuance algorithm (case-sensitive). Any other value fails startup (every environment). |
| `JWT_PRIVATE_KEY_PEM` | string (PEM) | `''` | Ed25519 PKCS8 private key. **Required** when issuance + EdDSA (checked only outside `development`). |
| `JWT_KID` | string | `''` | Override `kid`; else derived from key fingerprint. |
| `JWT_AUTHORITY` | string | `control-plane.local` | `iss` claim + challenge signing input. |
| `JWT_AUDIENCE` | string | = `JWT_AUTHORITY` | `aud` claim bound + required on local verify. |
| `JWT_TTL_SECONDS` | number | `3600` | Issued-token TTL. **≥60** when issuance (checked only outside `development`). |
| `CHALLENGE_TTL_SECONDS` | number | `300` | Challenge-nonce TTL. **≥30** when issuance (checked only outside `development`). |
| `CONTROL_PLANE_PINNED_KEYS` | CSV | `''` | `did=base64[:alg][:from..until]`. Verification + emergency revocation. Loaded whether or not issuance is on; a malformed entry is skipped with a warning, never a boot failure. |
| `TRUSTED_ISSUERS` | CSV | `''` | Federated peers (parsed — and its boot failures below raised — only when `TOKEN_ISSUANCE_ENABLED=true`). `iss\|alg\|material\|audience[\|scope[\|flags]]`. `audience` required. `flags` (6th field, whitespace-separated, closed set; today only `read_only`) — to set a flag without a scope leave the scope empty: `iss\|HS256\|<secret>\|<aud>\|\|read_only`. `read_only` limits that issuer's tokens to GET/HEAD/OPTIONS (403 `ISSUER_READ_ONLY` otherwise; `POST /auth/introspect` exempt). An entry whose `iss` equals `JWT_AUTHORITY` fails startup (it would be shadowed by the local issuer). Unknown/duplicate flags, a flag name in the scope slot, or >6 fields fail startup. **Rollback hazard:** a build older than this field silently ignores the 6th field, so rolling back drops `read_only`. `scope` (optional) is checked against the token's `scope`/`scopes`/`scp` claims; do not set it for ACDP registry peers (they mint no scope claim). |
| `REVOCATION_FEEDS` | CSV | `''` | Peer feeds to poll. `issuer\|url\|admin_token[\|poll_seconds]`. The poller runs only with `TOKEN_ISSUANCE_ENABLED=true`. |

## Tenancy

See [TENANCY.md](./TENANCY.md).

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `TENANT_API_KEYS` | CSV | `''` | `tenantId:key,…,bareKey`. Bare keys → `default`. |
| `TENANT_AGENTS` | CSV | `''` | `tenantId:agent_did,…`. Stamps JWT `tenant` claim. |
| `TENANT_QUOTAS` | string | `''` | Per-tenant quotas. See [POLICY.md](./POLICY.md#config--tenant_quotas). Ingest `publish` is charged to the tenant the webhook resolves to (an enrolled registry's tenant), after HMAC — a lone `default:publish` does not limit registries enrolled under other tenants; add `<tenant>:publish` ([INGEST.md](./INGEST.md#quota-and-rate-limits)). |

## Policy

See [POLICY.md](./POLICY.md).

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `POLICY_BACKEND` | `static`\|`opa` | `static` | Decision backend (case-insensitive). Any other value fails startup (every environment). |
| `OPA_URL` | string | `http://localhost:8181` | OPA sidecar base URL. |
| `OPA_PACKAGE_PATH` | string | `acdp/policy/v1` | OPA package path. |
| `OPA_TIMEOUT_MS` | number | `1500` | Per-query timeout. |
| `OPA_FAIL_OPEN` | bool | `false` | On OPA error, allow instead of deny. |

## Ingest

See [INGEST.md](./INGEST.md).

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `WEBHOOK_SECRET` | string | `''` | Global HMAC secret for inbound webhooks. Empty = verification skipped (dev only — fails startup outside `development`). |
| `INGEST_REQUIRE_ENROLLMENT` | bool | `false` | Accept only enrolled authorities. |
| `INGEST_STRICT_TENANT` | bool | `false` | An unenrolled authority's non-`default` `X-Tenant-Id` is ignored (warn log) and the event lands in `default`. |
| `INGEST_MAX_BODY_BYTES` | number | `1048576` | Raw body cap (1 MiB). Also the JSON body-parser limit for every route, so an oversized JSON body is `413 PAYLOAD_TOO_LARGE`. |
| `INGEST_MAX_JSON_DEPTH` | number | `64` | JSON nesting-depth cap. |
| `DOMAIN_PACKS` | CSV | `''` | Active domain packs; gates custom `context_type`s. The only compiled-in pack today is `finance`; an unknown or duplicate name fails startup (every environment). |

## Outbound webhooks

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `WEBHOOK_RETRY_INTERVAL_MS` | number | `300000` | Outbox retry-sweep interval; `≤0` disables. |
| `WEBHOOK_SSRF_ALLOW_HTTP` | bool | `false` | Allow non-HTTPS subscriber URLs (dev only). |
| `WEBHOOK_SSRF_ALLOW_LOOPBACK` | bool | `false` | Allow loopback/localhost subscriber URLs (dev only). |

## Streaming & infra

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `STREAM_HUB_STRATEGY` | `memory`\|`redis` | `memory` | SSE fan-out backend. `redis` for multi-instance. `redis` without `REDIS_URL`, or any other value, silently uses `memory`. |
| `REDIS_URL` | string | `''` | Redis connection for the SSE `redis` strategy and the quota store. The quota store uses Redis only when `TENANT_QUOTAS` also configures at least one tenant. |
| `STREAM_SSE_HEARTBEAT_MS` | number | `15000` | Interval of the server-sent `heartbeat` event on both SSE routes. Keep it below your proxy's idle timeout. |
| `STREAM_SSE_SHUTDOWN_RETRY_MS` | integer (ms), 0–60000 | `1000` | `retry:` hint on the terminal SSE `event: shutdown` (issue #192): how long an `EventSource` waits before reconnecting, by then to a live replica. Strict. |

## Rate limiting (coarse throttle)

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `THROTTLE_TTL_MS` | number | `60000` | Throttle window per `(actorId\|ip)`. |
| `THROTTLE_LIMIT` | number | `200` | Requests per window. `/auth/*` uses a tighter override. |
| `THROTTLE_IPV6_SUBNET_PREFIX` | integer `1`–`128` | `64` | Prefix an unauthenticated IPv6 caller's address is collapsed to before keying. Anything but a decimal integer in range — out-of-range, fractional, or non-numeric (`/48`, `sixty-four`, `0x40`, `1e2`, empty) — fails startup (every environment) — a set value is never silently replaced by `64`. `128` = per-address. |
| `TRUST_PROXY` | hop count \| address list | unset (off) | Express `trust proxy` — which reverse proxies may set the client address via `X-Forwarded-For`. See **Behind a reverse proxy** below. Invalid values (including `true`) fail startup in every environment. |

**Tracker.** An authenticated request (API key or bearer JWT) is keyed on its
principal (`actorId`), whatever address it comes from. An unauthenticated
request — every `@Public()` route, including the 20/min `/auth/challenge` +
`/auth/token` override — is keyed on the client IP, normalized by
`@nestjs/throttler`'s `normalizeIp` (issue #187): IPv4 as-is, IPv4-mapped IPv6
(`::ffff:a.b.c.d`) onto its IPv4, loopback `::1` as-is, any other IPv6 address
onto its `/THROTTLE_IPV6_SUBNET_PREFIX` network, so a host rotating source
addresses inside its own `/64` still lands in one bucket. Values below `48` are
almost always wrong (they merge unrelated sites); lower to `56`/`48` only to
blunt an abuser spreading across a larger allocation. Known coarse cases:
NAT64 (`64:ff9b::/96`) and Teredo clients share one `/64` bucket per
translator/relay.

### Behind a reverse proxy (`TRUST_PROXY`)

The client IP is Express's `req.ip`. With `TRUST_PROXY` unset (the default)
that is the TCP peer, so behind a load balancer / ingress **every
unauthenticated caller shares the proxy's throttle bucket**, and the issuance
ledger's `signer_ip` records the proxy. Set `TRUST_PROXY` to tell Express which
hops are yours; `req.ip` then resolves to the address your outermost trusted
proxy saw, and every reader (`ThrottleByUserGuard`, the ledger) uses it — no
component parses `X-Forwarded-For` itself.

Accepted values (whitespace-trimmed):

| Value | Meaning |
|-------|---------|
| unset, empty, `0`, `false` | Off — Express's default; `X-Forwarded-For` is ignored. |
| `1`–`10` | Hop count: trust that many proxies in front of the CP; `req.ip` is the `X-Forwarded-For` entry that many hops from the right. Set it to the **exact** number of proxies you run. |
| comma-separated list | Trust peers matching any entry: `loopback`, `linklocal`, `uniquelocal` (proxy-addr's named ranges), a plain IPv4/IPv6 address, or a CIDR (`10.0.0.0/8`, `fd00::/8`). Duplicates are ignored; names are case-insensitive. |

Rejected at startup (the process exits before migrations run):

- **`true` / `yes` / `on`.** Trusting *every* hop makes `req.ip` the leftmost
  `X-Forwarded-For` entry — whatever the client wrote. Any caller could then
  pick a fresh throttle bucket per request (and write the ledger's `signer_ip`).
- Hop counts above `10` (a count larger than your real chain does the same as
  `true`), negative or fractional numbers.
- CIDRs wider than `/8` (IPv4) or `/7` (IPv6) — `0.0.0.0/1,128.0.0.0/1` is
  `true` in disguise; `/7` keeps `fc00::/7` usable.
- Any IPv6 entry overlapping IPv4-mapped space `::ffff:0:0/96` (e.g.
  `::ffff:10.0.0.1`, `::ffff:0:0/96`, `::/80`) — Express matches IPv4 peers
  against their mapped form, so these can trust every IPv4 peer. Use the plain
  IPv4 form.
- IPv6 written with an embedded dotted quad (`::1.2.3.4`) — use hex groups.
- Zone ids (`fe80::1%eth0`), netmask notation (`10.0.0.0/255.0.0.0`), empty
  entries (`a,,b`), anything else unrecognised (including `no` / `off`).

A hop count is the simplest correct setting when the chain length is fixed
(one ALB → `1`; CDN → LB → `2`). Prefer an address list when the CP is also
reachable directly: with a hop count, a caller that bypasses the proxy is
itself treated as the trusted hop, so its own `X-Forwarded-For` becomes
`req.ip`.

`uniquelocal` (and a private CIDR such as `172.16.0.0/12`) is a bypass case
too, not only hop counts: Docker Desktop presents every peer reaching a
*published port* as its gateway address (and on Linux, Docker's
`userland-proxy` does the same for host-loopback/hairpin connections, e.g.
`172.17.0.1`) — inside `uniquelocal`. A direct caller is then
"trusted", and its own `X-Forwarded-For` becomes `req.ip`. Trust the proxy's
specific address instead, or do not publish the CP's port.

**Over-trust makes `req.ip` client text.** If the hop count exceeds the real
chain, or a trusted proxy forwards the client's `X-Forwarded-For` verbatim
instead of appending to it, `req.ip` is an untrusted header entry — not
necessarily even an IP address. The issuance ledger is guarded: `signer_ip`
is recorded only when `req.ip` is a valid IP literal of at most 64 characters
(the column width — `isIP` alone would accept an arbitrarily long IPv6 zone
id), otherwise it is left empty, so `/auth/token` never fails on it. Throttle bucketing is not: an
unauthenticated caller can still choose its own bucket per request, so get
the setting right.

**Upgrade note.** `signer_ip` used to be the leftmost `X-Forwarded-For` entry
whenever the header was present. It is now always `req.ip`, so a proxied
deployment that has not set `TRUST_PROXY` records the proxy address from now
on. Existing ledger rows (and their hash chain) are unchanged.

## Receipt audit (RFC-ACDP-0010)

An advisory-locked sweep that cross-checks each ingested `context_published`
event's embedded `registry_receipt`, seals a verdict in `receipt_audits`, and
surfaces it as `trust` on `GET /runs/:runId`. Receipt rules:
[RFC-ACDP-0010](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0010-registry-receipts.md)
(registry side: [RECEIPTS.md](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/RECEIPTS.md));
how the sweep fits the pipeline:
[ARCHITECTURE.md](./ARCHITECTURE.md#transparency-audit--witness-rfc-acdp-0010--0012--0014--0015).

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `RECEIPT_AUDIT_ENABLED` | bool | `false` | Enable the receipt-audit sweep. |
| `RECEIPT_AUDIT_INTERVAL_SECONDS` | number | `300` | Sweep interval. **≥5** when enabled (checked only outside `development`). |
| `RECEIPT_AUDIT_BATCH_SIZE` | number | `50` | Events audited per sweep. **≥1** when enabled (checked only outside `development`). Also caps the retroactive key-revocation re-audit fan-out. |
| `RECEIPT_AUDIT_LOOKBACK_HOURS` | number | `24` | Only events younger than this are picked up. |

## Transparency-log witnessing (RFC-ACDP-0012 / RFC-ACDP-0015)

The checkpoint witness polls `GET /log/checkpoint` on enrolled registries that
advertise `acdp-registry-transparency-log`, verifies each checkpoint against the
last-witnessed head, and alerts on dishonesty signals. Checkpoint and proof rules:
[RFC-ACDP-0012](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0012-transparency-log.md).

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `LOG_WITNESS_ENABLED` | bool | `false` | Enable the checkpoint-witness sweep. Prerequisite for cosigning and quorum consumption below. |
| `LOG_WITNESS_INTERVAL_SECONDS` | number | `300` | Sweep interval. **≥5** when enabled (checked only outside `development`). |
| `LOG_WITNESS_EXCLUDE_AUTHORITIES` | list | `''` | Authorities never witnessed. |

**Witness cosigning.** The CP cosigns each checkpoint that passes verification with
its own dedicated Ed25519 witness key, stores one `log_cosignatures` row per
observation (not per head), and serves them at `GET /log/witness`
([API.md](./API.md)). Cosignature rules:
[RFC-ACDP-0015](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0015-witness-cosigning.md).

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `WITNESS_COSIGNING_ENABLED` | bool | `false` | Enable minting + serving witness cosignatures. Requires `LOG_WITNESS_ENABLED=true` (checked only outside `development`). |
| `WITNESS_ID` | string | `''` | The witness's DID (`did:web:<this-CP-host>` or `did:key`). Required when enabled. |
| `WITNESS_SIGNING_PRIVATE_KEY_PEM` | string | `''` | PEM-encoded **Ed25519** private key the witness cosigns with. Required when enabled. **Dedicated** — never the JWT key. Generate with `openssl genpkey -algorithm ed25519`. |
| `WITNESS_KEY_ID` | string | `''` | assertionMethod key id (DID URL under `WITNESS_ID`). Defaults to `<WITNESS_ID>#witness-key-1`. |
| `WITNESS_COSIGNATURE_KEEP_PER_HEAD` | number | `10` | Retention: cosignatures kept per `(tenant, witness, log, head)` tuple — the newest N-1 plus the single oldest row, which is never purged. Runs only with `DATA_RETENTION_ENABLED=true`. |

When `WITNESS_ID` is a `did:web`, its host **must** match
[`PUBLIC_HOST`](#core-server) so consumers can fetch `/.well-known/did.json` from
this CP: a mismatch fails boot, an unset `PUBLIC_HOST` only warns. `did:key`
witnesses are exempt.

**Witness quorum consumption.** The CP counts the distinct trusted witnesses whose
cosignatures a registry aggregates on `GET /log/checkpoint`, and records
`witnessed_count` / `meets_quorum` (plus the `fresh_*` and
`historical_witnessed_count` sub-counts) on each witnessed head, surfaced on
`GET /registries/:authority/log-witness` and the dashboard `logWitness` tile.
Quorum, freshness and witness-key rules:
[RFC-ACDP-0015](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0015-witness-cosigning.md)
§8–§9.

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `WITNESS_QUORUM_ENABLED` | bool | `false` | Enable quorum consumption. Requires `LOG_WITNESS_ENABLED=true` (checked only outside `development`). |
| `WITNESS_QUORUM_TRUSTED` | list | `''` | Witness DIDs whose cosignatures count; others are verified but ignored. **Must not contain this CP's own `WITNESS_ID`** (boot fails outside `development`). Empty only warns: nothing can ever count. |
| `WITNESS_QUORUM_MIN_WITNESSES` | number | `1` | The N in N-witnessed. **≥1** when enabled (checked only outside `development`). |
| `WITNESS_QUORUM_MAX_AGE_SECONDS` | number\|null | `300` | Freshness window for the `fresh_*` counts. `''` or `0` disables the split (every verified cosignature counts as fresh); a non-numeric value falls back to `300`. |
| `WITNESS_QUORUM_MAX_CLOCK_SKEW_SECONDS` | number | `120` | Hard future-dating tolerance: a cosignature whose `witnessed_at` is further ahead than this never counts. |

**Log-inclusion audit.** The sibling sweep to the checkpoint witness: for stored
receipt-bearing publishes from log-advertising registries it fetches
`/log/proof?ctx_id=`, verifies inclusion, and seals one verdict per event
(`included` | `invalid_proof` | `not_logged` | `no_log` | `error`) in
`log_inclusion_audits`.

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `LOG_INCLUSION_AUDIT_ENABLED` | bool | `false` | Enable the inclusion-audit sweep. |
| `LOG_INCLUSION_AUDIT_INTERVAL_SECONDS` | number | `300` | Sweep interval. **≥5** when enabled (checked only outside `development`). |
| `LOG_INCLUSION_AUDIT_BATCH_SIZE` | number | `50` | Events audited per sweep. **≥1** when enabled (checked only outside `development`). |
| `LOG_INCLUSION_AUDIT_LOOKBACK_HOURS` | number | `24` | Only events younger than this are picked up. |

## Producer key-revocation (RFC-ACDP-0014)

When enabled, a sweep fetches and verifies `key-revocation` contexts into
`key_revocations`, and the receipt-audit sweep classifies each audited event
against them (`trust.revoked` on `GET /runs/:runId`, dashboard `keyRevocation`
tile). Already-sealed verdicts are amended retroactively when a later revocation
reaches back over them — no extra knob. Revocation format, trust classes and
consumer semantics:
[RFC-ACDP-0014](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0014-key-revocation.md);
CP mechanics:
[ARCHITECTURE.md](./ARCHITECTURE.md#transparency-audit--witness-rfc-acdp-0010--0012--0014--0015).

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `KEY_REVOCATION_CHECK_ENABLED` | bool | `false` | Enable revocation verification + classification. Requires `RECEIPT_AUDIT_ENABLED=true` — **a production-only check**: under `NODE_ENV=development` the combination is not rejected at boot. |
| `KEY_REVOCATION_ATTESTED_SCOPE` | `same_registry`\|`global`\|`off` | `same_registry` | How far a registry-attested (not producer-signed) revocation reaches: only events from the attesting registry, every registry, or ignored. Case-sensitive; an unknown value fails boot only outside `development`. |
| `KEY_REVOCATION_IGNORE_FINGERPRINTS` | list | `''` | Operator override: fingerprints listed here never disarm producer trust, even if a revocation names them. Applied at classification time. |
| `KEY_REVOCATION_LOOKBACK_HOURS` | number | `720` | Candidate window of the revocation-discovery sweep (30 days, deliberately longer than `RECEIPT_AUDIT_LOOKBACK_HOURS` so an outage cannot lose an irreversible revocation). **≥1** when enabled (checked only outside `development`). |
| `KEY_REVOCATION_LINEAGE_CURSOR_TTL_HOURS` | number | `1` | Re-walk cadence for the lineage walk's "fully walked" marker; a cadence knob, not a correctness gate. `0` = always re-walk. **≥0** when enabled (checked only outside `development`). |

## Data retention

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `DATA_RETENTION_ENABLED` | bool | `false` | Enable periodic purge of aged rows. |
| `DATA_RETENTION_TTL_DAYS` | number | `30` | Age threshold. **≥1** when enabled (checked only outside `development`). |
| `DATA_RETENTION_INTERVAL_HOURS` | number | `24` | Purge-job interval. |

## Routing

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `BANDIT_EXPLORATION_FRACTION` | number | `0.05` | Fraction of traffic using uniform exploration vs Thompson sampling. |

## Observability

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `LOG_LEVEL` | string | `info` | pino level: `trace`\|`debug`\|`info`\|`warn`\|`error`\|`fatal`\|`silent`. |
| `OTEL_ENABLED` | bool | `false` | Start the OpenTelemetry Node SDK with auto-instrumentations. |
| `OTEL_SERVICE_NAME` | string | `acdp-control-plane` | Span/metric service name. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | string | `''` | OTLP endpoint. Empty = the CP configures no exporter of its own, and the SDK falls back to its built-in default: OTLP over `http/protobuf` to `http://localhost:4318/v1/traces`. Without a collector there, spans are dropped. The SDK also honours the other standard `OTEL_*` variables (`OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL`, …) directly; the CP does not read them. |
| `SWAGGER_ENABLED` | bool | on when `NODE_ENV=development`, else off | Serve Swagger UI. |
| `SWAGGER_PATH` | string | `docs` | Swagger UI path. |

## Misc

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `PLAYGROUND_URL` | string | `''` | Playground backend for run-completion notifications; empty disables. |

## Startup validation

Checks fall into two tiers. `AppConfigService.validate()` runs the first block
in every environment, then **returns early when `NODE_ENV=development`**, so
everything in the second tier is skipped in development. Integration tests run
with `NODE_ENV=development`, so they never exercise the second tier.

### Every environment

Refuses to start on:

- An invalid `POLICY_BACKEND`, `JWT_SIGNING_ALG` or `AUTH_PERSISTENCE`, or a
  rejected `TRUST_PROXY` (these are parsed when `AppConfigService` is built, so
  the process exits before migrations run).
- An unknown or duplicate `DOMAIN_PACKS` name.
- Tenant bindings (`TENANT_AGENTS`, or a tenant-bound `TENANT_API_KEYS` entry)
  **without** `AUTH_REQUIRE_TENANT=true`.
- `TENANT_HEADER_TRUST` other than `none` / `any_peer`.
- `THROTTLE_IPV6_SUBNET_PREFIX` not an integer in [1, 128].
- `SHUTDOWN_TIMEOUT_MS` not an integer in [1000, 2147483647],
  `SHUTDOWN_RETRY_AFTER_SECONDS` not in [1, 300], `STREAM_SSE_SHUTDOWN_RETRY_MS`
  not in [0, 60000], or `SHUTDOWN_DRAIN_DELAY_MS` not in [0, 2147483647]
  (issue #192).
- `READINESS_DB_TIMEOUT_MS` not an integer in [50, 30000], `READINESS_CACHE_MS`
  not in [0, 60000], or `DB_POOL_CONNECTION_TIMEOUT` not in [1, 2147483647]
  (issue #210).

These strict knobs never fall back to their default: a set value that is not a
plain decimal integer (`5s`, `1.5`, `0x40`, empty) fails.

Starts, but **warns** on:

- `TENANT_HEADER_TRUST=any_peer` with a `HOST` other than `127.0.0.1`, `::1` or
  `localhost`.
- `SHUTDOWN_DRAIN_DELAY_MS + SHUTDOWN_TIMEOUT_MS` above 25000 ms (check the
  platform's termination grace period).
- `READINESS_DB_TIMEOUT_MS >= DB_POOL_CONNECTION_TIMEOUT` (a slow connect is
  then reported as `reason: "error"`, not `"timeout"`).

### Production only (`NODE_ENV` ≠ `development`)

Refuses to start on:

- Empty `AUTH_API_KEYS`.
- Empty `WEBHOOK_SECRET` (inbound webhook HMAC verification would otherwise be
  disabled).
- `DB_POOL_MAX < 2`.
- `DATA_RETENTION_ENABLED=true` with `DATA_RETENTION_TTL_DAYS < 1`.
- `RECEIPT_AUDIT_ENABLED=true` with `RECEIPT_AUDIT_INTERVAL_SECONDS < 5` or
  `RECEIPT_AUDIT_BATCH_SIZE < 1`.
- `LOG_WITNESS_ENABLED=true` with `LOG_WITNESS_INTERVAL_SECONDS < 5`.
- `LOG_INCLUSION_AUDIT_ENABLED=true` with `LOG_INCLUSION_AUDIT_INTERVAL_SECONDS < 5`
  or `LOG_INCLUSION_AUDIT_BATCH_SIZE < 1`.
- `WITNESS_COSIGNING_ENABLED=true` without `WITNESS_ID`, without
  `WITNESS_SIGNING_PRIVATE_KEY_PEM`, or without `LOG_WITNESS_ENABLED=true`.
- `WITNESS_QUORUM_ENABLED=true` without `LOG_WITNESS_ENABLED=true`, with
  `WITNESS_QUORUM_MIN_WITNESSES < 1`, or with this CP's own `WITNESS_ID` listed in
  `WITNESS_QUORUM_TRUSTED` (a consume-only deployment with no `WITNESS_ID` is
  unaffected by the last check).
- `KEY_REVOCATION_CHECK_ENABLED=true` without `RECEIPT_AUDIT_ENABLED=true`, with
  `KEY_REVOCATION_ATTESTED_SCOPE` not in {`same_registry`,`global`,`off`}, with
  `KEY_REVOCATION_LOOKBACK_HOURS < 1`, or with
  `KEY_REVOCATION_LINEAGE_CURSOR_TTL_HOURS < 0` (`0` is legal).
- `TOKEN_ISSUANCE_ENABLED=true` with: `HS256` and a `JWT_SECRET` under 32 bytes;
  `EdDSA` and an empty `JWT_PRIVATE_KEY_PEM`; `JWT_TTL_SECONDS < 60`; or
  `CHALLENGE_TTL_SECONDS < 30`.

Starts, but **warns** on:

- `STREAM_HUB_STRATEGY=memory` (SSE does not sync across replicas).
- `OTEL_ENABLED=true` with an empty `OTEL_EXPORTER_OTLP_ENDPOINT`. The warning
  says traces are discarded; in fact the SDK exports to its default
  `http://localhost:4318` (see [Observability](#observability)), so they are
  lost only if no collector listens there.
- `WITNESS_COSIGNING_ENABLED=true` with `DATA_RETENTION_ENABLED=false`
  (`log_cosignatures` gains a row on every observation and grows unbounded).
- `WITNESS_QUORUM_ENABLED=true` with an empty `WITNESS_QUORUM_TRUSTED` (no
  cosignature can ever count).
- `REVOCATION_FEEDS` set with `TOKEN_ISSUANCE_ENABLED=false` (the poller does
  not run).
- `TOKEN_ISSUANCE_ENABLED=true` with `AUTH_PERSISTENCE=memory` (challenge and
  revocation state is not shared across replicas).

### Other boot-time failures

Not part of `validate()`, but they also stop the process in every environment:

- The `acdp` SDK binding verifies Ed25519 non-strictly (the `sig-004` self-test
  that runs first in `bootstrap()`; see
  [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#boot-fails-the-loaded-acdp-sdk-binding-verifies-ed25519-non-strictly--sig-004)).
- With `TOKEN_ISSUANCE_ENABLED=true`: a malformed `TRUSTED_ISSUERS` entry, or
  one whose `iss` equals `JWT_AUTHORITY`.
- With `WITNESS_COSIGNING_ENABLED=true`: `WitnessSigningService` rejects an
  empty or malformed `WITNESS_ID`, a missing, unparseable or non-Ed25519
  `WITNESS_SIGNING_PRIVATE_KEY_PEM`, a `WITNESS_KEY_ID` not under `WITNESS_ID`,
  or a `did:web` witness whose host does not match a set `PUBLIC_HOST`. So
  cosigning without a witness DID or key fails in development too; only the
  `LOG_WITNESS_ENABLED` prerequisite is production-only.
