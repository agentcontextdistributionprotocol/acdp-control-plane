# Testing

Three layers: unit (`npm test`), integration (`npm run test:integration`), and a
manual full-stack e2e smoke test (`e2e/run-e2e.sh` — not part of CI).

## Unit tests

Colocated next to source as `*.spec.ts`. Jest discovers them via the config block
in `package.json` (`rootDir: src`, `testRegex: .*\.spec\.ts$`). Dependencies are
mocked; no DB, no HTTP server, no network.

```bash
npm test                          # one-shot
npm test -- src/auth/auth.guard.spec.ts   # single file
npm test -- -t "rejects spoofed tenant"    # filter by test name
npm run test:watch                # watch mode
npm run test:cov                  # coverage → coverage/ (thresholds enforced)
npm run check:conventions         # CI grep rules (no console.*, process.env, raw throws)
npm run check:build               # build emit shape (builds twice; catches silent no-emit)
```

### Why Jest transforms `@nestjs/*`

NestJS 12 ships its runtime packages (`@nestjs/{common,core,platform-express,testing,
swagger,mapped-types}`) as ES modules only. The app consumes them from CommonJS
through Node's native `require(esm)`, but Jest never hands a module to Node's
`require`: its CommonJS runtime compiles every file into its own sandbox and can
load ESM only through Node's experimental vm-modules API, which needs a Node flag.
Instead of that flag (issue #191), the jest config down-compiles
`node_modules/@nestjs/**` to CommonJS **inside Jest only**, with `@swc/jest`:

- `transform` has a `/node_modules/@nestjs/.+\.js$` → `@swc/jest` entry, listed
  **before** the `ts-jest` entry (Jest uses the first matching key, and ts-jest's
  `^.+\.(t|j)s$` also matches `.js`). Project TypeScript is still compiled by
  ts-jest, which owns decorator metadata, the coverage numbers and in-spec type
  errors.
- `transformIgnorePatterns: ["/node_modules/(?!@nestjs/)"]` lets Jest transform
  that one scope of `node_modules` (by default it transforms none of it).

Both settings live in **two** configs that must stay in sync: the `jest` block in
`package.json` (unit) and `test/jest.integration.config.ts` (integration). A config
missing them fails its whole suite with `Must use import to load ES Module: …/@nestjs/…`.

Production is unaffected: `dist/main.js` still loads Nest through Node's native
`require(esm)`, and that path is exercised outside Jest by `npm run check:build`
(boots `dist/main.js`), `test/integration/shutdown.integration.spec.ts` (spawns the
app with `node -r ts-node/register/transpile-only`) and the release image smoke test.

Consequences:

- `npm test`, `npx jest`, `node node_modules/jest/bin/jest.js` and IDE runners (the VS
  Code Jest extension, WebStorm's Jest run configs) all work with no extra flags or
  `NODE_OPTIONS`. No `ExperimentalWarning` lines are printed.
- Inside Jest, Nest is ordinary CommonJS in Jest's module registry, so
  `jest.resetModules()` / `jest.isolateModules()` re-instantiate Nest modules too. A
  spec comparing a Nest class across an isolation boundary would see two identities.
- **A new ESM-only dependency** fails with `Must use import to load ES Module: …/<pkg>/…`.
  Add it to **both** the transform key regex and the `transformIgnorePatterns`
  negative lookahead (e.g. `/node_modules/(@nestjs|newpkg)/.+\.js$` and
  `/node_modules/(?!(@nestjs|newpkg)/)`), in **both** configs. Do not re-add the
  experimental vm-modules flag: it would make Jest's ESM fallback silently load the
  package and hide the missing entry.
- `src/test-harness.spec.ts` is the tripwire for this setup: it fails if the flag
  comes back (via `process.execArgv` or `NODE_OPTIONS`), and it fails — on the Nest
  Dependabot PR — the day `@nestjs/common` / `@nestjs/core` start resolving `require`
  to a CommonJS file, at which point the swc transform and `transformIgnorePatterns`
  should be deleted from both configs in that same PR.

Coverage thresholds live in the `jest.coverageThreshold` block in `package.json`
(statements 70 / branches 58 / functions 55 / lines 70). CI runs the unit suite
with `--coverage`, so a regression below any threshold fails the build — raise
the numbers as coverage improves; never lower them to make a PR pass.

The suite is broad — every guard, decider, store, parser, and the pipeline core
is covered. Highlights of the contracts most likely to break under refactor:

| Area | Specs (under `src/`) |
|------|----------------------|
| Ingest | `ingest/hmac.spec.ts`, `ingest/ingest.service.spec.ts` |
| Pipeline | `processor/event-processor.service.spec.ts` |
| Auth guard / tenancy | `auth/auth.guard.spec.ts`, `auth/auth.guard.tenant.spec.ts` |
| Issuance & crypto | `auth/token-issuer.service.spec.ts`, `auth/jwt-signing.spec.ts`, `auth/acdp-verify.spec.ts`, `auth/challenge-store.service.spec.ts` |
| Federation & revocation | `auth/cross-issuer-validator.service.spec.ts`, `auth/jwks-client.spec.ts`, `auth/trusted-issuers.spec.ts`, `auth/revocation-feeds.spec.ts`, `auth/revocation-poller.service.spec.ts` |
| did:web & SSRF | `auth/did-web/did-web-resolver.service.spec.ts`, `auth/did-web/ssrf-guard.spec.ts`, `contexts/safe-federation-client.spec.ts` |
| Policy | `policy/static-rules-policy.decider.spec.ts`, `policy/opa-policy.decider.spec.ts`, `policy/caching-policy.decider.spec.ts`, `policy/policy.guard.spec.ts`, `policy/controller-coverage.spec.ts` |
| Quota | `quota/quota.guard.spec.ts`, `quota/quota-config.spec.ts`, `quota/quota-store.spec.ts` |
| Capabilities & routing | `agents/capability.service.spec.ts`, `agents/capability-uri.spec.ts`, `routing/bandit-router.service.spec.ts` |
| Tenancy parsers | `tenant/tenant-context.spec.ts`, `tenant/tenant-agents.spec.ts` |
| Streaming | `events/memory-stream-hub.strategy.spec.ts`, `events/redis-stream-hub.strategy.spec.ts` |
| Webhooks | `webhooks/webhook.service.spec.ts` |
| Config & errors | `config/app-config.service.spec.ts`, `errors/exception.filter.spec.ts` |

> `policy/controller-coverage.spec.ts` is a guardrail: it asserts which controller
> methods must carry `@CheckPolicy`, so a new handler that forgets authorization
> fails CI.

### Spec conformance vectors

Specs that read golden vectors from the pinned ACDP spec checkout (`ACDP_SPEC_DIR`,
falling back to the sibling `../agentcontextdistributionprotocol`; CI sets
`ACDP_REQUIRE_CONFORMANCE=1` so a missing checkout fails instead of skipping) include
the `wit-*`, `log-*`, `rev-*` and `rcpt-*` goldens and `sig-004-ed25519-strict-negative`
(RFC-ACDP-0001 §5.10): `auth/ed25519-strict.conformance.spec.ts` forges a small-order
signature and asserts every Ed25519 entry point (`verifySignatureB64` incl. the 8 small-order
points, challenge, capability, checkpoint, cosignature host + native, quorum,
receipt) rejects it. The pin lives in `.github/workflows/ci.yml`
and must move in the same PR as the first spec reading a new fixture.

## Integration tests

Live in `test/integration/**.integration.spec.ts`. They boot the full NestJS app,
run real migrations against a real Postgres on **port 5433**
(`acdp_control_plane_test`), and exercise the service over HTTP. Config is
`test/jest.integration.config.ts`: `maxWorkers: 1` (serial), 60 s timeout, with
`globalSetup`/`globalTeardown`.

```bash
npm run test:integration                       # full suite
npm run test:integration -- ingest.integration # single spec (regex against path)
```

### Database lifecycle

- `test/setup/global-setup.ts` runs `docker compose -f docker-compose.test.yml up
  -d postgres-test redis-test --wait` (skipped when `CI` is set — rely on CI
  service containers instead), waits for connectivity, and points `DATABASE_URL`
  at the test DB.
- **Redis is now a second prerequisite.** `redis-test` is published on **6380**
  (not 6379, so it cannot collide with a developer's own local Redis) and backs
  `test/integration/redis-live.integration.spec.ts`, which drives a REAL ioredis
  client because both Redis unit specs mock the client away and therefore prove
  nothing about the wire protocol (ioredis 6 speaks RESP3 by default).
  That spec's skip policy is deliberate:
  - `CI` set + `REDIS_URL` set → runs (the `integration` job supplies both)
  - `CI` set + `REDIS_URL` unset → **fails loudly**, never skips
  - local, no Redis on 6380 → skips, with a message telling you how to start one

  Note `REDIS_URL` is NOT exported by `global-setup`: setting it process-wide
  would flip `QuotaModule` onto the Redis store for every other spec. The live
  spec connects on its own.
  The same file also boots the app with `STREAM_HUB_STRATEGY=redis` (issue #210
  Phase 3): against a port nothing listens on — "Redis stopped", without ever
  stopping the shared Redis — `/readyz` must stay 200 with
  `checks.streamHub.status: "down"`; against the live Redis it must report `up`
  (that case follows the same skip policy).
- `test/setup/global-teardown.ts` tears the container down **unless** `CI` or
  `KEEP_TEST_DB` is set — keep it up for fast re-runs:

  ```bash
  docker compose -f docker-compose.test.yml up -d postgres-test redis-test
  KEEP_TEST_DB=1 npm run test:integration
  ```

- Each spec calls `ctx.cleanup()` in `beforeEach` to `truncateAll()` between cases.

### Suites

| Spec | Covers |
|------|--------|
| `health.integration.spec.ts` | `/healthz`, `/readyz`, `/metrics` shape + public access; both probes `no-store` + HEAD; the pool diagnostics series (`acdp_db_pool_connections`, `acdp_db_pool_errors_total`); probes public under strict tenancy |
| `readiness.integration.spec.ts` | Issue #210: `/readyz` 503 `DEPENDENCY_UNAVAILABLE` with the DB refused / black-holed (via `test/helpers/pg-fault-proxy.ts`), recovery bounds incl. a connect pending at restore, ≤ 1 probe pool client under 50 concurrent probes, probes never `429`, metrics, boot validation of the readiness knobs; `/healthz` liveness (Phase 2): < 200 ms and 200 while the DB is black-holed, `ok` mirrors the verdict and returns to `true` after recovery with no restart and no latch |
| `auth.integration.spec.ts` | Missing / wrong / valid bearer; `@Public()` bypass |
| `auth-persistence.integration.spec.ts` | Postgres-backed challenge / revocation / ledger |
| `pinned-keys-admin.integration.spec.ts` | Admin pinned-key reload |
| `ingest.integration.spec.ts` | HMAC verify, payload validation, run correlation |
| `ingest-trust.integration.spec.ts` | Enrollment gate + strict-tenant ingest |
| `lineage.integration.spec.ts` | DAG construction, edge dedup, empty-DAG path |
| `runs-lifecycle.integration.spec.ts` | `running`→`completed`, list filters + pagination, 404s |
| `events-stream.integration.spec.ts` | Per-run SSE isolation, global firehose |
| `webhooks.integration.spec.ts` | Create/list/delete + 400 validation |
| `tenancy-isolation.integration.spec.ts` | Cross-tenant read isolation + header spoof rejection |
| `domain-packs.integration.spec.ts` | Pack-gated `context_type` accept/reject |
| `federation-proxy.integration.spec.ts` | `/contexts` proxy + SSRF + 429→503 mapping |
| `retention-routing.integration.spec.ts` | Data retention purge + bandit routing |
| `quota.integration.spec.ts` | Per-tenant per-action quotas, 429 + `Retry-After` |
| `capabilities.integration.spec.ts` | Signed capability declare + discovery |
| `dashboard.integration.spec.ts` | `/dashboard/overview` KPIs + trust tiles |
| `auth-issuance.integration.spec.ts` | `/auth/challenge` → `/auth/token` IdP flow end-to-end |
| `auth-introspect.integration.spec.ts` | RFC 7662 introspection: active claims, `{active:false}` collapse, auth gate |
| `trust-hardening.integration.spec.ts` | Receipt audit sweep + trust surfaces |
| `log-witness.integration.spec.ts` | Checkpoint witness + log-inclusion audit verdicts |
| `witness-cosigning.integration.spec.ts` | RFC-ACDP-0015 cosignature mint/serve + quorum |
| `error-envelope.integration.spec.ts` | `GlobalExceptionFilter` acdp+json envelope over HTTP |
| `migrations.integration.spec.ts` | Migration re-run idempotency + core table presence |

### How the test app is wired (`test/helpers/test-app.ts`)

- Clears the `prom-client` registry to avoid duplicate-metric errors across suites.
- Runs `runMigrations(TEST_DB_URL)` against the test DB before booting.
- Boots the real `AppModule` with `rawBody: true`, the global `ValidationPipe`,
  and `GlobalExceptionFilter` — same wiring as `src/bootstrap.ts` minus helmet and swagger.
- Listens on a random port (`app.listen(0)`); reach it via `ctx.url` or the typed
  `ctx.client` (`TestClient`).
- `databaseUrl` points the app (not the migrations) at another URL — e.g. a
  `PgFaultProxy` (`test/helpers/pg-fault-proxy.ts`), an in-process TCP proxy in
  front of the test Postgres that can `refuse()` (ECONNREFUSED), `blackhole()`
  (sockets stay open, bytes dropped), and `restore()` (optionally `keepPending`,
  leaving the black-holed sockets dead) without ever stopping the shared database.
  `readiness: { timeoutMs, cacheMs }` sets `READINESS_*` (cleared when unset).
- `createTestApp(opts)` returns `{ app, url, client, module, cleanup }`.

### Writing a new integration spec

```ts
import { createTestApp, TestAppContext } from '../helpers/test-app';

describe('my feature', () => {
  let ctx: TestAppContext;

  beforeAll(async () => { ctx = await createTestApp({ webhookSecret: 'optional-secret' }); });
  beforeEach(async () => { await ctx.cleanup(); });        // truncate between tests
  afterAll(async () => { await ctx.app.close(); });        // closes pool, completes SSE subjects

  it('does the thing', async () => {
    const res = await ctx.client.ingest(myEvent, { runId: 'r-1', secret: 'optional-secret' });
    expect(res.status).toBe(204);
  });
});
```

For SSE:

```ts
import { TestSSEClient } from '../helpers/sse-client';

const sse = new TestSSEClient(ctx.url, 'test-key');
await sse.connect(`/runs/${runId}/events/stream`);
await sse.waitForEvent('context_published', 5000);
sse.close();
```

## End-to-end smoke test (`e2e/`)

`e2e/run-e2e.sh` boots the **real** stack with Docker Compose — Python
playground → Rust registry → this control plane → Postgres — and asserts the
control plane's lineage DAG matches what the playground produced. It exercises
the true webhook path (registry-minted HMAC, not a test client). Manual only:
it needs Docker plus an OpenAI key and is **not** wired into CI. See
`e2e/README.md` for the flow, scenarios, and the registry SSRF patch it builds.

## CI

`.github/workflows/ci.yml` runs on every PR/push to `main`:

1. **unit** — convention greps (`scripts/ci-conventions.sh`), ESLint
   (`--max-warnings 0`), `npm run typecheck` (TS 7) + `npm run typecheck:ts6`,
   the build-emit check, then the unit suite with coverage
   thresholds enforced; the lcov report uploads as an artifact.
2. **integration** — the full integration suite against a `postgres:16`
   service container on port 5433.
3. **docker** — builds the production `Dockerfile` (no push) so image breaks
   surface at PR time, not at release time.

Release tags additionally gate the GHCR push on the unit suite and a container
smoke test (boot against Postgres, assert `/healthz` + `/readyz`) — see
`.github/workflows/release.yml`.
