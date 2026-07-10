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
> [MULTI-TENANCY.md](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/MULTI-TENANCY.md).
> This page documents the CP's wiring (the guard, repositories, and the
> fail-fast startup check) rather than re-deriving the model.

## The default tenant

`DEFAULT_TENANT_ID = 'default'`. Single-tenant deployments never opt into
tenancy and run entirely as `default`.

`default` is a **silent default** in the repository layer: the `tenantId` arg
defaults to `'default'`, so a handler that forgets to thread `tenantOf(req)` will
*compile and leak the default tenant cross-tenant*. The discipline below exists
to make that impossible to reach by accident.

## How the guard resolves the tenant

`AuthGuard` pins `req.tenantId` from exactly one source, in precedence order:

1. **Signed / bound tenant** — the JWT `tenant` claim, or the tenant a
   `TENANT_API_KEYS` entry binds the key to. Authoritative.
2. **`X-Tenant-Id` header** — only honored when there is no signed/bound tenant,
   and only outside strict mode.
3. **Absence → `default`** — when nothing asserts a tenant.

Two hard rules protect the boundary:

- **Mismatch is hostile.** If a signed/bound tenant and an `X-Tenant-Id` header
  both exist and disagree, the request is rejected (`403`). A spoofed header
  never wins over a signed claim.
- **Reserved-`default` rejection.** Any *explicit* assertion of `default` (via
  `X-Tenant-Id` or a signed `tenant` claim) is rejected. `default` is reachable
  only through the **absence** of an assertion — never by asserting it (parity
  with the registry's `reject_reserved_tenant`).

### Strict mode — `AUTH_REQUIRE_TENANT=true`

Default-deny anything that resolves only to the silent `default`:

- A JWT with no `tenant` claim → `403`.
- A bare (unbound) or absent API key → `403`.
- An `X-Tenant-Id` header alone never satisfies strict mode (it's spoofable).

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
| `TENANT_API_KEYS` | `tenantId:key,tenantId:key,bareKey` | Bind API keys to tenants. Bare keys (no `:` prefix) → `default`. Each key may map to **at most one** tenant (validated at boot). |
| `TENANT_AGENTS` | `tenantId:agent_did,tenantId:agent_did` | Bind agent DIDs to tenants. The tenant comes **first** because a DID itself contains colons. Used to stamp the `tenant` claim on issued JWTs. Unlisted agents → `default`. |
| `AUTH_REQUIRE_TENANT` | `true` / `false` | Strict mode (see above). |
| `TENANT_QUOTAS` | see [POLICY.md](./POLICY.md#quota) | Per-tenant per-action rate limits. |

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

## Ingest tenancy

The ingest path has its own tenant controls because events arrive from registries,
not authenticated principals:

- `INGEST_STRICT_TENANT=true` — an unenrolled authority may not assert a
  non-`default` tenant via `X-Tenant-Id`; only a server-side registry enrollment
  can bind events to a non-`default` tenant.
- A registry enrollment (`POST /registries/enroll`) carries a `tenantId` that
  binds all events from that authority.
- The HMAC-authenticated run-notify endpoints (`POST /runs/started`,
  `POST /runs/:runId/complete`) accept `X-Tenant-Id` the same way and reject
  an explicit assertion of the reserved `default` tenant.

See [INGEST.md](./INGEST.md#registry-trust--enrollment).

## Testing

`test/integration/tenancy-isolation.integration.spec.ts` exercises cross-tenant
read isolation and the header-spoofing rejections. Unit coverage lives in
`src/tenant/*.spec.ts` and `src/auth/auth.guard.tenant.spec.ts`.
</content>
