# Decisions

## 2026-08-28 — Removing the unused `@nestjs/config` dependency (Phase 4, CP-5)
- **Plan:** `plans/wave1-cp-1-4-5-6-7.md`
- **Original assumption:** removing `@nestjs/config@^4.0.0` (declared but zero
  imports anywhere in `src/`) and replacing the broken env-loading with a bare
  `dotenv/config` preload as the first line of `src/main.ts` was safe and the
  strongest long-term fix — see `ASSUMPTIONS.md` for full Assumed/Chose/
  Alternatives/Blast-radius text.
- **Recommendation (Opus, low-blast-radius lane):** confirm as-is. Independent
  re-verification: `grep -rn "@nestjs/config" src/ test/` still zero hits after
  all 5 phases landed; no Docker/CI/docs reference; `dotenv` correctly a direct
  runtime dependency (not dev); `main.ts:1` is the sole `dotenv` reference, no
  duplicate loading; `docs/CONFIGURATION.md` already documents the mechanism
  consistently. Long-term judgment: this repo's own hand-rolled
  `AppConfigService`/`ConfigModule` (`src/config/`) is the established,
  deliberate config pattern (reinforced by the codebase's own convention that
  all `process.env` reads live in `AppConfigService`) — `@nestjs/config` was
  never the intended direction and would collide by name with the local
  `ConfigModule` if ever wired up, and still couldn't reach `main.ts`'s
  pre-`NestFactory` migration path regardless. The dotenv preload is the
  correct permanent mechanism, not a stopgap.
- **Verdict:** Confirmed as-is (human decision, via `/reconcile`).
- **Status:** CONFIRMED.

## 2026-08-30 — CP-5 key rotation status (issue #127)
- **Plan:** `plans/wave1-cp-8-9.md`
- **Question:** issue #127 (filed by an independent two-pass spec-repo audit) flagged
  that Wave 1's CP-5 fix removed the leaked `OPENAI_API_KEY` from `.env`/repo history,
  but removal isn't rotation — no repo-side evidence could confirm the key was actually
  revoked at the provider. This has no defensible code default; only the human who
  holds the provider account can answer it.
- **Asked directly during `/drive` preflight** (not a Fable/Opus recommendation lane —
  this isn't a code judgment call, it's a factual status only the user can confirm).
- **Verdict:** User confirmed the key has been rotated/revoked at the provider.
- **Status:** CONFIRMED. No code change required; CP-5 is closed. `plans/wave1-cp-8-9.md`
  covers only CP-8 and CP-9.

---

## 2026-09-11 — Reconciliation of `plans/dep-migrations-137.md` (issue #137)

Four `UNCONFIRMED` entries, reconciled after the feature merged as `227901d`. Ranked by
blast radius: the `truncateAll` entry first (it issues `TRUNCATE ... CASCADE` over
dynamically discovered tables, so a miss destroys data), the other three are cheap and
reversible. Three were **settled by Opus without escalation**; the destructive one was
analyzed by **Fable**. All four are reopenable from this record.

