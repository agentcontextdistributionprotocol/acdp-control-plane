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
  which refuses any database whose name does not end in `_test`, reading the name
  from `select current_database()` on the pool being truncated rather than from a
  URL. **Correction (2026-09-11):** an earlier wording here claimed this was
  "verified by a negative test". It was verified **manually**, once, during the
  phase — there was no committed coverage, and a guard with a known history of
  regressing (an earlier revision validated the module's default URL while
  truncating a caller-supplied pool, and wiped a decoy database) had nothing
  pinning it. Now automated in
  `test/integration/test-db-guard.integration.spec.ts`, which drives `truncateAll`
  against a live non-`_test` database and asserts the refusal, the credential
  redaction, and that the rows survive. Teeth-proved: reintroducing the historical
  URL-vs-connection bug fails 3 of its 5 tests, including the one asserting the
  data is still there. The remaining failure mode is a future table that must survive
  truncation being cleared — a loud, immediate test failure whose fix is one entry
  in `PRESERVED_TABLES`. Reverting is a single file revert.
- **Verified before landing:** the gate's own repro (`auth-persistence` alone,
  twice: 20/20 both times — it failed on run 2 before this fix), full suite twice
  against one database (24 suites / 151 tests, exit 0 each), unit suite unchanged
  from baseline, and `tsc`/`lint`/`check:conventions` all 0.
- **Status:** CONFIRMED (2026-09-11) — Fable-tier analysis (destructive operation,
  see `DECISIONS.md`). Design upheld; the one gap it found (no committed coverage
  of the guard) is closed by the spec above.

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
- **Status:** CONFIRMED (2026-09-11) — decided by Opus analysis (see `DECISIONS.md`).
  Moving the published port would have to change `docker-compose.test.yml:9` **and**
  `.github/workflows/ci.yml:102,124` to work around one machine's conflict; the
  `DATABASE_URL` escape hatch is already first-class in both readers. The analysis
  found the *symptom* undocumented — `docs/TROUBLESHOOTING.md`'s `ECONNREFUSED`
  section named only "Postgres isn't running", while a port squatter produces a
  *successful* connect followed by `database "..." does not exist`. Documented now.

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
- **Status:** CONFIRMED (2026-09-11) — decided by Opus analysis (see `DECISIONS.md`).
  The analysis checked the four capabilities supertest would have bought rather than
  restating the entry: cookies, redirects and multipart all have **zero surface** in
  this API (Bearer/HMAC auth, JSON-only, no `res.redirect` in `src/`), and SSE — the
  one real gap — is already served by the purpose-built `test/helpers/sse-client.ts`,
  which supertest could not have replaced since superagent buffers to `end`.
  `TestClient` earns its length on ACDP's `x-acdp-signature` HMAC signing, which
  supertest gives nothing for.

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
- **Status:** RESOLVED (2026-09-11) — **decided by the repo owner during the §4
  finalization pass: raise CI to Node 26.** Applied in the finalization commit: all three
  `node-version: '22'` pins (both `ci.yml` jobs + `release.yml`) are now `'26'`, matching
  the Dockerfile's `node:26-bookworm-slim`, with the rationale recorded inline in `ci.yml`
  so it is not silently reverted. CI now validates the same Node major that ships.
  This deferral was raised in phases 4, 6, 8 and 9 before being settled.

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
- **Measured, not assumed** (measurements taken while CI was still pinned to Node 22;
  the §4 pass has since moved all three pins to `'26'` — see the RESOLVED status below,
  and `docs/TROUBLESHOOTING.md` for the current state):
  - CI (then `node-version: '22'`) resolved to **v22.23.2**, above the `22.22.3` floor.
    Safe at the time, and safe going forward — the 22.x line only moves forward.
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
- **Status:** RESOLVED (2026-09-11) — the standing Node-version question was settled in
  favour of **raising CI to Node 26**, not declaring `engines`. That removes the reason
  this entry existed: CI, Docker and the reference workstation now all sit on Node 26,
  comfortably inside the `>=26.0.0` arm of the transitive floor, so nothing in the
  pipeline can trip it. `package.json` still declares no `engines` field — deliberately,
  and now harmlessly, since no environment this project controls is outside the range.
  The residual case is a contributor on Node 23 or 25, who sees `EBADENGINE` **warnings**
  with `npm ci` still exiting 0; that is documented in `docs/TROUBLESHOOTING.md` under
  "`npm warn EBADENGINE Unsupported engine` on install". Revisit only if someone wants a
  hard floor enforced at install time.

