# Testing

Two layers, two commands.

## Unit tests

Colocated next to source as `*.spec.ts`. Jest discovers them via the config block
in `package.json` (`rootDir: src`, `testRegex: .*\.spec\.ts$`). Dependencies are
mocked; no DB, no HTTP server, no network.

```bash
npm test                          # one-shot
npm test -- src/auth/auth.guard.spec.ts   # single file
npm test -- -t "rejects spoofed tenant"    # filter by test name
npm run test:watch                # watch mode
npm run test:cov                  # coverage → coverage/
```

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
  -d postgres-test --wait` (skipped when `CI` is set — rely on a CI service
  container instead), waits for connectivity, and points `DATABASE_URL` at the
  test DB.
- `test/setup/global-teardown.ts` tears the container down **unless** `CI` or
  `KEEP_TEST_DB` is set — keep it up for fast re-runs:

  ```bash
  docker compose -f docker-compose.test.yml up -d postgres-test
  KEEP_TEST_DB=1 npm run test:integration
  ```

- Each spec calls `ctx.cleanup()` in `beforeEach` to `truncateAll()` between cases.

### Suites

| Spec | Covers |
|------|--------|
| `health.integration.spec.ts` | `/healthz`, `/readyz`, `/metrics` shape + public access |
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

### How the test app is wired (`test/helpers/test-app.ts`)

- Clears the `prom-client` registry to avoid duplicate-metric errors across suites.
- Runs `runMigrations(TEST_DB_URL)` against the test DB before booting.
- Boots the real `AppModule` with `rawBody: true`, the global `ValidationPipe`,
  and `GlobalExceptionFilter` — same wiring as `main.ts` minus helmet and swagger.
- Listens on a random port (`app.listen(0)`); reach it via `ctx.url` or the typed
  `ctx.client` (`TestClient`).
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
</content>