### 1. Dynamic `pg_tables` truncate discovery — **CONFIRMED**, with a gap closed
- **Decided by:** Fable analysis (destructive operation crossing into "could wipe a real
  database"), accepted by Opus. Not escalated to the user: the analysis found the
  catastrophic case already guarded, so it dropped a tier per the Autonomy ladder rather
  than manufacturing a gate.
- **Assumption:** discovering truncate targets at runtime is safe and strictly better than
  a hardcoded list (which had drifted five tables stale, making the suite non-idempotent).
- **Analysis:** the design is right — the literal list had gone stale twice, and drift in a
  suite gating five phases produces misattributed failures. Going dynamic *did* widen the
  silent-wipe exposure (the old list aborted loudly against a foreign schema), which is
  exactly why `assertTestDatabase` shipped in the same commit (`e07fe6e`) and is
  load-bearing rather than decorative. Net position is stronger than before the change:
  the hardcoded era had **no** guard and would have silently wiped a same-schema
  production database.
- **Gap found:** the entry claimed the guard was "verified by a negative test". It was
  verified **manually, once** — `grep` found zero committed coverage. That matters because
  the guard has a regression history: an earlier revision validated the module's default
  URL while truncating a caller-supplied pool, and wiped a decoy database during phase
  verification.
- **Action taken:** added `test/integration/test-db-guard.integration.spec.ts` (5 tests)
  pinning the refusal, the credential redaction, and that rows survive. Teeth-proved —
  reintroducing the historical URL-vs-connection bug fails 3 of 5, including the
  data-intact assertion. Entry wording corrected.
- **Residual, accepted:** a *foreign* database whose name ends in `_test` still passes.
  Documented in `test/helpers/test-db.ts` and now in `docs/TROUBLESHOOTING.md`. Accepted
  because a `*_test` database is by convention disposable.

### 2. Host port 5433 workaround — **CONFIRMED**, one doc added
- **Decided by:** Opus analysis. Low blast radius; settled without escalation.
- **Verdict:** right call. Moving the published port would have to change
  `docker-compose.test.yml` **and** two lines of `.github/workflows/ci.yml` to work around
  one machine's conflict; `DATABASE_URL` is already first-class in both readers, and
  `git grep 55433` confirms no tracked file encodes the workaround.
- **Gap found:** the *symptom* was undocumented. `docs/TROUBLESHOOTING.md`'s
  `ECONNREFUSED` section offered one cause ("Postgres isn't running"), but a port squatter
  produces a **successful** connect followed by `database "..." does not exist`. Since this
  repo publishes 5433, the collision is structural for anyone running two ACDP-family
  projects.
- **Action taken:** new `docs/TROUBLESHOOTING.md` section covering the squatter symptom,
  the multi-daemon diagnosis, and the `DATABASE_URL` override.

### 3. Deleting `supertest` + `@types/supertest` — **CONFIRMED as-is**
- **Decided by:** Opus analysis. No action needed.
- **Verdict:** the strongest of the four. The analysis tested the four capabilities
  supertest would have bought rather than restating the entry: cookies, redirects and
  multipart have **zero surface** (Bearer/HMAC auth, JSON-only, no `res.redirect` in
  `src/`); SSE — the one real gap — is already served by the purpose-built
  `test/helpers/sse-client.ts`, which supertest could not have replaced anyway since
  superagent buffers to `end`. What remains is `.expect()` sugar that Jest matchers
  already provide, while `TestClient` earns its length on ACDP's `x-acdp-signature` HMAC
  signing.

### 4. Removing `ts-loader` + `tsconfig-paths` — **CONFIRMED**, two corrections
- **Decided by:** Opus analysis. No behavioural change.
- **Verdict:** correct. Traced through the `@nestjs/cli@12` source rather than running a
  destructive build: `loadWebpackDeps()` is the first statement of the webpack defaults
  factory, so `require('webpack')` throws `MODULE_NOT_FOUND` before any config is
  constructed and the action exits 1 — categorically unlike the historical no-emit bug,
  where the compiler ran and wrongly concluded it was up to date.
- **Corrections to the entry:** (a) only **webpack** left the tree —
  `tsconfig-paths@4.2.0` is still installed as a non-optional dependency of
  `@nestjs/cli@12`; removing the devDependency removed the declaration, not the install.
  Verdict unchanged, since no tsconfig declares `paths`. (b) `nest build --webpack`
  **deletes `dist/` before failing**, so "fails loudly" is true but worth stating
  precisely.
- **Note:** the CLI now prints a deprecation notice steering users to rspack, so the
  capability supposedly held in reserve is going away upstream regardless.

**Summary:** 4 confirmed, 0 changed, 0 deferred. 3 settled by Opus without escalation, 1
by Fable analysis that found the catastrophic case already guarded. One code follow-up was
produced and **landed in this same pass** (the guard regression spec); nothing blocks a
future ship.