## Removing `ts-loader` and `tsconfig-paths` rather than keeping them for a possible webpack build (§4, issue #137)
- **Plan:** `plans/dep-migrations-137.md`
- **Assumed:** nothing in this repo builds through webpack, now or in the near future, so
  the two devDependencies that exist only to serve that path are dead weight rather than
  a capability held in reserve.
- **Measured, not assumed:**
  - `git grep` over the whole tree finds `ts-loader`/`tsconfig-paths` **only** in
    `package.json` itself and in plan/PROGRESS prose describing CLI peer changes. No
    source, config, script, workflow or Dockerfile reference.
  - `nest-cli.json` sets only `deleteOutDir`; it never enables `"webpack": true`, and no
    npm script passes `--webpack`. `nest build` therefore runs tsc.
  - No tsconfig in the repo declares `paths`, and `baseUrl` was deleted in Phase 8 — so
    `tsconfig-paths` cannot be doing anything even in principle.
  - Removing both dropped **648 lines** of `package-lock.json` and took `webpack@5.107.2`
    with it: `npm ls webpack` goes from a populated tree to `(empty)`. `@nestjs/cli@12`
    declares webpack an **optional** peer, so `ts-loader` was the sole installer.
  - `npm run check:build` still emits **133** `.js` files across both builds, unchanged.
- **Chose:** delete both, consistent with the "delete, don't bump" ruling this plan already
  applied to `uuid`, `nestjs-pino`, `pino-http` (Phase 1) and `supertest`/`@types/supertest`
  (Phase 4). Those sweeps simply missed these two.
- **Alternatives:** keep them so `nest build --webpack` stays available without a reinstall.
  Rejected: Phase 9 recorded that path as broken and unused, and carrying a whole webpack
  toolchain in the lockfile to preserve an untested build mode is a supply-chain and
  install-time cost for no current benefit. Re-adding is one `npm i -D` away.
- **Two corrections (2026-09-11), from the reconcile analysis:**
  1. The measurement above says removal "took `webpack@5.107.2` with it", which is
     true, but the entry reads as though **both** packages left the tree. Only
     webpack did. `tsconfig-paths@4.2.0` is **still installed**, as a *non-optional*
     `dependency` of `@nestjs/cli@12.0.0` — `npm ls tsconfig-paths` still resolves
     it and `node_modules/tsconfig-paths` exists. Removing the direct devDependency
     removed the *declaration*, not the *install*. The verdict is unchanged, since
     the package is inert either way with no `paths` declared anywhere.
  2. `nest build --webpack` **deletes `dist/` before it fails**
     (`@nestjs/cli` `build.action.js` runs `deleteOutDirIfEnabled` ahead of the
     builder). It still exits 1 with a named "webpack package is required" error on
     stderr, so the failure is loud — but the claim "fails loudly rather than
     degrading silently" is worth stating precisely, given this repo was previously
     bitten by a build that exited 0 while emitting nothing. The distinction holds:
     there the compiler ran and concluded it was up to date, whereas here the
     compiler is never constructed.
- **Blast radius if wrong:** low and immediately visible. If anyone wants a webpack build,
  `nest build --webpack` fails at once with a missing-loader error rather than degrading
  silently. Nothing in CI, Docker or the runtime touches either package.
- **Status:** CONFIRMED (2026-09-11) — decided by Opus analysis (see `DECISIONS.md`).
  Traced through the `@nestjs/cli@12` source: `loadWebpackDeps()` is the first
  statement of the webpack defaults factory, so `require('webpack')` throws
  `MODULE_NOT_FOUND` before any config is built and the action exits 1. The CLI now
  also prints a deprecation notice steering users to rspack, so the capability
  supposedly held in reserve is going away upstream regardless.

