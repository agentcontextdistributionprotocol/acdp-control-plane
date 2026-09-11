# Assumptions

## Removing the unused `@nestjs/config` dependency (Phase 4, CP-5)
- **Plan:** `plans/wave1-cp-1-4-5-6-7.md`
- **Assumed:** `@nestjs/config@^4.0.0` was genuinely dead code — a previously
  abandoned attempt at the same env-loading fix this phase implements — and safe
  to remove entirely rather than leave in place or actually wire up.
- **Chose:** Removed the dependency from `package.json`, after confirming
  `grep -rn "@nestjs/config" src/ test/` returns zero hits (checked twice: once
  during planning, re-confirmed immediately before the `package.json` edit in
  Phase 4). Replaced with a plain `dotenv/config` preload at the top of
  `main.ts`, which is the only mechanism that can reach `main.ts`'s
  pre-Nest-bootstrap manual `AppConfigService` construction (used to drive
  `runMigrations()` before `NestFactory.create(AppModule)` ever resolves a
  module graph `ConfigModule.forRoot()` would live in).
- **Alternatives:** (a) Wire `@nestjs/config` properly via `ConfigModule.forRoot()`
  — rejected: structurally cannot affect the pre-bootstrap migration path,
  and would leave two parallel config-resolution mechanisms in the codebase
  (the existing hand-rolled `AppConfigService` plus Nest's own). (b) Leave
  `@nestjs/config` declared but still unused — rejected: recreates exactly the
  "abandoned half-fix nobody notices" problem CP-5 exists to close, as a red
  herring for the next engineer investigating env loading.
- **Blast radius if wrong:** Low and easily reversible. If some other in-flight
  branch or an undiscovered dynamic `require('@nestjs/config')` depended on
  this package being present, that branch would fail loudly at `tsc`/build
  ("Cannot find module") once rebased past this change — npm itself doesn't
  check import sites, so `npm install`/`npm ci` would still succeed; the
  failure surfaces at the next build/CI gate instead. Either way it's a loud,
  immediate failure, not a silent one. Restoring the dependency is a one-line
  `package.json` revert plus `npm install`.
- **Status:** CONFIRMED (2026-08-28) — see `DECISIONS.md`.

## Discovering truncate targets from `pg_tables` instead of a hardcoded list (Phase 0, issue #137)
- **Plan:** `plans/dep-migrations-137.md`
- **Assumed:** every table in the `public` schema except `_migrations` is test
  fixture data that must be cleared between integration specs, so discovering the
  list at runtime is safe and is strictly better than maintaining a literal one.
- **Chose:** replaced `truncateAll`'s hardcoded 14-table `TRUNCATE` with a
  PL/pgSQL `DO` block that reads `pg_tables` (schema `public`, excluding
  `_migrations`) and truncates what it finds, CASCADE. Motivation is a measured
  defect, not tidiness: the literal list had drifted five tables behind the schema
  (`agent_capabilities`, `auth_challenges`, `issuance_ledger`,
  `revocation_cursors`, `revoked_tokens`), which made the integration suite
  non-idempotent — run 1 green, run 2 failing
  `revocation-repository.contract.ts:86` with a cursor left from the prior run.
  CI never saw it because every CI run gets a fresh Postgres service container.
  Fixing the *class* (drift) rather than the *instance* (five names) is what stops
  the next schema addition from silently reintroducing it.
- **Alternatives:** (a) Add the five missing names to the literal list — rejected:
  it re-arms the same trap for the next table added, and this is the second time
  the list has gone stale. (b) Leave it and document the hazard — rejected: five
  of the ten phases gate on `npm run test:integration`, and a non-idempotent suite
  would attribute phantom failures to whichever dependency bump was under test,
  which is exactly the misattribution this whole plan exists to avoid.
- **Blast radius if wrong:** Test-only in the sense that no `src/` file is touched
  and nothing ships to production — but the *first* version of this entry said
  exactly that and understated the risk, which the Phase 0 verify gate correctly
  called out. Going dynamic converted a loud failure into a silent one: the old
  hardcoded TRUNCATE errored against a foreign database (`relation
  "webhook_deliveries" does not exist`), whereas "every table in `public`" would
  cheerfully wipe whatever `DATABASE_URL` named — and this phase's own workflow is
  *pointing `DATABASE_URL` somewhere else*. Mitigated by `assertTestDatabase`,
  which refuses any database whose name does not end in `_test`; verified by a
  negative test (`production_db` → refused, with the password redacted in the
  refusal). The remaining failure mode is a future table that must survive
  truncation being cleared — a loud, immediate test failure whose fix is one entry
  in `PRESERVED_TABLES`. Reverting is a single file revert.
- **Verified before landing:** the gate's own repro (`auth-persistence` alone,
  twice: 20/20 both times — it failed on run 2 before this fix), full suite twice
  against one database (24 suites / 151 tests, exit 0 each), unit suite unchanged
  from baseline, and `tsc`/`lint`/`check:conventions` all 0.
- **Status:** UNCONFIRMED

## Working around host port 5433 rather than stopping another project's container (Phase 0, issue #137)
- **Plan:** `plans/dep-migrations-137.md`
- **Assumed:** the container holding host port 5433 belongs to an unrelated
  project (`aitp-*`) on a second Docker daemon, and stopping it is the user's call
  — not a side effect of running this plan.
- **Chose:** started this project's test Postgres on port 55433 and pointed
  `DATABASE_URL` at it (`global-setup.ts` already honors that env var), leaving the
  foreign container untouched. Two daemons are in play: `colima` is the active
  context and holds this repo's container, while the port owner sits behind
  `/var/run/docker.sock`, which this sandbox cannot reach. Evidence the shadowing
  is real: `docker exec` into our container lists `acdp_control_plane_test`, while a
  host connection to `localhost:5433` lists `aitp_control_plane_test`.
- **Alternatives:** (a) Stop the foreign container — rejected: unreachable from
  this sandbox anyway, and lane sessions (`acdp-leader-verify-pg`,
  `acdp-lane1-w3u5-pg`) are running, so it could disrupt concurrent work.
  (b) Change `docker-compose.test.yml`'s published port — rejected: it would land
  in a PR and change the port for every developer and for CI to work around one
  machine's local conflict.
- **Blast radius if wrong:** None in the repo — the workaround is entirely an env
  var at invocation time and no tracked file encodes port 55433. The standing cost
  is that `npm run test:integration` with no `DATABASE_URL` still fails on this
  machine until the foreign container is stopped; `global-setup.ts` now reports the
  underlying `database "..." does not exist` instead of a bare "not reachable", so
  the next person diagnoses it in seconds rather than minutes.
- **Status:** UNCONFIRMED
