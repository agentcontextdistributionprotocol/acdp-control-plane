# Configuration Reference

Every environment variable the control plane reads is parsed in **one place** —
`AppConfigService` (`src/config/app-config.service.ts`). The only files allowed to
read `process.env` directly are `main.ts`, `db/migrate.ts`, `telemetry/telemetry.ts`,
the `auth/{pinned-keys.service,pinned-keys-admin.controller,auth.module}.ts` set,
and `domain-packs/domain-packs.module.ts`. Start from `.env.example`.

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
| `CORS_ORIGIN` | string | `http://localhost:3000` | Allowed CORS origin. |

## Database

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `DATABASE_URL` | string | `postgres://postgres:postgres@localhost:5432/acdp_control_plane` | Postgres connection string. |
| `DB_POOL_MAX` | number | `20` | Max pool connections per replica. **Must be ≥ 2.** |
| `DB_POOL_IDLE_TIMEOUT` | number (ms) | `30000` | Idle connection timeout. |
| `DB_POOL_CONNECTION_TIMEOUT` | number (ms) | `5000` | Connection-acquisition timeout. |

## Authentication & issuance

See [AUTH.md](./AUTH.md).

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `AUTH_API_KEYS` | CSV | `''` | Bearer API keys. Empty = auth bypassed (dev only). |
| `AUTH_ADMIN_API_KEYS` | CSV | `''` | Subset allowed admin ops (revoke any jti, reload pinned keys, read revocation feed, enroll registry, routing stats). |
| `AUTH_REQUIRE_TENANT` | bool | `false` | Strict-tenant default-deny. See [TENANCY.md](./TENANCY.md). |
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
| `TRUSTED_ISSUERS` | CSV | `''` | Federated peers. `iss\|alg\|material\|audience[\|scope]`. `audience` required. |
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
| `WEBHOOK_SECRET` | string | `''` | Global HMAC secret for inbound webhooks. Empty = verification skipped (dev). |
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

## Rate limiting (coarse throttle)

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `THROTTLE_TTL_MS` | number | `60000` | Throttle window per `(actorId\|ip)`. |
| `THROTTLE_LIMIT` | number | `200` | Requests per window. `/auth/*` uses a tighter override. |

## Transparency-log witnessing (RFC-ACDP-0012 / RFC-ACDP-0015)

The checkpoint witness polls `GET /log/checkpoint` on enrolled registries advertising
`acdp-registry-transparency-log`, verifies each checkpoint's signature and its
consistency against the last-witnessed head, and alerts on any dishonesty signal
(root rewrite, split view, tree-size regression, log reset).

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
obligation is never cosigned.

| Var | Type | Default | Meaning |
|-----|------|---------|---------|
| `WITNESS_COSIGNING_ENABLED` | bool | `false` | Enable minting + serving witness cosignatures. |
| `WITNESS_ID` | string | `''` | The witness's DID (`did:web:<this-CP-host>` or `did:key`). Required when enabled. |
| `WITNESS_SIGNING_PRIVATE_KEY_PEM` | string | `''` | PEM-encoded **Ed25519** private key the witness cosigns with. Required when enabled. **Dedicated** — never the JWT IdP key (§5/§15). |
| `WITNESS_KEY_ID` | string | `''` | assertionMethod key id (DID URL under `WITNESS_ID`). Defaults to `<WITNESS_ID>#witness-key-1`. |

Generate the witness key with `openssl genpkey -algorithm ed25519`. `WITNESS_ID`'s host
must resolve to this CP so consumers can dereference `/.well-known/did.json`.

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
- `DB_POOL_MAX < 2`.
- `DATA_RETENTION_ENABLED=true` with `DATA_RETENTION_TTL_DAYS < 1`.
- `POLICY_BACKEND` not in {`static`,`opa`}; `JWT_SIGNING_ALG` not in {`HS256`,`EdDSA`}.
- Issuance + `HS256` with `JWT_SECRET` < 32 bytes.
- Issuance + `EdDSA` with empty `JWT_PRIVATE_KEY_PEM`.
- Issuance with `JWT_TTL_SECONDS < 60` or `CHALLENGE_TTL_SECONDS < 30`.
- `LOG_WITNESS_ENABLED=true` with `LOG_WITNESS_INTERVAL_SECONDS < 5`.
- `WITNESS_COSIGNING_ENABLED=true` without `WITNESS_ID`, without
  `WITNESS_SIGNING_PRIVATE_KEY_PEM`, or without `LOG_WITNESS_ENABLED=true`.
  (`WitnessSigningService` additionally rejects a non-Ed25519 key, a malformed
  witness DID, or a `WITNESS_KEY_ID` not under `WITNESS_ID` — in every environment.)

**Warns** (starts, but flags a risk) on, in production:

- Empty `WEBHOOK_SECRET` (inbound HMAC disabled).
- `STREAM_HUB_STRATEGY=memory` (SSE won't sync across replicas).
- `OTEL_ENABLED=true` with empty `OTEL_EXPORTER_OTLP_ENDPOINT` (traces discarded).
- `REVOCATION_FEEDS` set with `TOKEN_ISSUANCE_ENABLED=false` (poller won't run).
- `TOKEN_ISSUANCE_ENABLED=true` with `AUTH_PERSISTENCE=memory` (state not shared).
</content>