## `KEY_REVOCATION_ATTESTED_SCOPE` does not gate persistence, only future consumption (Phase 12, RFC-ACDP-0014)
- **Plan:** `plans/rfc-0014-0015-upgrade.md`
- **Assumed:** the plan's Phase 12 Approach step 5 literally says to "apply the §6
  policy: run `crossCheckRegistryBinding` … and honour `KEY_REVOCATION_ATTESTED_SCOPE`"
  as part of the persistence-gating step — read narrowly, this could mean the scope
  value itself (`same_registry` | `global` | `off`) should decide whether a
  `registry_attested` revocation gets written to `key_revocations` at all (e.g.
  `off` suppressing persistence entirely).
- **Chose:** persistence is gated **only** by the `crossCheckRegistryBinding` outcome
  (does `publisher` match both the serving authority's did:web form and the
  registry's advertised `capabilities.registry_did`?) — `KEY_REVOCATION_ATTESTED_SCOPE`
  has no effect on whether a fact is written, and is deferred entirely to Phase 14's
  consumption-time classification (`classifyUnderRevocation` / the §7 disarm check),
  where it governs whether a *recorded* registry-attested revocation's effect is
  applied for a producer outside the serving registry (`global`) or suppressed
  (`same_registry`/`off`). Three things point the same way: (1) the acceptance
  criteria are literal on this — AC6 tests a binding **failure** not persisting under
  `same_registry`, AC7 tests a binding **pass** persisting under `global` and states a
  binding failure is never persisted "under any scope" — neither criterion actually
  requires scope to gate a *passing* binding check; (2) RFC-ACDP-0014 §6 frames scope
  as governing when a revocation's effect is *applied* during consumption, not whether
  the underlying fact is recorded as evidence — collapsing the two would mean a
  deployment running `KEY_REVOCATION_ATTESTED_SCOPE=off` has literally no record that
  a registry ever attested a revocation, which is worse for later forensics/incident
  response than recording it inertly; (3) it matches this repo's existing pattern for
  §13 cross-producer revocations (Phase 12's own Edge-cases section: record the
  evidence regardless, apply `KEY_REVOCATION_IGNORE_FINGERPRINTS` only at
  classification time) — scope-gating persistence would be the one place evidence
  collection and enforcement got conflated.
- **Alternatives:** (a) Gate persistence directly on scope (e.g. skip the write
  entirely when `scope==='off'`) — rejected: makes `off` destroy evidence rather than
  merely decline to act on it, and would need Phase 14 to re-derive facts it can no
  longer see if the scope config later changes. (b) Store scope-at-verification-time
  on the row and let Phase 14 re-filter — rejected: redundant, since
  `KEY_REVOCATION_ATTESTED_SCOPE` is a live deployment-wide config Phase 14 reads
  directly at classification time; snapshotting it per-row buys nothing and adds a
  column with no reader.
- **Blast radius if wrong:** Medium. If scope was meant to gate persistence, a
  deployment running `same_registry` (the strictest setting) would have
  `key_revocations` rows for registry-attested revocations Phase 14 should never have
  acted on in the first place — but Phase 14's own classification step re-applies the
  cross-check via the stored `publisher`/`trust_class` columns (never collapsed, per
  §6), so an over-broad *fact* store does not by itself cause an over-broad
  *enforcement* outcome; the exposure is a forensic-visibility one (evidence exists
  that a stricter reading would have discarded), not a false-authorization one.
  Reversible by adding a scope filter to the persistence step in a follow-up phase; no
  migration required since the columns already needed to make that decision
  (`trust_class`, `publisher`) are already stored on every row.
- **Status:** UNCONFIRMED

## Adding a manual `signature.key_id` DID-binding check for did:web revocation signers (Phase 12, RFC-ACDP-0014)
- **Plan:** `plans/rfc-0014-0015-upgrade.md`
- **Assumed:** Phase 12's Approach step 3 is silent on whether the resolved signing
  key's DID must be checked against the revocation body's own `agent_id` — it only
  says to resolve `signature.key_id` through `DidWebResolverService.resolveKey` and
  verify with `verifySignatureB64`, which on its own proves the signature is valid
  for *some* key that DID document currently authorizes, not that the key belongs to
  the agent the body claims to be from.
- **Chose:** added an explicit check in `revocation-audit.service.ts` that the
  DID portion of `signature.key_id` (stripped of its `#fragment`) equals
  `body.agent_id`, rejecting on mismatch, mirroring the Rust reference
  implementation's signature-envelope binding step. Without it, a `did:web`
  producer with a validly-resolvable key could sign a revocation body whose
  `agent_id` names a *different* did:web producer, and the pipeline as spec'd would
  still resolve+verify the signature successfully (DID resolution only depends on
  `key_id`, never cross-checks it against `agent_id`) — a forged-attribution gap for
  exactly the same class of "who really said this" confusion §13's stored `publisher`
  column exists to defend against.
- **Alternatives:** (a) Omit the check, matching the plan's literal step 3 word for
  word — rejected: it's a real signature-forgery-adjacent gap the Rust reference
  implementation explicitly guards against, not a stylistic omission. (b) Rely on
  `AcdpVerifier.parseKeyRevocation`'s own checks to catch it — rejected: confirmed by
  reading `acdp-types/src/revocation.rs` that `parseKeyRevocation` only checks
  §4 shape and §5 step 2 (not-self-signed), never the signer-vs-agent_id binding; that
  check exists in the Rust client reference path, not inside the parse function this
  binding exposes.
- **Blast radius if wrong:** Low. If this check is somehow too strict (e.g. a future
  legitimate multi-agent delegation pattern where one did:web identity signs on
  behalf of another), it would reject at verification time with a clear, logged
  reason (always `status="invalid"` — this check has no transient outcome, unlike
  the fetch/DID-resolution failures elsewhere in the pipeline) rather than silently
  misattributing a revocation — a false negative, not a false positive, and one
  visible immediately in `acdp_key_revocation_checks_total{status="invalid"}` plus
  the per-event warn log. Reversible by deleting the one comparison.
- **Status:** UNCONFIRMED

## A single shared lookback window for both permanent and transient revocation-verification failures (Phase 12, RFC-ACDP-0014)
- **Plan:** `plans/rfc-0014-0015-upgrade.md`
- **Assumed:** a literal reading of Phase 12's revised Edge-cases text ("permanent
  failures... let the event age out of the [ordinary, 24h] window... transient
  failures... give the revocation sweep its own [720h]
  `KEY_REVOCATION_LOOKBACK_HOURS`") describes two DIFFERENT candidate-selection
  windows, one per failure class.
- **Chose:** implemented one shared window — `KeyRevocationRepository.findCandidates`
  takes a single `since` cutoff, `Date.now() - KEY_REVOCATION_LOOKBACK_HOURS` (720h),
  applied uniformly to every not-yet-persisted candidate. Reason: nothing about a
  failed verification is persisted anywhere (no `key_revocations` row, no marker
  table), so a later sweep has no way to distinguish "this ctx_id was checked last
  week and permanently rejected" from "this ctx_id was checked last week and
  transiently failed" from "this ctx_id has never been checked" — they are the exact
  same row in `context_events`, indistinguishable without first building the very
  processed-marker mechanism the plan's own revision explicitly moved away from (see
  the plan's Phase 12 Edge-cases section: "The original decision here... is revised"
  away from a processed-marker design). Applying the wide 720h window to every
  candidate is strictly SAFER than the two-window reading, never less safe: every
  transient failure gets the full 30 days the plan requires, and a permanently-bad
  revocation is merely re-verified to the same conclusion a few extra times before it
  ages out, at the cost of wasted federation GETs and log noise — never a false
  positive or a lost revocation.
