# Policy & Quota

Two of the four global guards are **decorator-gated**: they no-op unless a handler
carries the matching decorator. `PolicyGuard` authorizes *what* a caller may do;
`QuotaGuard` rate-limits *how often* per tenant. Both run after `AuthGuard` (so
`subjectDid`, `scopes`, and `tenantId` are populated) and `ThrottleByUserGuard`.

```
AuthGuard ─► ThrottleByUserGuard ─► PolicyGuard ─► QuotaGuard
   (always)        (always)         (@CheckPolicy)   (@CheckQuota, runs last)
```

`QuotaGuard` runs **last** by design — a request denied by auth or policy never
burns a quota increment.

---

## Policy

`PolicyGuard` (`src/policy/`) reads `@CheckPolicy(action)` from the handler. With
no decorator it returns `true` immediately (the handler is unconditionally
allowed, having already passed auth). With a decorator it builds a `PolicyRequest`
and asks a pluggable `PolicyDecider`.

### `PolicyRequest`

```ts
{
  subjectDid: string;            // caller DID ('' if unauthenticated)
  action: PolicyAction;          // 'context.publish' | 'context.retrieve' | 'context.list'
                                 // | 'capability.declare' | 'run.read' | 'run.start' | …
  resourceId: string;            // ctx_id / run_id / agent_did ('' for list ops)
  resourceVisibility?: 'public' | 'restricted' | 'private';
  resourceAudience?: string[];   // DIDs explicitly granted access
  scopes: string[];              // from the JWT scope/scopes claim
  tenantId?: string;
}
```

The decider returns `allow`, `deny` (with a `code` + `reason`), or
`indeterminate`. `PolicyGuard` maps `allow → 200`, and both `deny` and
`indeterminate` → `403`:

```json
{ "message": "policy denied", "code": "visibility", "reason": "…" }
```

`code` is one of `visibility`, `audience`, `scope`, `tenant_mismatch`,
`unauthenticated`, `indeterminate`.

### Backends (`POLICY_BACKEND`)

| Backend | Selected by | Behavior |
|---------|-------------|----------|
| `static` (default) | `POLICY_BACKEND=static` | In-process rules (`StaticRulesPolicyDecider`). |
| `opa` | `POLICY_BACKEND=opa` | Delegates to an OPA sidecar over HTTP. |

Both are wrapped by a **caching decider** (LRU + TTL, default 5 s / 10 000
entries). The cache key includes sorted scopes + audience. Only `allow`/`deny`
are cached — `indeterminate` is never cached, so coverage gaps reappear on every
request rather than sticking.

#### Static rules (`StaticRulesPolicyDecider`)

- Unauthenticated callers: only `public` `context.retrieve` / `context.list`.
- Tenant gate: when both request and resource carry a `tenantId`, a mismatch is
  denied (`tenant_mismatch`).
- Per-action required scopes (config-driven) checked by set membership.
- `context.retrieve` visibility: `public` allowed; `private` denied; `restricted`
  requires the caller DID to be in the resource audience.
- Other actions default-allow once the above pass.

#### OPA backend

`POST <OPA_URL>/v1/data/<OPA_PACKAGE_PATH>/<rule>` with input:

```json
{
  "subject_did": "…",
  "action": "context.publish",
  "resource_id": "…",
  "resource_visibility": "public" | "restricted" | "private" | null,
  "resource_audience": ["did:web:…"],
  "scopes": ["publish"],
  "tenant_id": "tenant-a"
}
```

Expected response: `{ "result": { "allow": true } }` or
`{ "result": { "allow": false, "deny_code": "…", "deny_reason": "…" } }` or
`{ "result": { "indeterminate": true, "note": "…" } }`. On timeout
(`OPA_TIMEOUT_MS`, default 1500 ms) / 5xx / transport error the decider returns
`indeterminate` (→ deny) **unless** `OPA_FAIL_OPEN=true`, which returns `allow`.

A reference Rego policy + tests live under [`docs/policies/`](./policies/).

### Which handlers are gated

Grep `@CheckPolicy` for the live set. As of this writing:

| Action | Handler(s) |
|--------|-----------|
| `context.retrieve` | `GET /contexts/*ctxId` |
| `capability.declare` | `POST /capabilities` |
| `run.read` | several `GET /runs…` handlers |
| `run.start` | `POST /runs/:runId/complete` |

`src/policy/controller-coverage.spec.ts` pins which controller methods must carry
a policy decorator, so coverage gaps fail CI.

---

## Quota

`QuotaGuard` (`src/quota/`) reads `@CheckQuota(action)` and enforces per-tenant,
per-action **windowed counters**. Lookup chain (cheap → expensive); any miss
passes through:

1. No `@CheckQuota` decorator → pass.
2. No quota config / store → pass.
3. No limit configured for `(tenantId, action)` → pass.
4. Increment the counter; if the store is unavailable it **fails open** (allows).
5. Over the limit → `429`.

### Store (`QuotaStore`)

| Store | When | Notes |
|-------|------|-------|
| In-memory (default) | single process | `Map` of `{count, expiresAt}`; lost on restart. |
| Redis | `REDIS_URL` set | Atomic `INCR` + `EXPIRE NX` Lua script; window shared across replicas. |

Both fail open on transport error (return a sentinel that the guard treats as "no
signal").

### Config — `TENANT_QUOTAS`

```
TENANT_QUOTAS=tenant-a:publish=100/min,run.start=10/min;tenant-b:publish=500/min
```

- Tenants separated by `;`; within a tenant, `tenantId:action=count/window[,…]`.
- `window` ∈ `sec` | `min` | `hour`.
- `action` ∈ `publish` | `run.start` | `capability.declare` | `token.issue` | `*`
  (wildcard — applies to any action not explicitly listed for that tenant).
- Parsing is strict: a malformed entry throws `QuotaConfigError` at boot.

### 429 response

```json
{
  "message": "quota exceeded",
  "code": "rate_limited",
  "tenantId": "tenant-a",
  "action": "publish",
  "limit": 100,
  "windowSeconds": 60,
  "retryAfterSeconds": 42
}
```
plus a `Retry-After: 42` header.

### Which handlers are gated

| Action | Handler |
|--------|---------|
| `publish` | `POST /ingest/acdp` |
| `capability.declare` | `POST /capabilities` |

---

## Relationship to the coarse throttle

`ThrottleByUserGuard` (`@nestjs/throttler`, always on) is a *coarse* per-principal
request limiter (`THROTTLE_LIMIT` per `THROTTLE_TTL_MS`, with a tighter override
on `/auth/challenge` + `/auth/token`). `QuotaGuard` is the *business* quota:
per-tenant, per-action, and only where opted in. They are independent layers.
</content>
