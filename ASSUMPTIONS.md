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

## Deleting `supertest` + `@types/supertest` instead of bumping them (Phase 4, issue #137)
- **Plan:** `plans/dep-migrations-137.md`
- **Assumed:** `supertest@^7.0.0` and `@types/supertest@^6.0.2` are dead weight, not a
  deliberate staging step toward replacing the hand-rolled test client.
- **Chose:** deleted both rather than performing the planned `@types/supertest` 6→7
  bump. Evidence: a gitignore-safe `command grep -rn "supertest"` across the whole tree
  returns exactly two hits, both in `package.json`; zero imports in `src/`, `test/`,
  `e2e/`, or any config; and `test/helpers/test-client.ts:1-3` builds requests on
  `node:http`/`node:https` directly, with a comment at `:22` stating it is deliberately
  dependency-free. This applies Phase 1's already-confirmed ruling on `uuid`: bumping a
  package nothing imports adds churn and risk for no benefit.
- **Alternatives:** (a) Bump `@types/supertest` 6→7 as planned — rejected: it types a
  package with no consumers, so the bump is unverifiable by any test and pure noise.
  (b) Delete `@types/supertest` but keep `supertest` — rejected as incoherent; the runtime
  package is equally unused. (c) Leave both and document — rejected: that is what allowed
  them to survive Phase 1's sweep.
- **Blast radius if wrong:** Low and loudly reversible. If someone intended to migrate
  `test-client.ts` onto supertest, that work now starts with `npm i -D supertest
  @types/supertest` — one command. Nothing in CI, `docs/`, the Dockerfile, or any npm
  script references either package. Verified after deletion: clean `npm ci` exit 0, `tsc`
  0 on both projects, unit 69 suites / 768 passed / 3 skipped, integration 25 suites /
  155 tests, coverage unchanged.
- **Status:** UNCONFIRMED

## Not raising CI to Node 26 in Phase 4 (issue #137)
- **Plan:** `plans/dep-migrations-137.md`
- **Assumed:** the Node-version divergence this bump widens is worth flagging but not
  worth fixing inside a types PR.
- **Chose:** left `.github/workflows/{ci,release}.yml` on `node-version: '22'` and did
  not add an `engines` field. Corrected only the stale `.github/dependabot.yml:42`
  comment, which claimed the Dockerfile pins `node:22-bookworm-slim` when it has been
  `node:26-bookworm-slim` since `f49b3a7`.
- **The actual concern:** `@types/node@26` now describes a NEWER runtime than CI executes
  (CI 22, Docker 26). Before this bump the types were stricter than both runtimes — a
  safe direction. Now they are looser than CI's, so the compiler will no longer catch a
  Node-26-only API before it reaches a Node-22 CI run or deployment. Proven harmless
  today: the verifier compiled the byte-identical `src/`+`test/` against
  `@types/node@22.19.20` in a clean worktree and got exit 0, which is a stronger guarantee
  than a grep — no Node-26-only API is in use.
- **Alternatives:** (a) Raise CI to `node-version: '26'` — the cleanest fix, and it closes
  a pre-existing divergence, but it changes what every future CI run executes and deserves
  its own PR and its own green run, not a ride-along in a types bump. (b) Add
  `"engines": {"node": ">=22"}` — documentation and an npm warning, not enforcement.
- **Blast radius if wrong:** A future commit could type-check locally and fail at runtime
  on CI's Node 22. Bounded by CI itself catching it as a test failure rather than it
  reaching production, and by Docker already running 26.
- **Status:** UNCONFIRMED

## TypeScript 6: the "two-compiler split" does not exist — assumption WITHDRAWN
- **Plan:** `plans/dep-migrations-137.md` (Phase 8)
- **Assumed (WRONG, twice):** that `npm run build` emits with `@nestjs/cli@11.0.24`'s
  nested `typescript@5.9.3` while CI typechecks with the top-level `6.0.3`, leaving the
  repo with a genuine two-compiler split to be retired in Phase 9.
- **What is actually true.** `nest build` uses the **top-level `typescript@6.0.3`**. The
  nested 5.9.3 is installed but never loaded. `@nestjs/cli`'s
  `lib/compiler/typescript-loader.js` resolves the compiler with **`process.cwd()` first**:

  ```js
  const tsBinaryPath = require.resolve('typescript', {
    paths: [process.cwd(), ...this.getModulePaths()],
  });
  ```

  and npm scripts always run with cwd = package root. Three independent proofs:
  1. `new TypeScriptBinaryLoader().load().version` → **`6.0.3`**.
  2. Move `node_modules/@nestjs/cli/node_modules/typescript` aside entirely and
     `npm run build` still exits 0 with all 133 files. The nested copy is **inert**.
  3. Remove `rootDir` from `tsconfig.build.json` and `npm run build` fails with
     `TS5011 … Visit https://aka.ms/ts6 for migration information` — a **TypeScript
     6.0-only** diagnostic, surfaced *through the CLI*, exit 1.

  Proof 3 also falsifies the second thing this entry used to claim — that `@nestjs/cli`
  "discards config-level diagnostics." It does not: `TS5011` **is** a config-level
  diagnostic and it is fatal. The one true statement in the previous version of this
  entry — that `./node_modules/@nestjs/cli/node_modules/typescript/bin/tsc` rejects this
  config with `TS5103` — is irrelevant, because that binary is never executed. It was a
  real measurement of a code path nothing uses, and it is what made the wrong conclusion
  look evidenced.