- **Alternatives:** (a) Build a lightweight persisted marker (a bare
  `(tenant_id, ctx_id, verdict, checked_at)` row per outcome, success or failure) so
  a narrower window can apply to `invalid` specifically — the literally-correct
  reading of the revised text, but it reintroduces exactly the processed-marker
  design the plan explicitly reconsidered and moved away from, and does so for a
  pure efficiency win (bounded, and cheap to defer) rather than a correctness one.
  Better done once, deliberately, in a phase that owns the sweep's candidate-query
  shape more broadly (Phase 13 touches the sibling lineage-walk query) than added as
  a late addition here. (b) Leave the 24h `RECEIPT_AUDIT_LOOKBACK_HOURS` governing
  permanent failures and only widen the window for transient ones by re-querying with
  two different cutoffs and merging — rejected as needless complexity for the same
  reason: it requires knowing a candidate's classification BEFORE selecting it, which
  requires the marker table alternative (a) already covers.
- **Blast radius if wrong:** Low, and purely an efficiency one. At meaningful scale —
  many permanently-invalid revocation events older than a legitimate newer one, all
  within one `RECEIPT_AUDIT_BATCH_SIZE`-sized page (default 50) — the oldest-first,
  no-marker candidate query can let known-bad events crowd out a genuinely new
  candidate further back in the same batch for multiple sweep passes; bounded by the
  batch size and the sweep interval, and self-correcting once the bad events age past
  30 days. No data-integrity or security exposure either way. Reversible by adding
  the marker table from alternative (a) without a breaking schema change (an
  additive table, not a modification to `key_revocations`).
