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

Defaults below are the code defaults. Several variables are **fail-fast in
production** (`NODE_ENV !== 'development'`) — see [Startup validation](#startup-validation).

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
| `NODE_ENV` | string | `development` | `development` relaxes fail-fast checks. |
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
| `DB_POOL_MAX` | number | `20` | Max pool connections per replica. **Must be ≥ 2.** |
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
| `AUTH_PERSISTENCE` | `memory`\|`postgres` | `memory` | Backend for challenges/revocations/ledger. `postgres` required for multi-instance. |
| `AUTH_SWEEP_INTERVAL_SECONDS` | number | `300` | Expired-state GC interval; `≤0` disables. |
| `TOKEN_ISSUANCE_ENABLED` | bool | `false` | Enable `/auth/challenge` + `/auth/token` + JWT verify path. |
| `JWT_SECRET` | string | `''` | HS256 signing secret. **≥32 bytes** when issuance + HS256. |
| `JWT_SIGNING_ALG` | `HS256`\|`EdDSA` | `HS256` | Issuance algorithm. |
| `JWT_PRIVATE_KEY_PEM` | string (PEM) | `''` | Ed25519 PKCS8 private key. **Required** when issuance + EdDSA. |
| `JWT_KID` | string | `''` | Override `kid`; else derived from key fingerprint. |
| `JWT_AUTHORITY` | string | `control-plane.local` | `iss` claim + challenge signing input. |
| `JWT_AUDIENCE` | string | = `JWT_AUTHORITY` | `aud` claim bound + required on local verify. |
| `JWT_TTL_SECONDS` | number | `3600` | Issued-token TTL. **≥60** when issuance. |
| `CHALLENGE_TTL_SECONDS` | number | `300` | Challenge-nonce TTL. **≥30** when issuance. |
| `CONTROL_PLANE_PINNED_KEYS` | CSV | `''` | `did=base64[:alg][:from..until]`. Verification + emergency revocation. |
| `TRUSTED_ISSUERS` | CSV | `''` | Federated peers. `iss\|alg\|material\|audience[\|scope[\|flags]]`. `audience` required. `flags` (6th field, whitespace-separated, closed set; today only `read_only`) — to set a flag without a scope leave the scope empty: `iss\|HS256\|<secret>\|<aud>\|\|read_only`. `read_only` limits that issuer's tokens to GET/HEAD/OPTIONS (403 `ISSUER_READ_ONLY` otherwise; `POST /auth/introspect` exempt). An entry whose `iss` equals `JWT_AUTHORITY` fails startup (it would be shadowed by the local issuer). Unknown/duplicate flags, a flag name in the scope slot, or >6 fields fail startup. **Rollback hazard:** a build older than this field silently ignores the 6th field, so rolling back drops `read_only`. `scope` (optional) is checked against the token's `scope`/`scopes`/`scp` claims; do not set it for ACDP registry peers (they mint no scope claim). |
| `REVOCATION_FEEDS` | CSV | `''` | Peer feeds to poll. `issuer\|url\|admin_token[\|poll_seconds]`. |

## Tenancy

See [TENANCY.md](./TENANCY.md).

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `TENANT_API_KEYS` | CSV | `''` | `tenantId:key,…,bareKey`. Bare keys → `default`. |
| `TENANT_AGENTS` | CSV | `''` | `tenantId:agent_did,…`. Stamps JWT `tenant` claim. |
| `TENANT_QUOTAS` | string | `''` | Per-tenant quotas. See [POLICY.md](./POLICY.md#config--tenant_quotas). |

## Policy

See [POLICY.md](./POLICY.md).

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `POLICY_BACKEND` | `static`\|`opa` | `static` | Decision backend. |
| `OPA_URL` | string | `http://localhost:8181` | OPA sidecar base URL. |
| `OPA_PACKAGE_PATH` | string | `acdp/policy/v1` | OPA package path. |
| `OPA_TIMEOUT_MS` | number | `1500` | Per-query timeout. |
| `OPA_FAIL_OPEN` | bool | `false` | On OPA error, allow instead of deny. |

## Ingest

See [INGEST.md](./INGEST.md).

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `WEBHOOK_SECRET` | string | `''` | Global HMAC secret for inbound webhooks. Empty = verification skipped (dev only — fails startup in production). |
| `INGEST_REQUIRE_ENROLLMENT` | bool | `false` | Accept only enrolled authorities. |
| `INGEST_STRICT_TENANT` | bool | `false` | Unenrolled authority may not assert non-`default` tenant. |
| `INGEST_MAX_BODY_BYTES` | number | `1048576` | Raw body cap (1 MiB). |
| `INGEST_MAX_JSON_DEPTH` | number | `64` | JSON nesting-depth cap. |
| `DOMAIN_PACKS` | CSV | `''` | Active domain packs (e.g. `finance`); gates custom `context_type`s. |

## Outbound webhooks

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `WEBHOOK_RETRY_INTERVAL_MS` | number | `300000` | Outbox retry-sweep interval; `≤0` disables. |
| `WEBHOOK_SSRF_ALLOW_HTTP` | bool | `false` | Allow non-HTTPS subscriber URLs (dev only). |
| `WEBHOOK_SSRF_ALLOW_LOOPBACK` | bool | `false` | Allow loopback/localhost subscriber URLs (dev only). |

## Streaming & infra

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `STREAM_HUB_STRATEGY` | `memory`\|`redis` | `memory` | SSE fan-out backend. `redis` for multi-instance. |
| `REDIS_URL` | string | `''` | Redis connection (SSE redis strategy + Redis quota store). |
| `STREAM_SSE_HEARTBEAT_MS` | number | `15000` | SSE heartbeat interval. |
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

An advisory-locked sweep that makes the CP an independent second observer of
registry receipts: it picks unaudited `context_published` events, cross-checks
each embedded `registry_receipt`, records a verdict in `receipt_audits`, and
surfaces it as the `trust` member on `GET /runs/:runId`. The receipt format and
the verification procedure it runs are normative in
[RFC-ACDP-0010](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/main/rfcs/RFC-ACDP-0010-registry-receipts.md)
(registry-side runbook:
[acdp-registry-rs/docs/RECEIPTS.md](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/RECEIPTS.md)) —
see [ARCHITECTURE.md](./ARCHITECTURE.md#transparency-audit--witness-rfc-acdp-0010--0012--0015)
for how the sweep fits the pipeline.

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `RECEIPT_AUDIT_ENABLED` | bool | `false` | Enable the receipt-audit sweep. |
| `RECEIPT_AUDIT_INTERVAL_SECONDS` | number | `300` | Sweep interval. **≥5** when enabled. |
| `RECEIPT_AUDIT_BATCH_SIZE` | number | `50` | Events audited per sweep. **≥1** when enabled. |
| `RECEIPT_AUDIT_LOOKBACK_HOURS` | number | `24` | Only events younger than this are picked up. |

## Transparency-log witnessing (RFC-ACDP-0012 / RFC-ACDP-0015)

The checkpoint witness polls `GET /log/checkpoint` on enrolled registries advertising
`acdp-registry-transparency-log`, verifies each checkpoint's signature and its
consistency against the last-witnessed head, and alerts on any dishonesty signal
(root rewrite, split view, tree-size regression, log reset). The checkpoint/proof
formats and checks are normative in
[RFC-ACDP-0012](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/main/rfcs/RFC-ACDP-0012-transparency-log.md)
and [RFC-ACDP-0015](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/main/rfcs/RFC-ACDP-0015-witness-cosigning.md);
the knobs below are what this service exposes.

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `LOG_WITNESS_ENABLED` | bool | `false` | Enable the checkpoint-witness sweep. |
| `LOG_WITNESS_INTERVAL_SECONDS` | number | `300` | Sweep interval. **≥5** when enabled. |
| `LOG_WITNESS_EXCLUDE_AUTHORITIES` | list | `''` | Authorities never witnessed. |

**Witness cosigning (RFC-ACDP-0015).** When enabled, a checkpoint that passes the §7
obligation (signature valid **and** consistency from the retained head) is **cosigned**:
the witness mints a signed `acdp-log-cosignature` over the observed tuple with its own
Ed25519 `assertionMethod` key and serves it at `GET /log/witness`. Riding the checkpoint
witness, it requires `LOG_WITNESS_ENABLED=true`. A checkpoint that **fails** the
obligation is never cosigned. Per §4/§8.1/§15 the witness re-mints a **fresh**
cosignature on **every** observation — including at an unchanged `tree_size`, as a
liveness signal — so `log_cosignatures` gains one row per sweep, not per head; only a
genuine same-millisecond re-mint dedups.

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `WITNESS_COSIGNING_ENABLED` | bool | `false` | Enable minting + serving witness cosignatures. |
| `WITNESS_ID` | string | `''` | The witness's DID (`did:web:<this-CP-host>` or `did:key`). Required when enabled. |
| `WITNESS_SIGNING_PRIVATE_KEY_PEM` | string | `''` | PEM-encoded **Ed25519** private key the witness cosigns with. Required when enabled. **Dedicated** — never the JWT IdP key (§5/§15). |
| `WITNESS_KEY_ID` | string | `''` | assertionMethod key id (DID URL under `WITNESS_ID`). Defaults to `<WITNESS_ID>#witness-key-1`. |
| `WITNESS_COSIGNATURE_KEEP_PER_HEAD` | number | `10` | Retention: cosignatures kept per `(tenant, witness, log, head)` tuple — newest N-1 plus the single OLDEST row unconditionally (§8.1: the oldest surviving cosignature for a head is the strongest anti-backdating evidence, never purged). Requires `DATA_RETENTION_ENABLED=true` to actually run (see Warns below). |

Generate the witness key with `openssl genpkey -algorithm ed25519`. When `WITNESS_ID`
is a `did:web`, its host **must** match [`PUBLIC_HOST`](#core-server) so consumers can
dereference `/.well-known/did.json` on this CP — the binding is asserted at boot
(RFC-ACDP-0015 §9): a mismatch is fatal, and an unset `PUBLIC_HOST` only warns. `did:key`
witnesses are exempt (self-describing).

`GET /log/witness` defaults to the **collapsed** view — the latest cosignature per
distinct `(log_id, tree_size, root_hash)` head — since B1's per-observation minting would
otherwise crowd a fixed-size page with liveness re-observations of the same head. Pass
`?all=true` for the full per-observation series (the §8.1 anti-backdating use: an older
surviving cosignature for a head is *stronger* evidence it existed early).

**Witness quorum consumption (RFC-ACDP-0015 §8).** The mirror of cosigning: instead of
minting, evaluate the **N-witnessed quorum** over the cosignatures a registry *aggregates*
and serves on `GET /log/checkpoint` (the top-level `witness_signatures` sibling, §6.1).
Each is verified against its witness's **own** key, and DISTINCT trusted witnesses over
the checkpoint's exact `(log_id, tree_size, root_hash)` tuple are counted — never the
CP's own local mint. **§9 witness key resolution** branches by DID method: a `did:key`
witness is self-describing (the multibase-encoded key IS the identity), so it resolves
LOCALLY with no DID document fetch at all; a `did:web` witness's own key resolves through
the SAME RFC-ACDP-0010 §9 lifecycle tolerance the registry's receipt key already gets — a
key rotated out of `assertionMethod` but retained in `verificationMethod` still verifies,
as **historical** (`historical_witnessed_count`, a separate sub-count, never folded into
`witnessed_count`/`meets_quorum`). The count + `meets_quorum` are recorded on the
witnessed head (surfaced on `GET /registries/:authority/log-witness` per checkpoint and on
the dashboard `logWitness.headsMeetingQuorum` tile). Rides the checkpoint witness, so it
requires `LOG_WITNESS_ENABLED=true`.

§8.1 layers a **freshness split** on top: `fresh_witnessed_count` / `meets_fresh_quorum`
count only cosignatures also within `WITNESS_QUORUM_MAX_AGE_SECONDS`. A stale-but-valid
cosignature still counts toward `witnessed_count`/`meets_quorum` — staleness is never a
failure (§8.1's anti-backdating principle) — it is simply excluded from the fresh count.
This is a **soft** overlay, distinct from the **hard** §8 step 5 future-dating gate
(`WITNESS_QUORUM_MAX_CLOCK_SKEW_SECONDS`): a cosignature failing that check never counts
at all, same category as an invalid signature.

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `WITNESS_QUORUM_ENABLED` | bool | `false` | Enable quorum consumption over aggregated cosignatures. |
| `WITNESS_QUORUM_TRUSTED` | list | `''` | Witness DIDs whose cosignatures count; others are verified-but-ignored. **Must not contain this CP's own `WITNESS_ID`** — startup refuses to start if it does (a self-attestation would defeat the independent-vantage point of a quorum). |
| `WITNESS_QUORUM_MIN_WITNESSES` | number | `1` | The N in N-witnessed. **≥1** when enabled. |
| `WITNESS_QUORUM_MAX_AGE_SECONDS` | number\|null | `300` | §8.1 freshness window. Set to `''` or `0` to **disable the split** — every verified cosignature then also counts as fresh. |
| `WITNESS_QUORUM_MAX_CLOCK_SKEW_SECONDS` | number | `120` | §8 step 5 hard future-dating tolerance — a cosignature claiming a `witnessed_at` further than this into the future is rejected outright. |

**Log-inclusion audit ([RFC-ACDP-0012](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/main/rfcs/RFC-ACDP-0012-transparency-log.md)).**
The sibling sweep to the checkpoint witness: for stored receipt-bearing publishes
from log-advertising registries it proves each context is actually in the
registry's log (fetching `/log/proof?ctx_id=`) and cross-binds against witnessed
heads. Verdicts (`included` | `invalid_proof` | `not_logged` | `no_log` | `error`)
seal once per event in `log_inclusion_audits`.

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `LOG_INCLUSION_AUDIT_ENABLED` | bool | `false` | Enable the inclusion-audit sweep. |
| `LOG_INCLUSION_AUDIT_INTERVAL_SECONDS` | number | `300` | Sweep interval. **≥5** when enabled. |
| `LOG_INCLUSION_AUDIT_BATCH_SIZE` | number | `50` | Events audited per sweep. **≥1** when enabled. |
| `LOG_INCLUSION_AUDIT_LOOKBACK_HOURS` | number | `24` | Only events younger than this are picked up. |

## Producer key-revocation (RFC-ACDP-0014)

When enabled, the receipt-audit sweep additionally classifies each audited event
under any applicable `key-revocation` context published for the same producer key
(§7 consumer semantics): a receipt-attested publish before the revocation's
`compromised_since` boundary is historically authorized; at or after it — or
unverifiable — fails closed, unconditionally. Requires `RECEIPT_AUDIT_ENABLED=true`,
because the classification reuses the same receipt-attested `created_at` that sweep
already establishes. The revocation format and consumer semantics are normative in
[RFC-ACDP-0014](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/main/rfcs/RFC-ACDP-0014-key-revocation.md).

Two trust classes are reported distinguishably, never collapsed (§7): producer-signed
(strong — needs no registry trust at all) and registry-attested (weaker — the
revocation's `publisher` must pass the §6 registry-binding check against the serving
registry's own DID and its advertised `capabilities.registry_did`, both via the
canonical `authorityToDidWeb` encoder — see `src/audit/revocation-binding.ts`).

Classification also runs **retroactively**: a revocation recorded after an event was
already audited amends that event's stored verdict in place on a later sweep, rather
than leaving it permanently reporting the pre-revocation result — no separate env var,
it rides the same `KEY_REVOCATION_CHECK_ENABLED` and reuses `RECEIPT_AUDIT_BATCH_SIZE`
as its fan-out cap. See `docs/ARCHITECTURE.md`'s "Retroactive re-audit" section.

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `KEY_REVOCATION_CHECK_ENABLED` | bool | `false` | Enable §7 revocation classification. Requires `RECEIPT_AUDIT_ENABLED=true`. |
| `KEY_REVOCATION_ATTESTED_SCOPE` | `same_registry`\|`global`\|`off` | `same_registry` | How far a registry-attested (not producer-signed) revocation reaches: only events from the attesting registry, every registry, or ignored entirely. |
| `KEY_REVOCATION_IGNORE_FINGERPRINTS` | list | `''` | §13 operator override: fingerprints listed here never disarm producer trust, even if named by a revocation. |
| `KEY_REVOCATION_LOOKBACK_HOURS` | number | `720` | How far back the revocation-discovery sweep looks. **Not** the same default as `RECEIPT_AUDIT_LOOKBACK_HOURS` (24h) — revocations are irreversible (§4), so a longer window avoids a registry outage silently and permanently losing one. **≥1** when enabled. |
| `KEY_REVOCATION_LINEAGE_CURSOR_TTL_HOURS` | number | `1` | Freshness window for the §7 lineage walk's "this lineage was fully walked" marker. A re-walk **cadence** knob, not a correctness gate: a lineage with zero recorded facts is re-walked every pass regardless of cursor freshness, so a wide window can only delay re-discovery of a *superseding* member of an already-fact-bearing lineage. The `1` default matches the DID resolver's own document-cache duration. `0` ignores cursors entirely (always re-walk); **≥0** when enabled (a negative value would mark every cursor fresh forever). |

## Data retention

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `DATA_RETENTION_ENABLED` | bool | `false` | Enable periodic purge of aged rows. |
| `DATA_RETENTION_TTL_DAYS` | number | `30` | Age threshold. **≥1** when enabled. |
| `DATA_RETENTION_INTERVAL_HOURS` | number | `24` | Purge-job interval. |

## Routing

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `BANDIT_EXPLORATION_FRACTION` | number | `0.05` | Fraction of traffic using uniform exploration vs Thompson sampling. |

## Observability

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `LOG_LEVEL` | string | `info` | `debug`\|`info`\|`warn`\|`error`. |
| `OTEL_ENABLED` | bool | `false` | Enable OpenTelemetry SDK. |
| `OTEL_SERVICE_NAME` | string | `acdp-control-plane` | Span/metric service name. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | string | `''` | OTLP endpoint; empty discards traces. |
| `SWAGGER_ENABLED` | bool | dev: on / prod: off | Serve Swagger UI. |
| `SWAGGER_PATH` | string | `docs` | Swagger UI path. |

## Misc

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `PLAYGROUND_URL` | string | `''` | Playground backend for run-completion notifications; empty disables. |

## Startup validation

`AppConfigService.validate()` runs at boot. **Throws** (refuses to start) on:

- Tenant bindings configured (`TENANT_AGENTS` or tenant-bound `TENANT_API_KEYS`)
  **without** `AUTH_REQUIRE_TENANT=true`.
- Production with empty `AUTH_API_KEYS`.
- Production with empty `WEBHOOK_SECRET` (inbound webhook HMAC verification would
  otherwise be silently disabled — see `src/ingest/hmac.ts`).
- `DB_POOL_MAX < 2`.
- `DB_POOL_CONNECTION_TIMEOUT` not an integer in 1–2147483647 (`0`, `-1`, `1.5`, `5s`, empty) — in every
  environment (issue #210). Strict parse: a non-integer value no longer falls back to `5000`.
- `READINESS_DB_TIMEOUT_MS` not an integer in [50, 30000], or `READINESS_CACHE_MS` not an
  integer in [0, 60000] (e.g. `abc`, `-1`) — in every environment (issue #210).
  `READINESS_DB_TIMEOUT_MS >= DB_POOL_CONNECTION_TIMEOUT` only **warns**.
- `SHUTDOWN_TIMEOUT_MS` not an integer in 1000–2147483647, `SHUTDOWN_RETRY_AFTER_SECONDS` not an
  integer in [1, 300], `STREAM_SSE_SHUTDOWN_RETRY_MS` not an integer in [0, 60000], or
  `SHUTDOWN_DRAIN_DELAY_MS` not an integer in [0, 2147483647] (e.g. `-1`, `abc`)
  — in every environment (issue #192). `SHUTDOWN_DRAIN_DELAY_MS + SHUTDOWN_TIMEOUT_MS`
  above 25000 only **warns**: check your termination grace period.
- `DATA_RETENTION_ENABLED=true` with `DATA_RETENTION_TTL_DAYS < 1`.
- `POLICY_BACKEND` not in {`static`,`opa`}; `JWT_SIGNING_ALG` not in {`HS256`,`EdDSA`}.
- Issuance + `HS256` with `JWT_SECRET` < 32 bytes.
- Issuance + `EdDSA` with empty `JWT_PRIVATE_KEY_PEM`.
- Issuance with `JWT_TTL_SECONDS < 60` or `CHALLENGE_TTL_SECONDS < 30`.
- `LOG_WITNESS_ENABLED=true` with `LOG_WITNESS_INTERVAL_SECONDS < 5`.
- `RECEIPT_AUDIT_ENABLED=true` with `RECEIPT_AUDIT_INTERVAL_SECONDS < 5` or
  `RECEIPT_AUDIT_BATCH_SIZE < 1`.
- `LOG_INCLUSION_AUDIT_ENABLED=true` with `LOG_INCLUSION_AUDIT_INTERVAL_SECONDS < 5`
  or `LOG_INCLUSION_AUDIT_BATCH_SIZE < 1`.
- `WITNESS_COSIGNING_ENABLED=true` without `WITNESS_ID`, without
  `WITNESS_SIGNING_PRIVATE_KEY_PEM`, or without `LOG_WITNESS_ENABLED=true`.
  (`WitnessSigningService` additionally rejects a non-Ed25519 key, a malformed
  witness DID, or a `WITNESS_KEY_ID` not under `WITNESS_ID` — in every environment.)
- `WITNESS_QUORUM_ENABLED=true` with this CP's own `WITNESS_ID` present in
  `WITNESS_QUORUM_TRUSTED` (self-cosignature would count toward its own quorum).
  A consume-only deployment (`WITNESS_COSIGNING_ENABLED=false`, `WITNESS_ID`
  unset) is unaffected by this check.
- `KEY_REVOCATION_CHECK_ENABLED=true` without `RECEIPT_AUDIT_ENABLED=true`; with
  `KEY_REVOCATION_ATTESTED_SCOPE` not in {`same_registry`,`global`,`off`}; or with
  `KEY_REVOCATION_LOOKBACK_HOURS < 1`; or with
  `KEY_REVOCATION_LINEAGE_CURSOR_TTL_HOURS < 0` (`0` itself is legal — it opts out
  of cursor-based walk suppression).

**Warns** (starts, but flags a risk) on, in production:

- `STREAM_HUB_STRATEGY=memory` (SSE won't sync across replicas).
- `OTEL_ENABLED=true` with empty `OTEL_EXPORTER_OTLP_ENDPOINT` (traces discarded).
- `REVOCATION_FEEDS` set with `TOKEN_ISSUANCE_ENABLED=false` (poller won't run).
- `TOKEN_ISSUANCE_ENABLED=true` with `AUTH_PERSISTENCE=memory` (state not shared).
- `WITNESS_QUORUM_ENABLED=true` with empty `WITNESS_QUORUM_TRUSTED` (no
  cosignature can ever count toward quorum).
- `WITNESS_COSIGNING_ENABLED=true` with `DATA_RETENTION_ENABLED=false` (B1 mints a
  fresh `log_cosignatures` row on every observation sweep — without the retention
  purge running, the table grows unbounded).
