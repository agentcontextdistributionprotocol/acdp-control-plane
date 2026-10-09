# Tenancy

The **tenant** is the unit of data isolation in the control plane. Every
tenant-owned row carries a `tenant_id`, every repository filters by it, and the
guard layer pins the resolving tenant on the request. Key files:
`src/tenant/{tenant-context,request-tenant,tenant-agents}.ts` and
`src/auth/auth.guard.ts`.

> **This model mirrors the registry**, by design — the resolution precedence,
> strict mode (`require_tenant`), and reserved-`default` rejection are the same
> rules, so the same JWT `tenant` claim scopes a caller identically on either
> peer. The authoritative description is the registry's
> [MULTI-TENANCY.md](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/MULTI-TENANCY.md)
> ([resolution precedence](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/MULTI-TENANCY.md#resolution-precedence),
> [strict mode](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/MULTI-TENANCY.md#strict-mode-authrequire_tenant--true),
> [reserved `default`](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/MULTI-TENANCY.md#the-reserved-default-sentinel)).
> The protocol itself defines no tenant; it only requires that tenant attribution
> rest on an authenticated signal —
> [RFC-ACDP-0008 §6.4](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0008-security.md#64-multi-tenancy-implementation-note).
> This page documents the CP's wiring (the guard, repositories, and the
> fail-fast startup check) and where it differs, rather than re-deriving the model.

## The default tenant

`DEFAULT_TENANT_ID = 'default'`. Single-tenant deployments never opt into
tenancy and run entirely as `default`.

`default` is a **silent default** in the repository layer: the `tenantId` arg
defaults to `'default'`, so a handler that forgets to thread `tenantOf(req)` will
*compile and leak the default tenant cross-tenant*. The discipline below exists
to make that impossible to reach by accident.

## How the guard resolves the tenant

`AuthGuard` (`src/auth/auth.guard.ts`; full guard flow in
[AUTH.md](./AUTH.md#the-guard-authguard)) pins `req.tenantId` from exactly one source,
in precedence order:

1. **Signed / bound tenant** — the JWT `tenant` claim, or the tenant a
   `TENANT_API_KEYS` entry binds the key to. Authoritative.
2. **`X-Tenant-Id` header** — (JWTs only; API keys never take the tenant from it: a bound key
   with a different header is `TENANT_MISMATCH`, a bare key ignores it) only honored when there is no signed/bound tenant,
   only outside strict mode, **and only when `TENANT_HEADER_TRUST=any_peer`** (see
   below). With the default `none`, a JWT with no `tenant` claim that sends the header
   is rejected (`403 TENANT_HEADER_UNTRUSTED`).
3. **Absence → `default`** — when nothing asserts a tenant.

Two hard rules protect the boundary:

- **Mismatch is hostile.** If a signed/bound tenant and an `X-Tenant-Id` header
  both exist and disagree, the request is rejected (`403 TENANT_MISMATCH`). A spoofed header
  never wins over a signed claim.
- **Reserved-`default` rejection.** Any *explicit* assertion of `default` (via
  `X-Tenant-Id` or a signed `tenant` claim) is rejected (`403 TENANT_RESERVED`). `default` is reachable
  only through the **absence** of an assertion — never by asserting it (parity
  with the registry's `reject_reserved_tenant`).

### Who may send `X-Tenant-Id` — `TENANT_HEADER_TRUST`

Mirrors the registry's
[`tenant_header_trust`](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/MULTI-TENANCY.md#who-may-send-x-tenant-id)
with one difference: the CP accepts only `none` (default) and `any_peer` — there is no
`trusted_proxies` mode, so the CP cannot restrict header trust to specific gateway
addresses; any other value fails startup. The header is spoofable, so it is trusted only
where the operator declares a boundary that authenticates callers and sets it:

| JWT `tenant` claim | `X-Tenant-Id` | `none` (default) | `any_peer` |
|---|---|---|---|
| present | absent / equal | claim | claim |
| present | different | `403 TENANT_MISMATCH` | `403 TENANT_MISMATCH` |
| absent (lax mode) | present | **`403 TENANT_HEADER_UNTRUSTED`** | header |
| absent (lax mode) | absent | `default` | `default` |
| absent (strict mode) | any | `403 TENANT_REQUIRED` | `403 TENANT_REQUIRED` |

An explicit `default` header is `403 TENANT_RESERVED` in every row. Local and federated
(`TRUSTED_ISSUERS`) tokens are treated identically — in particular a registry-issued
token with no `tenant` claim can no longer choose its tenant. The check runs after the
reserved / mismatch / strict checks and before the federated `read_only` gate.
`TENANT_HEADER_TRUST` does not apply to the `@Public()` HMAC routes (`/ingest/acdp`,
`/runs/started|complete`) — see [HMAC-authenticated routes](#hmac-authenticated-routes-ingest-and-run-notify)
below. Bare API keys ignore the header regardless (they resolve to `default`); API-key
behaviour does not depend on this knob. `any_peer` logs a startup warning on a
non-loopback `HOST`.
**Rollout:** a lax deployment that partitions by JWT + header must set
`TENANT_HEADER_TRUST=any_peer` (or, better, mint tenant-bound tokens / use
`AUTH_REQUIRE_TENANT=true`). **Rollback hazard:** builds older than this knob ignore it and
behave as `any_peer`.

### Strict mode — `AUTH_REQUIRE_TENANT=true`

Default-deny anything that resolves only to the silent `default`:

- A JWT with no `tenant` claim → `403 TENANT_REQUIRED`.
- A bare (unbound) API key → `403 TENANT_REQUIRED`; with `AUTH_API_KEYS` empty (the
  dev bypass), every non-JWT request → `403 TENANT_REQUIRED`. (A missing
  `Authorization` header is `401` before any tenant logic.)
- An `X-Tenant-Id` header alone never satisfies strict mode (it's spoofable).
- Strict mode does **not** cover the `@Public()` HMAC routes (see below).

This is the mirror of the registry's `auth.require_tenant`. Use it whenever more
than one tenant shares an instance.

## Threading the tenant through a handler

Any handler that reads or writes tenant-owned data **must** take
`@Req() req: TenantedRequest` and pass `tenantOf(req)` down through the service
into every repository call:

```ts
@Get()
async list(@Req() req: TenantedRequest) {
  return this.runsService.list({ /* filters */, tenantId: tenantOf(req) });
}
```

- `tenantOf(req)` (`src/tenant/request-tenant.ts`) returns the guard-pinned tenant,
  defaulting safely to `DEFAULT_TENANT_ID`.
- `assertNotReservedTenant(value)` rejects an explicit `default` assertion (used
  where a tenant is supplied in a body, e.g. registry enrollment).
- Repositories filter `WHERE tenant_id = …` and stamp it on writes. Composite
  unique / conflict targets include `tenant_id` (e.g. ingest idempotency is keyed
  by `(tenant_id, fingerprint)`; runs PK is `(tenant_id, run_id)`), so identical
  keys never collide across tenants.

## Configuration

| Env var | Format | Meaning |
|---------|--------|---------|
| `TENANT_API_KEYS` | `tenantId:key,tenantId:key,bareKey` | Bind API keys to tenants. Bare keys (no `:` prefix) → `default`. Each key may map to at most one tenant. **Classifies only** — every key must *also* be listed in `AUTH_API_KEYS`, the sole list a key is accepted from; a key only here is `401`. |
| `TENANT_AGENTS` | `tenantId:agent_did,tenantId:agent_did` | Bind agent DIDs to tenants. The tenant comes **first** because a DID itself contains colons. Used to stamp the `tenant` claim on issued JWTs. Unlisted agents → `default`. |
| `AUTH_REQUIRE_TENANT` | `true` / `false` | Strict mode (see above). |
| `TENANT_HEADER_TRUST` | `none` (default) / `any_peer` | Who may assert a tenant via `X-Tenant-Id` on a claim-less JWT (see above). |
| `INGEST_STRICT_TENANT` | `true` / `false` (default) | Ingest only: ignore `X-Tenant-Id` from an unenrolled registry (see below). |
| `TENANT_QUOTAS` | see [POLICY.md](./POLICY.md#quota) | Per-tenant per-action rate limits. Ingest (`publish`) always counts against `default` — see POLICY.md. |

> **Current behaviour — the two binding lists are parsed lazily, not at boot.** Startup
> only checks *whether* bindings exist (next section). The entries themselves are parsed
> on first use: `TENANT_API_KEYS` on the first API-key request, `TENANT_AGENTS` on the
> first token mint. A malformed entry (`tenant:` or `:key` with an empty side) or a key /
> DID bound to two different tenants then throws on that path, so **every** API-key
> request (or every `/auth/token`) fails with `500 INTERNAL_ERROR` while the process keeps
> running. Validate the values before deploying (`src/tenant/tenant-context.ts`,
> `src/tenant/tenant-agents.ts`).

> **Format gotcha.** In both `TENANT_API_KEYS` and `TENANT_AGENTS` the **tenant
> id precedes the colon**. For agents this matters: `tenant-a:did:web:agents.example:alice`
> parses as tenant `tenant-a`, DID `did:web:agents.example:alice`.

### Fail-fast: bindings without strict mode

If you configure tenant bindings — `TENANT_AGENTS`, or a `TENANT_API_KEYS` entry
bound to a non-`default` tenant — **without** `AUTH_REQUIRE_TENANT=true`, startup
**throws** (`AppConfigService.validate`):

> Tenant bindings are configured … but `AUTH_REQUIRE_TENANT=false`. A request that
> resolves to no tenant would run unscoped and leak cross-tenant data.

The rationale: multi-tenant intent combined with open-by-default resolution is a
data-leak vector. Either enable strict mode or remove the bindings.

## HMAC-authenticated routes (ingest and run-notify)

`POST /ingest/acdp`, `POST /runs/started` and `POST /runs/:runId/complete` are
`@Public()`: `AuthGuard` never runs, so `AUTH_REQUIRE_TENANT`, `TENANT_HEADER_TRUST` and
the mismatch check do **not** apply. The tenant comes from a registry enrollment or from
the `X-Tenant-Id` header, which the HMAC does not cover — in RFC-ACDP-0008 §6.4 terms it
is trusted only as far as the `WEBHOOK_SECRET` (or per-registry secret) holder is.

**Ingest** (`src/ingest/ingest.service.ts`; full contract in
[INGEST.md → Tenant attribution](./INGEST.md#tenant-attribution)):

| Claimed registry authority | `INGEST_STRICT_TENANT` | Tenant used |
|----------------------------|------------------------|-------------|
| enrolled (`POST /registries/enroll`, which carries a `tenantId`) | either | the enrollment's tenant; the header is ignored |
| enrolled but disabled | either | — `403 REGISTRY_DISABLED` |
| not enrolled, `INGEST_REQUIRE_ENROLLMENT=true` | either | — `403 REGISTRY_NOT_ENROLLED` |
| not enrolled | `false` (default) | `X-Tenant-Id` if present, else `default` |
| not enrolled | `true` | `default` — a non-`default` header is **ignored** (warning logged), not rejected |

Ingest does not apply the reserved-`default` rule: `X-Tenant-Id: default` is simply the
default bucket. Set `INGEST_STRICT_TENANT=true` (and enroll each registry with its
tenant) for any multi-tenant deployment; without it, any holder of the shared
`WEBHOOK_SECRET` can write events into any tenant.

**Run-notify** (`src/runs/runs.controller.ts`, current behaviour): `X-Tenant-Id` is taken
as-is — no enrollment lookup and no `INGEST_STRICT_TENANT` check — so any holder of
`WEBHOOK_SECRET` can attribute a run start/completion to any non-`default` tenant. Only an
explicit `default` is refused (`403 TENANT_RESERVED`); an absent header means `default`.
With `WEBHOOK_SECRET` unset (allowed only in `NODE_ENV=development`) these routes, like
ingest, skip HMAC verification entirely.

## Transparency-log witness evidence

`log_witness_checkpoints` and `log_cosignatures` (RFC-ACDP-0012/0015) are
tenant-owned like any other table — two tenants witnessing the same registry
head each get their own evidence row and their own cosignature. Their unique
constraints lead with `tenant_id` (migration `0019_witness_tenant_scope.sql`;
before it, the constraints omitted `tenant_id` entirely, so a second tenant's
insert silently no-opped and that tenant saw an empty witness history despite
the sweep reporting success). `LogWitnessRepository.updateQuorum` and
`.findByLogIdAndSize` take `tenantId` as a required parameter for the same
reason. `LogCosignatureRepository.list`/`.coveredLogs` are the one deliberate
exception — they back the `GET /log/witness` public feed for this CP's single
witness identity (`WITNESS_ID`), not a tenant view; see the class doc comment
in `src/storage/log-cosignature.repository.ts`.

`log_cosignatures`' unique constraint was widened again in migration
`0020_cosignature_freshness.sql`: the witness re-mints a cosignature on every
observation (why: [RFC-ACDP-0015](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0015-witness-cosigning.md)),
so the key includes `witnessed_at` — one row per (tenant, witness, log, head)
*observation*, not per head. Same per-tenant scoping as above; only the granularity changed.

## Testing

`test/integration/tenancy-isolation.integration.spec.ts` exercises cross-tenant
read isolation and the header-spoofing rejections. Unit coverage lives in
`src/tenant/*.spec.ts` and `src/auth/auth.guard.tenant.spec.ts`.