- **Status:** UNCONFIRMED

## ecdsa-p256 revocation signers are inconsistently, and only partially, handled (Phase 12, RFC-ACDP-0014)
- **Plan:** `plans/rfc-0014-0015-upgrade.md`
- **Assumed:** RFC-ACDP-0014's golden conformance vectors and this phase's own
  Acceptance Criteria are Ed25519-only, so full P-256 support was out of this phase's
  scope — but the pipeline still needed to decide what happens when a P-256 signer
  IS encountered, rather than silently mishandling it.
- **What is actually implemented, and why it is inconsistent.** A `did:web`
  P-256 signer's algorithm check
  (`revocation-audit.service.ts`, the `algorithm !== 'ed25519'` branch) fails closed
  as `status="unavailable"` — reasoned at the time as "a capability gap, not a
  rejection" (no SDK P-256 fingerprint helper exists for a revocation body, the same
  gap `receipt-audit.service.ts` already documents for receipts). But a `did:key`
  P-256 signer never reaches that branch at all: `decodeEd25519Multibase` (the ONLY
  did:key decoder in this repo, `src/common/multibase.ts`) refuses any multicodec
  prefix other than Ed25519's `0xed01`, so a P-256 did:key body is rejected as
  `status="invalid"` at the multibase-decode step, well before an algorithm gets a
  chance to be checked explicitly. The result: a `did:web` P-256 revocation is
  retried harmlessly for 30 days and then silently lost (logged at `debug`, the
  "we never saw it" bucket) — the wrong side of the very "we rejected it vs we never
  saw it" distinction Phase 12's Edge-cases section says operators need — while a
  `did:key` P-256 revocation is actively, permanently REJECTED as though it failed
  verification, which is also wrong: a validly-signed P-256 revocation is real
  evidence of a compromise, not an invalid body.
- **Chose:** leave both paths as implemented rather than block Phase 12 on full P-256
  support (a materially bigger change: a P-256 multibase multicodec, a P-256
  fingerprint helper matching `fingerprintEd25519B64`'s shape, and a did:web P-256
  resolution+verification path) — but log the gap honestly here instead of letting
  the code comment's "capability gap, not a rejection... logged to ASSUMPTIONS.md"
  claim be false, which it was until this entry was added during the Phase 12
  verification-gate gap closure.
- **Alternatives:** (a) Add full P-256 revocation support now — rejected as scope
  creep beyond what Phase 12's Acceptance Criteria or the golden conformance vector
  require; ecdsa-p256 producers are a minority path across this whole codebase
  (receipt audit has the identical unresolved gap). (b) Make BOTH paths fail the same
  way (`unavailable`, treating a P-256 did:key body identically to a P-256 did:web
  one) by teaching `decodeEd25519Multibase`'s caller to recognise a P-256 multicodec
  prefix specifically and short-circuit to `unavailable` before the generic
  "unsupported key algorithm" rejection — the more consistent fix, and cheap (one
  early multicodec-prefix check), but still leaves P-256 revocations fully
  unverifiable either way, so deferred alongside (a) rather than half-fixed here.
- **Blast radius if wrong:** Medium for a P-256-only deployment specifically. A
  did:key-based P-256 producer's genuine revocation is misreported as `invalid`
  (wrong reason, but the practical effect — the revocation does not get acted on
  automatically — is arguably still the safer failure than silently losing it) while
  a did:web-based P-256 producer's genuine revocation is silently lost after 30 days
  with only a debug-level log line (the more dangerous of the two, since nothing
  operator-visible fires when a real compromise signal ages out unacted-on). No
  exposure for the (currently exclusively Ed25519) golden conformance path or any
  did:key/did:web Ed25519 producer. Reversible/fixable by either alternative above,
  neither of which touches `key_revocations`' schema.
- **Status:** UNCONFIRMED