- **Consequences of the correction:**
  - There is no compiler split and nothing to resolve. Every compiler the repo actually
    runs — `tsc`, `nest build`, `ts-jest`, `ts-node`, `eslint` — is **6.0.3**.
  - `npm ls typescript` showing two nodes is **cosmetic**: a `node_modules` artifact of
    `@nestjs/cli` declaring an exact `typescript` dependency that npm must nest.
  - **Phase 9's value is restated.** Bumping `@nestjs/cli`/`@nestjs/schematics` to 12 is
    dependency hygiene (it drops the redundant nested install and puts the declared and
    used versions back in agreement), **not** compiler unification — that is already
    true. Phase 9's criterion 1 still reads usefully, but it verifies tidiness rather
    than correctness, and Phase 8 does not depend on it for safety.
  - The `overrides` fix considered in round 1 was correctly rejected, but for a better
    reason than the one recorded then: **there is nothing to override.**
- **What survives the correction, and is stronger than documented.** Emit parity was
  re-measured across the *real* versions — `main`@`a97d311` built with 5.9.3 versus this
  branch built with 6.0.3 — and every `.js` and `.d.ts` of the 133 is **byte-identical**,
  with decorator metadata equal on both sides (`__metadata` 287/287, `design:paramtypes`
  109/109, `design:type` 135/135). So this is genuine **cross-version** emit parity, not
  the same-version parity the earlier framing implied.
- **Blast radius:** none outstanding. The risk this entry was created to track was
  imaginary. It is retained rather than deleted because the wrong version of it was
  committed, cited in a commit message, and used to justify a decision.
- **Status:** WITHDRAWN — superseded by direct evidence (loader source + removal
  experiment), not merely unconfirmed.

## Not declaring an `engines` field, despite Phase 9 introducing a real Node floor
- **Plan:** `plans/dep-migrations-137.md` (Phase 9)
- **Assumed:** it is better to surface the new Node-version constraint and let the repo
  owner set policy than to declare `engines` unilaterally inside a build-tooling phase.
- **What Phase 9 actually introduced.** `@nestjs/schematics@12.0.1` and
  `@angular-devkit/{core,schematics}@22.1.5` declare
  `engines.node: "^22.22.3 || ^24.15.0 || >=26.0.0"`. This is the first time this repo's
  dependency tree has had a non-trivial opinion about Node. Note what that range
  **excludes**: Node **23** and Node **25** entirely, plus every Node 22 below 22.22.3.
  The repo itself declares **no `engines` field at all**, so nothing records this.
- **Measured, not assumed:**
  - CI (`node-version: '22'`) resolves to **v22.23.2**, above the `22.22.3` floor. Safe
    today, and safe going forward — the 22.x line only moves forward from here.
  - Docker (`node:26-bookworm-slim`) and this workstation (v26.8.1) satisfy `>=26.0.0`.
  - On an excluded version (`node:23-bookworm-slim`, v23.11.1), `npm ci` emits
    `npm warn EBADENGINE Unsupported engine … @angular-devkit/schematics@22.1.5` and
    **still exits 0**. Degradation is noise, not breakage — `engine-strict` is not set
    and there is no `.npmrc`.
- **Chose:** to log this and leave `package.json` untouched. Three reasons: (1) declaring
  `engines` is a repo-wide policy decision, not build tooling, and Phase 9 is scoped to
  build tooling; (2) it has real blast radius — any contributor or CI system running with
  `engine-strict=true` turns today's warning into a **hard install failure**; (3) the
  Node-version question has now surfaced in four separate phases (4, 6, 8, 9) and is an
  open question awaiting the repo owner, so pre-empting it here would decide it by
  accident.
- **Alternatives:** (a) add `"engines": { "node": "^22.22.3 || ^24.15.0 || >=26.0.0" }`,
  mirroring the strictest transitive constraint — most honest, but inherits a range that
  is really `@angular-devkit`'s rather than this service's, and would need revisiting
  whenever that dep moves. (b) Add a looser `">=22.22.3"` reflecting what the service
  itself needs — less churn, but silently permits Node 23/25, which the toolchain
  excludes. (c) Pin CI to an exact Node version instead of the floating `'22'` — narrows
  the drift surface but does not document anything for contributors.
- **Blast radius if wrong:** a contributor on Node 23 or 25 sees EBADENGINE warnings and
  no explanation. Installs still succeed; nothing at runtime is affected. Cost to reverse
  is one line in `package.json`.
- **Status:** UNCONFIRMED — needs a decision on the standing Node-version question
  (raise CI to 26 / declare `engines` / accept the divergence), not a decision about
  Phase 9.
