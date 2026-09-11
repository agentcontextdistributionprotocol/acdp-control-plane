# Progress — wave1-cp-1-4-5-6-7

Plan: `plans/wave1-cp-1-4-5-6-7.md`

## Repo map (discovery notes for `/implement` — don't re-scan)

- `package.json:23` — unused scoped `acdp` dep (`^0.8.0`) to delete (CP-1).
- `package.json:37` — the `acdp` npm alias (`npm:@agentcontextdistributionprotocol/acdp@^0.7.0`)
  every source import actually uses; bump to `^0.8.1` (CP-1).
- `.github/workflows/bump-acdp.yml` — `package:` input already correctly targets the scoped
  registry name `@agentcontextdistributionprotocol/acdp` (CP-1 leaves this unchanged, just adds
  an explanatory comment — an earlier plan draft called for changing it to `'acdp'`; Phase 1's
  verification gate caught that this would break `bump-consume.yml`'s registry lookups and
  corrupt the alias on rewrite; see plan Phase 1 for the full trace).
- `src/audit/cosign.ts:1-20` — RFC-ACDP-0015 cosign; doc comment at line 14 hardcodes stale `^0.7.0` (CP-4).
- `src/audit/log-verify.ts:1-15` — RFC-ACDP-0012 log verify; doc comment at line 7 hardcodes stale `^0.7.0` (CP-4).
- `.env` (gitignored, not committed) — line 8 holds a live `OPENAI_API_KEY`; lines 8-13 are
  playground-owned LLM vars to remove (CP-5). **Never print/copy the value.**
- `src/main.ts` — `bootstrap()` defined then called at file end; manual
  `new AppConfigService()` at ~line 14, `runMigrations()` at ~line 17, `NestFactory.create(AppModule)`
  at ~line 27. Add `import 'dotenv/config';` as the literal first line (CP-5).
- `src/config/config.module.ts` — hand-rolled `@Global()` module, just provides/exports
  `AppConfigService`; NOT `@nestjs/config`'s module. Leave as-is.
- `@nestjs/config@^4.0.0` in `package.json` deps — declared, zero imports anywhere in `src/`
  (confirmed via grep), dead weight from an abandoned earlier attempt at CP-5's fix; remove it.
- `README.md:50-58` — quick-start block (`cp .env.example .env && npm run start:dev`); becomes
  literally true once CP-5 lands, confirm no other hedging text nearby.
- `docs/CONFIGURATION.md:1-20` — intro explains *where* env is parsed (`AppConfigService`) but not
  *how* `.env` loads; add one line once CP-5's loader lands.
- `src/config/app-config.service.ts` — `validate()` method ~line 346-400+; `authApiKeys` throw at
  ~line 364 is the pattern to mirror; `webhookSecret` warn-only branch at ~line 370 is CP-6's target;
  `isDevelopment` short-circuit at ~line 362 gates the whole production-only block.
- `src/config/app-config.service.spec.ts` — existing `'throws when AUTH_API_KEYS is empty in
  production'` test ~line 64 is the template for CP-6's new test; `'passes validation when
  everything is set'` ~line 85-91 already sets `WEBHOOK_SECRET='shh'`, should stay green.
- `src/ingest/hmac.ts:15` — `if (!secret) return true;`, correct dev-mode behavior, NOT touched by
  CP-6 (fix is at the config-validation boundary instead).
- `.github/workflows/ci.yml` — `unit` job: checkout → setup-node → `npm ci` → conventions script →
  lint → tsc → jest (env `NODE_ENV: test`) → coverage upload. Add second pinned `actions/checkout@v5`
  (spec repo, `path: acdp-spec`) + `ACDP_SPEC_DIR`/`ACDP_REQUIRE_CONFORMANCE` env on the jest step (CP-7).
- Reference pattern for CP-7's checkout step: `/Users/ajitkoti/code/agentcontextdistributionprotocol/acdp-rs/.github/workflows/ci.yml`'s
  `conformance:` job, lines ~63-88.
- Reference pattern for CP-7's require-mode: `/Users/ajitkoti/code/agentcontextdistributionprotocol/acdp-rs/tests/conformance.rs`'s
  `spec_root()`/`require_conformance()`, lines ~17-71 (Rust `assert!`-on-require semantics to mirror,
  but placed in a `beforeAll` in TS — see plan Phase 5 Approach for why not in the locator function).
- `src/audit/cosign.spec.ts` — fixture locator ~line 39-47, `describeGolden` gate ~line 143-148;
  golden `describe` block starts ~line 149 (wit-001..004).
- `src/audit/log-verify.parity.spec.ts` — `conformanceDir()` ~line 35-46, `describeOrSkip` gate
  ~line 71; golden tests cover log-001 (leaf/root/inclusion) and log-003 (consistency).
- `scripts/ci-conventions.sh` — `check()` greps `src --include='*.ts'` only; confirmed safe against
  a new `acdp-spec/` checkout dir at workspace root (outside `src/`).
- Spec repo HEAD SHA to pin (as of this plan, 2026-08-28):
  `bff3cf3afbdcea619834916e8f0bcac7e82ba658` (`/Users/ajitkoti/code/agentcontextdistributionprotocol/agentcontextdistributionprotocol`).
- `package.json` jest config: `rootDir: src`, coverage thresholds `statements:70 branches:58
  functions:55 lines:70`, `testRegex: .*\.spec\.ts$`.
- `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/CONFIGURATION.md`, `docs/TESTING.md`,
  `docs/TROUBLESHOOTING.md` exist; only `CONFIGURATION.md` needs a touch (CP-5).
- No `CLAUDE.md` in this repo — governing conventions doc is
  `/Users/ajitkoti/code/agentcontextdistributionprotocol/acdp-ci/DELIVERY-STANDARD.md`.

## Phase checkpoint log

### Phase 1 — CP-1 (collapse duplicate aliased `acdp` dep)
- **Verdict:** DONE (PASS after 2 verify rounds)
- **Verifier tier:** Opus (per user's tiering: Opus for CP-1) — fresh subagent both rounds
- **Rounds:** 2. Round 1 → GAPS (one blocker: plan's own `bump-acdp.yml` change was wrong —
  see plan Phase 1 for the full trace of why `package: 'acdp'` breaks `bump-consume.yml`).
  Round 2 → PASS, no new issues beyond a `dependabot.yml` wording nit (fixed).
- **Gap summary:** round 1 — (a) `bump-acdp.yml`'s `package:` input must stay the scoped
  registry name, not the alias, or the auto-bump workflow 404s and corrupts the alias on
  rewrite; (b) `dependabot.yml`'s `acdp-sdk` group had a stale comment + a pattern for the
  now-deleted scoped dependency entry; (c) plan's own acceptance criterion for `npm ls
  @agentcontextdistributionprotocol/acdp` is unsatisfiable by npm's alias-matching behavior,
  needed a documented substitute.
- **Files touched:** `package.json`, `package-lock.json`, `.github/workflows/bump-acdp.yml`,
  `.github/dependabot.yml`, `plans/wave1-cp-1-4-5-6-7.md` (corrections + Status: DONE),
  `PROGRESS.md` (this entry).
- **What's next:** Phase 2 (CP-4) — now also covers `src/audit/cosign.spec.ts`'s stale
  `0.7.0` narration (found during Phase 1's verification, folded into Phase 2's scope).

### Phase 2 — CP-4 (drop stale pin narration)
- **Verdict:** DONE (PASS after 2 verify rounds)
- **Verifier tier:** Sonnet (per user's tiering: Sonnet for CP-4, tiny fix) — fresh
  subagent both rounds
- **Rounds:** 2. Round 1 → GAPS: original 3-file scope missed a 4th identical-defect
  instance at `log-verify.parity.spec.ts:76`. Round 2 → PASS after fix + a broader
  repo-wide sweep found no further instances.
- **Files touched:** `src/audit/cosign.ts`, `src/audit/log-verify.ts`,
  `src/audit/cosign.spec.ts`, `src/audit/log-verify.parity.spec.ts`,
  `plans/wave1-cp-1-4-5-6-7.md` (scope correction + Status: DONE), `PROGRESS.md`.
- **What's next:** Phase 4 (CP-5).

### Phase 3 — CP-6 (ingest HMAC fails open in production)
- **Verdict:** DONE (PASS, round 1)
- **Verifier tier:** Sonnet (per user's tiering: Sonnet for CP-6, tiny fix)
- **Rounds:** 1, clean PASS. Verifier independently re-ran full suite/tsc/lint/conventions
  and the manual boot smoke test (rebuilt `dist/` first, confirmed both negative — throws
  without WEBHOOK_SECRET — and positive — no throw with it set — cases).
- **Files touched:** `src/config/app-config.service.ts` (warn → throw), 
  `src/config/app-config.service.spec.ts` (new test + 2 existing tests fixed to set
  `WEBHOOK_SECRET`), `docs/CONFIGURATION.md` (moved WEBHOOK_SECRET from Warns to Throws
  list, updated its variable-table entry).
- **What's next:** Phase 4 (CP-5) — secret hygiene + env-loading, Fable verify tier.

### Phase 4 — CP-5 (secret hygiene + env-loading fix)
- **Verdict:** DONE (PASS, round 1)
- **Verifier tier:** Fable (per user's tiering: secret-adjacent, highest-scrutiny gate)
- **Rounds:** 1, clean PASS. Verifier independently redid the entire boot-order proof
  (own Postgres container, own distinct marker port 39463 vs. executor's 39217),
  ran a repo-wide secret-leak sweep (count-only/length-only greps, never printing the
  value) across git status/diff, plans/, PROGRESS.md, ASSUMPTIONS.md, shell history,
  and gitignored dirs — zero leaks found. Confirmed dotenv's no-op-when-absent and
  never-overrides-platform-env behavior empirically.
- **Secret handling:** `.env:8`'s `OPENAI_API_KEY` value was never printed, logged,
  copied, or committed at any point this session — line-number-based `sed` deletion
  was used specifically to avoid the value ever appearing in a tool-call parameter.
  **HUMAN ACTION REQUIRED: this key must still be rotated by hand — the secret value
  itself was not touched, only removed from this repo's local, gitignored `.env`.**
- **Files touched:** `.env` (gitignored, not committed — LLM vars removed), `src/main.ts`
  (dotenv preload), `package.json`/`package-lock.json` (`dotenv` added, `@nestjs/config`
  removed), `docs/CONFIGURATION.md` (loading-mechanism paragraph), `ASSUMPTIONS.md`
  (new file, `@nestjs/config`-removal logged UNCONFIRMED), `plans/wave1-cp-1-4-5-6-7.md`
  (Status: DONE), `PROGRESS.md`.
- **What's next:** Phase 5 (CP-7) — CI parity-suite fix, Sonnet verify tier.

### Phase 5 — CP-7 (parity suites never run in CI)
- **Verdict:** DONE (PASS, round 1)
- **Verifier tier:** Sonnet (per user's tiering: CI/CD-shaped), with mandatory
  independent local re-verification (positive + negative case) — the phase's own
  CI-confirmed acceptance bar, not skipped despite the cheap gate tier.
- **Rounds:** 1, clean PASS. Verifier independently redid both the pinned-worktree
  positive case (fresh path, `bff3cf3afbdcea619834916e8f0bcac7e82ba658`, 26/26 tests
  executing) and the isolated-copy negative case (fresh path, no reachable sibling
  spec dir, exit 1, 18 failed/8 passed with the exact thrown message) — identical
  results both times.
- **Files touched:** `.github/workflows/ci.yml` (pinned spec checkout +
  `ACDP_SPEC_DIR`/`ACDP_REQUIRE_CONFORMANCE`), `src/audit/cosign.spec.ts` and
  `src/audit/log-verify.parity.spec.ts` (require-mode `beforeAll` throw),
  `plans/wave1-cp-1-4-5-6-7.md` (Status: DONE), `PROGRESS.md`.
- **All 5 phases now DONE.** Plan complete.

### Ship
- Rebased onto `origin/main` (which had moved by one commit — a Dependabot bump of
  the unused scoped `acdp` dependency 0.8.0→0.8.1, live proof of CP-1's exact defect).
  Resolved conflicts in `package.json`/`package-lock.json` (deleted the scoped entry
  per CP-1, regenerated lockfile). Ship-level Fable gate found 2 doc-drift gaps
  (`docs/INGEST.md`, `docs/ARCHITECTURE.md` — stale "warns at boot" language re: CP-6);
  fixed, re-verified PASS.
- `/reconcile`: 1 UNCONFIRMED entry (`@nestjs/config` removal), recommended
  confirm-as-is by Opus, confirmed by human, logged to `DECISIONS.md`.
- pushed feat/wave1-cp-1-4-5-6-7 1c78c3f68803bd4fe05c69d4db4cd4579a13c014
- PR #120 opened: https://github.com/agentcontextdistributionprotocol/acdp-control-plane/pull/120
- CI green (unit, integration, docker build — all pass, `mergeStateStatus: CLEAN`)
- merged #120 (squash) at ffb3a99. Local `main` fast-forwarded, feature branch deleted
  (local + remote). No post-merge deploy triggered — `release.yml` is tag-triggered
  (`push: tags: ['v*']`) only; deploying this requires a human to cut a version tag
  separately, which is a human-assisted action outside this plan's scope.

---

# Progress — wave1-cp-2

Plan: `plans/wave1-cp-2.md`

## Phase 1 — CP-2 (witness surface on a Final RFC): verification-only, no diff

- **Verdict:** DONE (PASS, round 1). Both CP-2's named dependencies — CP-1 (dependency
  collapse to family version 0.8.1) and CP-4 (drop stale pin-narration comments) — were
  already merged in Wave 1 (PR #120) before this item was picked up, so investigating
  found CP-2's entire accept bar already satisfied on `main`. No phase produced a code
  change; this is a re-verification pass, per CP-2's own text ("re-run the integration
  suite against the current binding... post-CP-1").
- **Verifier tier:** fresh general-purpose subagent, independent re-run of every check
  (not a trust-the-executor pass) — appropriate given the conclusion was "nothing to
  ship," which is exactly the kind of claim that needs independent confirmation before
  being reported as done.
- **Rounds:** 1, clean PASS. Independently confirmed: single `acdp@0.8.1` resolution;
  no stale pin/Draft wording in `cosign.ts`/`log-verify.ts` or anywhere else in `src/`/
  `docs/` (repo-wide grep sweep); witness-cosigning + log-witness integration specs
  green (14/14, throwaway Postgres on port 5434, port-5433's unrelated
  `aitp-control-plane` container left untouched); golden parity specs green in
  require-mode against a pinned spec worktree (26/26); and, straight from the pinned
  spec checkout, `rfcs/RFC-ACDP-0015-witness-cosigning.md:6` reads
  `Status: Community Standards Track (Final)` — confirming the "Final RFC" premise
  itself, not just the code's reaction to it.
- **CI evidence:** PR #120's own CI run (unit/integration/docker all green, head
  `ffb3a99`) — https://github.com/agentcontextdistributionprotocol/acdp-control-plane/actions/runs/33229700606
  — plus PR #122 (an unrelated Dependabot bump merged 2026-08-29, `main` now at
  `4ecb009`), whose CI reran the same three jobs green against the unchanged `0.8.1`
  pin — https://github.com/agentcontextdistributionprotocol/acdp-control-plane/pull/122.
- **Files touched:** none in `src/`/`docs/`. Only `plans/wave1-cp-2.md` (new, local-only,
  git-ignored) and this `PROGRESS.md` entry.
- **No PR opened.** Nothing to ship — `/ship`'s own "clean tree, nothing to ship" rule
  applies once you look past the local scratch files (`.drive.lock`, `ASSUMPTIONS.md`,
  `DECISIONS.md`, `PROGRESS.md`), none of which are part of the diff.
- **What's next:** CP-2 closed. No human action required (unlike CP-5's still-open key
  rotation, which remains outstanding from Wave 1).

---

# Progress — wave1-cp-3

Plan: `plans/wave1-cp-3.md`

## Phase 1 — CP-3 (anchors passthrough check, RFC-ACDP-0016): one new test, no prod code

- **Verdict:** DONE (PASS, round 1). CP-3 was a verification task, not feature work:
  confirm no closed DTO/validator on any publish/retrieved-context body path rejects the
  new `anchors` field. Investigation found the repo already satisfies this by
  construction — the ingest path has no schema at all (`JSON.parse` into a plain
  interface, stored verbatim in a `jsonb` column), and the federation proxy is a raw-text
  byte-for-byte relay. The only genuinely open accept-criterion item — "a test proves
  both" — needed a real diff, so one integration test was added (no production code
  touched).
- **Verifier tier:** fresh general-purpose subagent, independent re-derivation of every
  claim (re-read the ingest/federation code cold, re-grepped every `fetch`/`new URL` call
  site in `src/`, re-ran the full `ingest.integration.spec.ts` suite against its own
  throwaway Postgres, re-ran lint/conventions) — same bar as CP-2's verification, since
  "no code change needed beyond a test" is exactly the kind of claim worth confirming
  independently rather than trusting.
- **Rounds:** 1, clean PASS.
- **What was verified:**
  - `POST /ingest/acdp` has no `ValidationPipe`/DTO on the body — reads `req.rawBody`
    manually, `JSON.parse`s into `AcdpWebhookEvent` (plain TS interface, no runtime
    schema), and `EventProcessorService.process` stores the whole parsed object verbatim
    into `rawPayload` (`jsonb` column) — `anchors` reaches storage untouched.
  - The repo's one global `ValidationPipe({ whitelist: true })` (`main.ts`) only strips
    fields on `@Body()`/`@Query()` DTO-typed params; ingest never uses `@Body()`. No
    `src/dto/*` file sits on a publish or retrieved-context body path.
  - `GET /contexts/*` (federation proxy) never JSON-parses/reserializes the upstream
    body — raw bytes → text → `res.send()`, so `anchors` in a retrieved context passes
    through by construction.
  - Every `fetch(...)`/`new URL(...)` call site in `src/` (grepped exhaustively) is
    built from config, a DB-table lookup, or a caller path param — never from
    event-payload/body content. No code path reads `anchors[].uri`, satisfying
    RFC-ACDP-0016 §6's MUST-NOT-dereference rule by construction; proven with a grep,
    no new guard code added (nothing was ever reachable to guard).
- **New test:** `test/integration/ingest.integration.spec.ts` — "preserves an
  anc-001-shaped anchors array byte-identically through ingest and retrieval
  (RFC-ACDP-0016)" — shape lifted from the spec's
  `schemas/conformance/anc-001-well-formed-anchor.json` fixture. POSTs a payload with one
  well-formed `macp.commitment` anchor + matching `content_hash`, GETs
  `/runs/:runId/events`, asserts `rawPayload.content_hash`/`rawPayload.anchors`
  deep-equal what was sent. Full suite (11/11) PASS against a throwaway Postgres (port
  5434 for my run, port 5435 for the independent verifier's run) — the unrelated
  `aitp-control-plane-postgres-test` container on port 5433 was left untouched by both.
- **Files touched:** `test/integration/ingest.integration.spec.ts` (+36 lines, only
  tracked-file change). `plans/wave1-cp-3.md` (new, local-only) and this `PROGRESS.md`
  entry.
- **Docs:** none needed — `docs/INGEST.md`'s existing "unknown fields preserved in
  raw_payload" line already covers this generic guarantee; no new field-specific
  behavior was introduced.
- **Shipped:** pushed `test/cp-3-anchors-passthrough` (`c023f4c`), opened PR #124, CI
  green (unit/integration/docker all `pass`), squash-merged `bf2deda` on
  2026-08-30T05:57:18Z, branch deleted. No deploy workflow triggers on a bare push to
  `main` in this repo (`release.yml` is tag-triggered; `notify-website.yml` only fires on
  `docs/**` path changes, which this diff didn't touch) — nothing further to watch.
- **What's next:** CP-3 closed. Report back to the requesting session with PR #124.

# Progress — dealias-acdp

Plan: `plans/dealias-acdp.md` (issue #123)

## Repo map (discovery notes for `/implement` — don't re-scan)

- `package.json:35` — sole `npm:` alias declaration: `"acdp":
  "npm:@agentcontextdistributionprotocol/acdp@^0.8.3"`. Replace with
  `"@agentcontextdistributionprotocol/acdp": "^0.8.3"`, same alphabetical slot (scoped
  names sort before lowercase keys in this file's existing ordering).
- 15 import sites, all `import { ... } from 'acdp'` (zero `require('acdp')` hits), no
  re-export/barrel wrapper exists — each site is edited directly:
  `src/witness/witness-signing.service.spec.ts:10`, `src/auth/acdp-verify.ts:17`,
  `src/auth/acdp-verify.spec.ts:9`, `src/auth/did-web/did-web-resolver.service.ts:35`,
  `src/auth/did-web/ssrf-guard.ts:34`, `src/audit/receipt-verify.ts:16`,
  `src/audit/cosign.ts:50`, `src/audit/receipt-verify.spec.ts:1`,
  `src/audit/log-verify.ts:34`, `src/audit/log-verify.parity.spec.ts:19`,
  `src/audit/checkpoint-witness.service.ts:50`, `src/audit/cosign.spec.ts:20`,
  `src/audit/receipt-audit.service.ts:51`, `src/audit/log-inclusion-audit.service.ts:36`,
  `test/integration/witness-cosigning.integration.spec.ts:15`.
- `package-lock.json` — regenerate with an incremental `npm install` (not a full
  `rm -rf node_modules && npm install` regen — the PR #125 acdp-0.8.3 bump earlier this
  session showed a full regen restructures unrelated nested-dep entries noisily).
- `.github/workflows/bump-acdp.yml` — `package:` input (`@agentcontextdistributionprotocol/acdp`)
  is already correct, no functional change; only its ~9-line comment block (lines ~15-23)
  explaining the now-obsolete alias needs rewriting.
- No `tsconfig*.json`/jest `moduleNameMapper` references the import name. No
  `docs/`/`CLAUDE.md` prose references the alias syntax specifically — both already say
  "the pinned `acdp` binding" generically (CP-4's fix), which stays accurate post-rename.
  `Dockerfile:3-4`'s "published `acdp` npm package" prose is likewise generic, no change.

## Context: PR #125 fix (same session, prior to this plan)

Before starting this plan, fixed a broken bot-authored dependency bump: PR #125
(`acdp-deps-bot`, 0.8.1 → 0.8.3) had CI red on both unit and integration jobs — its
regenerated `package-lock.json` was missing the
`@agentcontextdistributionprotocol/acdp-linux-x64-gnu` optional-dependency entry entirely
(likely `npm/cli#4828` pruning it during a non-Linux lockfile regen), so Linux
runners/Docker couldn't load `acdp`'s native binding. Fixed with an incremental
`npm install` against the PR's existing lockfile (added back only the missing 19-line
platform block, no other versions moved), verified lint/build/conventions/full unit suite
green locally, pushed to `deps/acdp-0.8.3`, watched CI go green, bot's auto-merge then
landed it as `726418c`. This is why `package.json:35` is at `^0.8.3` rather than `^0.8.1`
as the original cross-repo plan draft assumed — the acceptance criteria and approach are
unaffected, only the version number in the `Chose` line.

- **Shipped:** pushed `fix/dealias-acdp` (`ece5b37`), opened PR #126, CI green
  (unit/integration/docker all `pass`), squash-merged `a5957bd` on 2026-08-30T17:16:01Z,
  branch deleted, issue #123 auto-closed by the merge. Independent fresh-subagent
  verification: PASS, no gaps. `main` is at `a5957bd`; no open PRs or issues remain in
  this repo.

# Progress — wave1-cp-8-9

Plan: `plans/wave1-cp-8-9.md` (issue #127)

## Repo map (discovery notes for `/implement` — don't re-scan)

- `src/contexts/safe-federation-client.ts` — `readCapped` (~line 150-167) buffers the
  whole body via `resp.arrayBuffer()` before checking `MAX_BODY_BYTES` (1MB); the
  `AbortController`/timer in `get()` (~line 78-90) is cleared right after the initial
  `fetch()` resolves (headers only), not covering the body-read phase (CP-8).
- `src/contexts/safe-federation-client.spec.ts` — the `resp()` test helper (line 7-19)
  builds a plain object cast `as unknown as Response` with only `.arrayBuffer()` — **no
  `.body` `ReadableStream` at all**. Must be upgraded to a real streaming body or the
  new `resp.body.getReader()` code path in Phase 1 will break every existing test.
- `Dockerfile` — no `USER` directive (runs as root), no `HEALTHCHECK`, builder stage
  `COPY`s `tsconfig.json nest-cli.json` but not `tsconfig.build.json` (line 17), so
  `nest build` (confirmed `package.json` `"build": "nest build"`) silently falls back to
  plain `tsconfig.json` (no test-file exclusion) — `**/*.spec.ts` compiles into `dist/`
  and ships in the production image (CP-9).
- `tsconfig.build.json` (repo root) — already correctly excludes `test`, `**/*.spec.ts`;
  just needs to be `COPY`'d into the Docker build context.
- `Dockerfile.dockerignore` — build-context filter for this Dockerfile specifically
  (BuildKit prefers it over the generic root `.dockerignore`); no change needed for
  CP-9, confirmed it doesn't already exclude spec files (it doesn't need to — the fix is
  compiling with the right tsconfig, not filtering source).
- CP-5 (key rotation) — confirmed CONFIRMED by the human user during `/drive` preflight,
  logged to `DECISIONS.md`. No code phase; not in this plan's scope.

## Phase checkpoint log

### Phase 1 — CP-8 (stream-cap the federation client body read)
- **Verdict:** DONE (PASS, round 1)
- **Verifier tier:** Fable — security/DoS-defense boundary on the SSRF-gated federation
  client (per this plan's own stated rationale), fresh subagent, independently re-ran
  every check rather than trusting the executor's self-report.
- **Rounds:** 1, clean PASS. Verifier independently re-ran `npm test -- safe-federation-
  client` (18/18), full `npm test` (763 passed/3 skipped/0 failed), `tsc --noEmit`,
  eslint, `check:conventions` — all green, matching the executor's numbers. Traced the
  timer/signal lifecycle across `get()`/`readCapped()` line-by-line, confirmed
  `reader.cancel()` fires (awaited) before every throw path, confirmed the
  oversized-chunked-body test genuinely proves early cancellation (not just a
  drain-then-check pass), confirmed no unhandled-rejection risk in the new
  `raceAbort`/`toAbortError` helpers (listener cleanup covers every exit path).
- **PR-now-vs-accumulate call:** ship now (Orchestrator decision — security fix,
  independently shippable, unrelated file to Phase 2's Dockerfile work, no reason to
  hold it).
- **Files touched:** `src/contexts/safe-federation-client.ts`,
  `src/contexts/safe-federation-client.spec.ts`, `plans/wave1-cp-8-9.md` (Status:
  DONE), `PROGRESS.md` (this entry).
- **Commit:** `584ff60` on `fix/cp-8-stream-cap-body`.
- **What's next:** ship Phase 1 now via `/ship`, then Phase 2 (CP-9, Sonnet verify).

### Ship (Phase 1 / CP-8)
- `/ship`'s own mandatory verification gate (fresh Opus subagent, separate pass from
  the `/implement`-phase Fable review above) returned **PASS**, and additionally found
  the same body-leak class already fixed for redirects also applied to two other
  early-throw paths: the 429 rate-limit branch and the `Content-Length` fast-fail in
  `readCapped()` both threw without cancelling `resp.body`. Non-blocking per the gate's
  own verdict, but fixed immediately (same file, same phase's rationale, cheap) rather
  than shipping a known partial fix — commit `8c5fafe`. Also restored the exceeded-byte
  count in the streaming `BODY_TOO_LARGE` message (a fidelity nit from the same review),
  and added `.drive.lock` to `.gitignore` (housekeeping note from the same review).
  Re-ran the full suite after the fix (763 passed/3 skipped/0 failed, tsc/lint/
  conventions all clean) before proceeding to push.
- pushed `fix/cp-8-stream-cap-body` `234e9fe`
- PR #128 opened: https://github.com/agentcontextdistributionprotocol/acdp-control-plane/pull/128
- CI green (unit/integration/docker all `pass`)
- merged #128 (squash) at `c7177c0`. Local `main` fast-forwarded, feature branch deleted
  (local + remote). No post-merge deploy triggered — `release.yml` is tag-triggered only
  (confirmed unchanged from Wave 1); nothing further to watch.
- **What's next:** Phase 2 (CP-9, Dockerfile hardening) — Sonnet verify tier.

### Phase 2 — CP-9 (Dockerfile hardening)
- **Verdict:** DONE (PASS, round 1)
- **Verifier tier:** Sonnet — CI/CD/build-config-shaped mechanical fix (per this plan's
  own stated rationale), fresh subagent, independently re-ran the Docker build and
  acceptance checks rather than trusting the executor's report.
- **Rounds:** 1, clean PASS. Notable environment hiccup during execution: the local
  Colima/Docker daemon was down/flaky mid-phase (a `colima restart` initially failed,
  then briefly appeared to swap in a stale daemon state before stabilizing) — this cost
  extra wall-clock time working around it but was infrastructure, not a code defect;
  resolved by restarting Colima and rebuilding. Three independent build+verify passes
  (one by the Sonnet executor, one by the orchestrator directly, one by the Sonnet
  verifier) all converged on identical results: non-root UID 999 (`app`), correct
  `HEALTHCHECK` config, zero `*.spec.js` files in the built image's `dist/`, correct
  `app:app` ownership of `/app` (dist/node_modules/drizzle), and the verifier
  additionally confirmed the `USER`/`chown` ordering is correct relative to the
  root-requiring steps (`npm ci --omit=dev`, the builder-stage `COPY`s) and ran the
  inline healthcheck script standalone to confirm it's functionally correct, not just
  plausible-looking.
- **Files touched:** `Dockerfile`, `plans/wave1-cp-8-9.md` (Status: DONE), `PROGRESS.md`
  (this entry).
- **Commit:** `e359b1b` on `fix/cp-9-dockerfile-hardening`.
- **Both phases of this plan are now DONE.** Plan complete pending end-of-plan closeout
  and `/ship`.

### Ship (Phase 2 / CP-9)
- `/implement`'s own Sonnet phase-verify (above) was a clean round-1 PASS — that
  checkpoint stands. `/ship`'s **separate** mandatory verification gate (fresh Opus
  subagent), run afterward, found a genuine gap the phase-verify pass hadn't caught:
  the `HEALTHCHECK` (`Dockerfile:37-38`) hardcoded `localhost:3001`, but `PORT` is a
  documented, PaaS-configurable env var (`AppConfigService`, `docs/CONFIGURATION.md`) —
  under a deploy setting `PORT=8080` the probe would hit a closed port forever,
  permanently marking a working container unhealthy and inviting an orchestrator to
  restart-loop it (worse than shipping with no healthcheck at all). Three other findings
  were correctly assessed as advisory/non-blocking (the plan-specified `chown -R`
  writable-by-runtime-user tradeoff; the evidence trail; unchecked acceptance-criteria
  boxes in the gitignored plan file).
- Fixed in commit `827734b`: the healthcheck now reads `process.env.PORT` at runtime
  (falling back to 3001) and uses `127.0.0.1` instead of `localhost`. Verified directly
  (built the image, ran the healthcheck script inside the container with `-e PORT=9999`
  and a listener on 9999 → exit 0; with the listener left on the old port 3001 instead →
  exit 1, proving the env var genuinely drives the target) before re-verifying.
- **Re-verify (fresh Opus subagent, given the prior round's gap list): PASS.**
  Independently re-built the image and ran an 8-case matrix (PORT unset/set/empty ×
  listener on the right/wrong port × non-2xx status) — every case behaved correctly,
  including the two negative cases that prove the fix isn't a no-op (PORT set but
  listener on the old port correctly fails closed). Confirmed `127.0.0.1` is correct
  given `HOST` defaults to `0.0.0.0` (`app-config.service.ts:42`), object-form
  `http.get()` syntax is valid, non-root UID and zero-spec-files still hold. The
  re-verifier candidly flagged and corrected its own first test-harness bug (an
  unquoted shell variable that initially made `PORT` look ignored) before reporting —
  noted here since it's a useful caution about trusting a first negative result at face
  value, not because it affected the actual verdict.
- pushed `fix/cp-9-dockerfile-hardening` (sha appended after push below)

## Plan: expose-service-version (issue #130)

**Repo map** (for `/implement` to reuse, not re-scan):
- `src/health/health.controller.ts` — the `/healthz`/`/readyz` controller; no
  `HealthModule`, registered directly in `AppModule`.
- `src/config/app-config.service.ts:32-37` — `clientVersion` readonly, already reads
  `package.json`'s `version` at boot; already consumed by `src/main.ts:61` for the
  Swagger doc version. Reused as-is for the new `/healthz` field.
- `src/app.module.ts:101` — `HealthController` provider registration; `AppConfigService`
  already provided at module scope, so no wiring change needed beyond the constructor.
- No existing `health.controller.spec.ts` — first test file for this controller.

### Phase checkpoint log

- **2026-09-05 — Phase 1 (add `version` to `/healthz`, issue #130): DONE.** 1 verify
  round, PASS (Opus-tier, trivial/low-risk single-file addition). Verifier confirmed all
  4 acceptance criteria met exactly as planned, flagged the pre-existing `clientVersion`
  naming as a mild (non-blocking) misnomer for its new consumer, confirmed no doc drift
  beyond the already-updated `docs/API.md:604`, and suggested one optional
  strengthening: an end-to-end `version` assertion in
  `test/integration/health.integration.spec.ts` (added; local run blocked by an
  unrelated host Docker port-5433 conflict with a stray non-project Postgres — CI runs
  it in a clean environment).
  - **Files touched:** `src/health/health.controller.ts`, `src/health/health.controller.spec.ts`
    (new), `test/integration/health.integration.spec.ts`, `docs/API.md`,
    `plans/expose-service-version.md` (Status: DONE).
  - **Tests:** `npm test` — 68 suites, 766 passed (3 pre-existing unrelated skips);
    `tsc --noEmit` clean; `npm run lint` clean; `npm run check:conventions` clean.
    Integration suite not run locally (Docker port conflict, unrelated to this change);
    deferred to CI.
  - Plan complete pending `/ship`.
pushed feat/expose-service-version 734d7bd
PR #134 opened: https://github.com/agentcontextdistributionprotocol/acdp-control-plane/pull/134
merged #134

## Plan: dep-migrations-137 (issue #137 — split of closed PR #133)

Plan: `plans/dep-migrations-137.md` (gitignored). Repo map lives in that file's
"Repo map" section — later phases read it instead of re-scanning.

**PR strategy: one PR per phase, sequential** (ten phases after re-verify round 1 — see
table; Phase 0 may fold into Phase 1's PR if it needs no code change). Bundling is exactly what made
#133 unreviewable and unmergeable, and the issue itself asks for individual review. One
PR per dependency migration keeps each atomically revertable, so a regression traced to
(say) ioredis 6 in production is a single clean `git revert` rather than archaeology
across a mixed bump. Each PR goes through `/ship` in full before the next phase starts.

**Phases (least-risky-first):**

| # | Phase | Risk |
|---|---|---|
| 0 | Establish a green integration baseline (prerequisite, no bump) | Blocking — 5 phases gate on `test:integration`, which does not run locally today |
| 1 | Prune dead deps: `uuid`, `nestjs-pino`, `pino-http` | Lowest — zero imports anywhere |
| 2 | `express` → `5.2.1` (declaration alignment) | Low — no route changes; needs new `/agents/*did` test |
| 3 | `pino` 9 → 10 | Low — only 10.0.0 break is dropping Node 18 |
| 4 | `@types/node` 22 → 26, `@types/supertest` 6 → 7 | Low-medium — `Buffer` generics across 34 files |
| 5 | `eslint` 9 → 10, `eslint-config-prettier` 9 → 10, `@typescript-eslint` → 8.70 | Low — config pre-tested unmodified under eslint 10 |
| 6 | `jest` 29 → 30, `@types/jest` 30 | Medium — thin *functions* coverage margin; fake-timers jump 2 majors |
| 7 | `ioredis` 5 → 6 | Medium-high runtime — RESP3 default; unit spec mocks client away |
| 8 | `typescript` 5.7 → 6.0.3 | Highest — 4 config-level breaks incl. a silent emit-path move |
| 9 | `@nestjs/cli` + `@nestjs/schematics` 11 → 12 (build tooling only) | Medium — not throttler-blocked; removes the TS compiler split |
| — | **NestJS 12 (runtime)** | **BLOCKED upstream — no phase** |

**Corrections to issue #137 carried by this plan** (all verified empirically, not assumed):
1. NestJS 12 is hard-blocked by `@nestjs/throttler` (no v7; peers cap at `@nestjs/common ^11`).
   `npm install` with `@nestjs/*@^12` fails ERESOLVE on exactly this. The issue blamed a
   TypeScript/`@typescript-eslint` conflict instead.
2. There is no `@typescript-eslint` v9. Latest 8.70.0 is a MINOR bump that already supports
   `eslint ^10` and `typescript <6.1.0`.
3. The app ALREADY runs Express 5 — `@nestjs/platform-express@11.2.3` pins `express@5.2.1`
   + `path-to-regexp@8.4.2` as dependencies; the repo's own `express@^4.21.0` is an
   unreferenced shadow. The routes were migrated to `*ctxId`/`*did` syntax in `03586d1`.
   The issue's `:ctxId*`/`:did*` strings came from stale `CLAUDE.md:104-105`.
4. `uuid` is never imported (the `uuid()` hits in `src/db/schema.ts` are Drizzle's column
   helper). uuid v12 dropped CommonJS, so bumping would be harmful — deletion is correct.
5. Missed by the issue: `nestjs-pino` + `pino-http` are also dead, and `CLAUDE.md:28` /
   `docs/README.md:79` document a `nestjs-pino` architecture the repo does not have.

**Baseline recorded (2026-09-10, `main` @ 5323edd, clean tree):** `tsc --noEmit`, lint
(`--max-warnings 0`), and `check:conventions` all exit 0; unit suite 68 suites / 766
passed / 3 skipped / 769 total in ~22.5s. Pre-existing warning "A worker process has
failed to exit gracefully" — a jest-29 teardown leak, and a known hazard for Phase 6.

### Phase checkpoint log


**Plan re-verification (fresh Opus agent, round 1): GAPS → all closed.** The pass
independently reproduced and confirmed the NestJS-12 blocker, the Express-5 shadow-dep
story, the pino/ioredis/tsconfig surfaces, the zero removed-jest-30 matchers, commit
`03586d1`, and the unit baseline byte-for-byte. It then found, and the plan now carries
fixes for:
- **BLOCKER:** Phase 8 patched `tsconfig.build.json`'s `rootDir` but missed
  `test/tsconfig.test.json`, which `include`s `../src/**` with no `rootDir` — measured
  **70-72 `TS6059`** under TS 6.0.3, which fire even under `--noEmit` and would also break
  ts-jest's integration transform. Fixed by adding `"rootDir": ".."` (verified: 0 errors).
- **Wrong causal claim:** Phase 3's blocker is `pino-http@10.5.0` (constrains `pino ^9`),
  **not** `nestjs-pino@4.6.1`, which already permits pino 10. The "three-package lockstep"
  argument was wrong; the action (delete all three) survives.
- **False dependency edge:** Phase 5 → Phase 8 does not exist — the *currently declared*
  `@typescript-eslint@8.68`/parser `8.63` already peer `typescript <6.1.0`. Edge removed;
  4→6 downgraded to soft ordering.
- **`CLAUDE.md` is gitignored and untracked**, so Phases 1 and 2 listed doc fixes that
  could never reach a PR. Reclassified as local-only hygiene. Root cause worth keeping:
  this shell's `grep` is a **gitignore-respecting wrapper**, which is why the original
  repo-wide "zero hits" sweeps silently skipped it — use `command grep` for exhaustiveness.
- **Unmeasurable gates:** no integration baseline existed and the suite does not run here
  (port 5433 is held by another project's container; `docker compose --wait` *succeeds*,
  so the symptom differs from the documented hazard). Five phases gated on it → new
  **Phase 0**.
- **Missing coverage:** `@nestjs/cli` + `@nestjs/schematics` 11→12 are 2 of #133's 18
  packages, are **not** throttler-blocked (neither peers `@nestjs/core`/`common`), and had
  no phase → new **Phase 9**, which also retires Phase 8's compiler-divergence workaround.
- **Trivially-passing criteria** rewritten: Phase 8's `grep -c '"types"'` (passed on
  `"types": []`), Phase 8's docker-build claim (proves nothing under option (a); CI only
  builds, never runs `HEALTHCHECK`), Phase 5's `--print-config` rule count (183 entries, 4
  non-off — not decidable) now a byte-diff against a recorded baseline.
- **Measured corrections:** jest 30 coverage moves `73.25|62.40|58.62|74.01` →
  `73.03|65.77|58.09|73.78` — **branches go UP**; the thin margin is *functions* (58.09 vs
  threshold 55). And Phase 6's 766-test gate must be re-recorded with `ACDP_SPEC_DIR` set,
  since a jest-30 trial showed 748/21-skipped purely from the conformance suite skipping.
- Plus ~15 corrected `file:line` citations (most `package.json` line numbers in the phase
  Files lists were off by 2-4).

- **2026-09-10 — Phase 0 (green integration baseline, issue #137): DONE.** 1 verify round,
  `GAPS` → all 7 closed → re-verified green. Opus-tier (test-infrastructure change, no
  `src/` file touched, fully reversible — Fable not warranted).

  **Planned as a no-code phase; it found two pre-existing defects and fixed one in code.**

  1. **Host port 5433 is owned by a second Docker daemon.** `colima` is the active
     context and holds this repo's compose container; a Docker Desktop daemon (socket
     unreachable from this sandbox) holds an unrelated `aitp-*` project's container on
     5433. Ours starts, reports Healthy, publishes `0.0.0.0:5433`, and is silently
     shadowed. Proof: one endpoint, two answers — `docker exec` into our container lists
     `acdp_control_plane_test`, a host connect to `localhost:5433` lists
     `aitp_control_plane_test`. **Not fixed** (another project's container, and lane
     sessions are live) — worked around on port 55433 via `DATABASE_URL`, which
     `global-setup.ts` already honors. See `ASSUMPTIONS.md`.
  2. **`truncateAll()` had drifted 5 tables behind the schema** (`agent_capabilities`,
     `auth_challenges`, `issuance_ledger`, `revocation_cursors`, `revoked_tokens` — 14 of
     19 covered), making the integration suite **non-idempotent**: run 1 green, run 2
     failing `revocation-repository.contract.ts:86` with a cursor left from the prior run.
     Invisible in CI, which provisions a fresh Postgres service per run. **Fixed.**

  - **Verify round 1 — `GAPS` (7), all closed.** The gate's headline finding: *the fix
    did not close the defect*. `truncateAll` only runs via `createTestApp().cleanup()`,
    and `auth-persistence.integration.spec.ts` never calls it — it had its own `clean()`
    covering 2 of 4 auth tables, still omitting `revocation_cursors`. The "three
    consecutive green runs" offered as proof were sequencing luck (10 specs happen to run
    after it); the gate reproduced the failure with the fix applied by running that spec
    alone twice. It also found that jest's sequencer orders previously-failed specs
    **first**, so one local failure reorders the next full run into failing too — exactly
    the phantom-failure-blamed-on-a-dependency-bump this plan exists to prevent.
    Other gaps: acceptance criteria 1-2 unrecorded; `truncateAll` became an unbounded
    "wipe every table in `public`" aimed at whatever `DATABASE_URL` says (a live footgun
    given this phase's own workaround, and understated in the first `ASSUMPTIONS.md`
    entry); the new error message printed the password; SQL not schema-qualified
    (`search_path`-dependent); no `ORDER BY` (unstable lock order, invites the very
    `40P01` the retry loop absorbs); comment wording inaccurate.
  - **Fixes:** `clean()` delegates to `truncateAll(pool)`; `global-setup` truncates once
    at startup so a run's outcome no longer depends on the previous run's final state;
    `assertTestDatabase` refuses any database not ending in `_test`; `redactUrl()` strips
    credentials; SQL schema-qualified and `ORDER BY tablename`.
  - **Files touched:** `test/helpers/test-db.ts`, `test/setup/global-setup.ts`,
    `test/integration/auth-persistence.integration.spec.ts`, `PROGRESS.md`,
    `ASSUMPTIONS.md`, `plans/dep-migrations-137.md`. No `src/` file.

  **Baselines recorded (the point of the phase — Phases 2/4/6/7/8/9 gate on these):**
  - Integration: **24 suites / 151 tests**, exit 0. Reproducible: full suite twice on ONE
    database, plus the gate's repro (`auth-persistence` alone twice → 20/20 both).
    One pre-existing open handle: `CustomGC` from the `acdp` NAPI binding. The spec
    that happens to load the binding first varies with suite order (observed via both
    `src/audit/checkpoint-witness.service.ts:50` and `src/auth/acdp-verify.ts:17`), so
    treat the handle *count* (1) as the baseline, not the stack.
  - Unit, CI-equivalent (`ACDP_SPEC_DIR` + `ACDP_REQUIRE_CONFORMANCE=1`): **68 suites /
    766 passed / 3 skipped / 769 total**, coverage **73.25 | 62.4 | 58.62 | 74.01**
    (statements | branches | functions | lines), exit 0.
  - **This is byte-identical to the plain local run — `ACDP_SPEC_DIR` changes nothing.**
    Confirmed the conformance suites genuinely run (`cosign` + `log-verify.parity` = 2
    suites / 26 tests passed), and the 3 skips are unrelated SDK feature-detection
    fallbacks.
  - **Therefore the round-1 hypothesis for Phase 6 is DISPROVED.** That pass attributed a
    jest-30 trial's `67 suites / 748 passed / 21 skipped` to the conformance suite
    skipping without `ACDP_SPEC_DIR`. It cannot be — the env var makes no difference on
    jest 29. The 18-test delta is unexplained and must be treated as a **possible real
    jest-30 effect** when Phase 6 runs, not a known-benign artifact. Phase 6's criterion 2
    was updated accordingly.
  - **Caveat on "changes nothing" — it is machine-local.** The plain run finds fixtures
    through the *sibling-path fallback* (`cosign.spec.ts:46`,
    `log-verify.parity.spec.ts:40`) resolving to a sibling
    `agentcontextdistributionprotocol/schemas/conformance` checkout that exists on this
    machine. On CI there is no sibling, so `ACDP_SPEC_DIR` IS load-bearing there. This
    does not weaken the disproof above — the jest-30 trial ran on this same machine, with
    the same fallback available.
  - Caveat: the local spec checkout is at `d1f06d0`; CI pins `bff3cf3`. Fixture sets may
    differ, so CI remains the authority on conformance results.
  - Gates: `tsc -p tsconfig.json` 0, `tsc -p test/tsconfig.test.json` 0,
    `lint --max-warnings 0` 0, `check:conventions` 0.
  - Negative paths proven, not assumed: guard refuses `production_db` (password redacted
    in the refusal); `redactUrl` → `postgres://user:***@localhost:5433/...`.
  - **Re-verify round 2 — 6 of 7 closed, gap 3 `PARTIAL`, now fixed.** The guard validated
    `TEST_DB_URL` while truncating a caller-supplied `pool`, so it never saw the database
    it was protecting; the gate demonstrated the hole by truncating a real `production_db`
    through a passed-in pool (3 rows → 0). Fixed by deriving the name from
    `select current_database()` **on the pool being truncated**, which cannot drift from
    the target. Re-proved with the gate's own exploit: refusal raised, rows intact at 3.
    Documented limit kept honest in the code: a foreign database that ends in `_test`
    (e.g. `aitp_control_plane_test`, the squatter on 5433) still passes — that case is
    caught by `global-setup.ts`'s loud connection error, not by this guard.
  - **Next:** Phase 1 — prune dead deps (`uuid`, `nestjs-pino`, `pino-http`).
- **2026-09-11 — Phase 1 (prune dead deps `uuid`/`nestjs-pino`/`pino-http`, issue #137): DONE.**
  1 verify round, **PASS** first time. Opus-tier (manifest + docs, no `src/` change, trivially
  reversible — Fable not warranted).
  - **Files touched:** `package.json`, `package-lock.json`, `docs/README.md`,
    `scripts/ci-conventions.sh` (comment only — grep patterns byte-identical), plus
    `CLAUDE.md:28` as **local-only** hygiene (gitignored, deliberately not in the PR).
  - **Two of issue #137's eight migrations dissolved here.** `uuid` 11→14 and the
    `pino-http` 10→11 half of item 4 are not bumps — the packages were never imported.
    Bumping `uuid` as the issue asked would have pulled a version that **dropped CommonJS
    support** into this `"module": "commonjs"` project: real breakage risk added to a
    package with zero call sites.
  - **Verifier's independent findings:** exhaustive `command grep` sweeps (the
    gitignore-safe form) found zero static, dynamic, `require`, or string references
    anywhere in `src/ test/ e2e/ scripts/ drizzle/ .github/ Dockerfile docker-compose*
    nest-cli.json eslint.config.js tsconfig*`; confirmed every `uuid` identifier in
    `src/db/schema.ts` is Drizzle's `uuid()` column helper from `drizzle-orm/pg-core`
    (imported at `:12`), not the package; node-by-node lockfile diff = exactly 3 nodes
    removed, **0 added, 0 version changes**; `pino-http`'s transitive deps survive because
    they have other parents (`pino-std-serializers`/`process-warning` ← `pino`,
    `get-caller-file` ← `yargs`); and a **negative test** of `ci-conventions.sh` in a
    scratch dir proved all three rules still fail on real violations rather than passing
    vacuously.
  - **Gates:** `npm run build` 0, `tsc --noEmit` 0, `lint --max-warnings 0` 0,
    `check:conventions` 0, unit **68 suites / 766 passed / 3 skipped** (identical to
    baseline — the meaningful signal: removing three deps changed nothing), clean
    `npm ci` from a wiped `node_modules` 0.
  - **Boot proof (criterion 6), both branches of the `isDevelopment` fork** — the only
    claim here no static gate can make, since the `require.resolve('pino-pretty')` guard
    at `src/common/pino-logger.ts:11` is reachable only at boot:
    production → `/healthz` = `{"ok":true,"service":"acdp-control-plane","version":"0.1.4"}`
    with ~68 pino JSON lines incl. "Nest application successfully started";
    development → colorized `pino-pretty`, **0** raw JSON lines.
  - **Executor error worth recording:** the first two boot attempts were bad measurements,
    not bad code — one invoked `timeout` (absent on macOS) and reported a shell error as
    the log line; the next read 3 lines of an 86-line log and mistook `migrate.ts`'s
    exempt `console.log` preamble for a failure. The change was fine both times. A gate
    that never ran the thing it claims to test is the same failure class this plan keeps
    finding in the repo.
  - **Out-of-scope bug found during boot verification (NOT fixed here, pre-existing on
    `main`):** SIGTERM raises `Error: Called end on pool more than once`
    (`src/db/database.service.ts:30`). `src/main.ts:73` calls `enableShutdownHooks()`
    — which registers its own SIGTERM/SIGINT handler calling `close()` — *and*
    `src/main.ts:81-82` registers manual `process.on('SIGINT'|'SIGTERM', …)` handlers that
    also call `app.close()`, so `onModuleDestroy` runs twice. Unrelated to dependencies.
    Deserves its own issue.
  - **Next:** Phase 2 — align the `express` declaration to `5.2.1` + add the missing
    `/agents/*did` route-shape test.
||||||| parent of b214486 (chore(deps): align the express declaration with the version actually running)
- **2026-09-11 — Phase 2 (align `express` declaration to 5.2.1, issue #137): DONE.**
  1 verify round, **PASS** + 2 LOW findings (both closed) + 1 INFO. Opus-tier.
  - **Files:** `package.json` (one line), `package-lock.json`,
    **new** `test/integration/agents-routes.integration.spec.ts`; `CLAUDE.md:105-106`
    local-only. **No `src/` change** — the point of the phase.
  - **The issue's premise was wrong, and the root cause is worth remembering.**
    #137 budgeted an Express 4→5 routing migration across five endpoints. The app has
    served Express 5 all along (`@nestjs/platform-express@11.2.3` depends on
    `express@5.2.1` + `path-to-regexp@8.4.2` **directly**), and the routes moved to
    `*name` syntax in `03586d1`. The issue's `:ctxId*` / `:did*` strings came from
    `CLAUDE.md:104-105` — a **gitignored, untracked** file that was months stale.
    `docs/API.md` (tracked) has been correct throughout. **A plan derived from an
    untracked doc inherited an error the tracked docs did not have.**
  - **Tree before → after:** shadow `express@4.22.2` (consumed by nothing) and its
    `path-to-regexp@0.1.13` removed; single deduped `express@5.2.1`; `path-to-regexp`
    8.4.2 only.
  - **THREE transitive moves, not the "pure relocation" first claimed** (10 of 12
    top-level version changes are relocation at identical running versions; these are
    genuine):
    | package | from | to | assessment |
    |---|---|---|---|
    | `body-parser` | 2.2.2 | **2.3.0** | **fixes GHSA-v422-hmwv-36x6 / CVE-2026-12590** |
    | `content-type` | 1.0.5 | **2.1.0** | major; 2.x stops throwing on malformed input, body-parser 2.3.0 adapted in the same release — charset path behaviourally identical |
    | `negotiator` | 1.0.0 | **1.1.0** | zero blast radius: repo does no content negotiation |
    **`npm audit`: 7 → 5 vulnerabilities.** The CVE (invalid `limit` → `bytes.parse()`
    returns `null` → body-size enforcement silently disabled) was live on the parser
    guarding `/ingest/acdp`. Executor initially framed this as *risk*; it is a *fix*, and
    the `content-type` major was missed entirely until the gate caught it.
  - **Raw-body/HMAC path verified unchanged** (the security-relevant question, since
    `/ingest/acdp` HMACs the raw bytes): `verify` callback still forces
    `opts.encoding = null`, so `req.rawBody` is the exact wire buffer; `raw-body` stayed
    3.0.2, `iconv-lite` 0.7.2. The new `limit` TypeError cannot fire — `readNumber`
    (`app-config.service.ts:9-14`) guarantees a finite number.
  - **Exact pin (`5.2.1`) over the plan's `^5.2.1`:** `platform-express` depends on
    *exactly* `5.2.1`, so a caret would install 5.3.0 at the root while the serving path
    stayed 5.2.1 — recreating this phase's own shadow-dependency bug and buying no patch
    coverage. Upgrades ride `@nestjs/platform-express`; Dependabot still tracks an exact pin.
  - **New spec is mutation-tested, not merely green.** Breaking `.join('/')`
    (`agents.controller.ts:26`) fails exactly the multi-segment case; disabling
    `@Get('*did')` fails three cases. **Gate finding (closed):** case 4 originally
    asserted only `status === 404` and *survived* the route-disabling mutant, because
    Nest's no-route fallback is also a 404 — it asserted a guarantee it did not deliver.
    Now matches the handler's own message. Re-mutated to confirm it kills.
  - **Gates:** no `src/` diff; build/tsc/lint/conventions 0; unit 68 / 766 / 3 (unchanged);
    integration **25 suites / 155 tests** (was 24/151). New spec passed 4/4 on the
    **pre-change** tree too — which is what makes the post-change green mean anything.
  - **INFO (follow-up, out of scope):** the sibling wildcard joins at
    `contexts.controller.ts:45` and `capability.controller.ts:147` still lack
    multi-segment coverage — `federation-proxy` uses `encodeURIComponent` and
    `capabilities` uses a slash-free DID, so neither exercises the multi-element array.
  - **Next:** Phase 3 — `pino` 9 → 10.
- **2026-09-11 — Phase 3 (`pino` 9 → 10, issue #137): DONE.** 1 verify round, **PASS**
  first time + 2 plan-prose corrections. Opus-tier.
  - **Files:** `package.json` (one line), `package-lock.json`, **new**
    `src/common/pino-logger.spec.ts`. **No `src/` source change** — `pino.Logger` and
    `pino.TransportSingleOptions` both survive the major, so the five-touchpoint surface
    in `src/common/pino-logger.ts` compiles untouched.
  - **Cleanest lockfile of the plan so far — zero unrelated drift** (contrast Phase 2):
    `pino` 9.14.0→10.3.1, `pino-abstract-transport` 2.0.0→3.0.0, `thread-stream`
    3.2.0→4.2.0 — all three are pino's own declared deps. `pino-pretty` **not bumped**
    (13.1.3 already speaks `pino-abstract-transport@^3`). The tree got *simpler*: the
    nested `pino-pretty/node_modules/pino-abstract-transport@3.0.0` is gone, deduped to a
    single top-level copy.
  - **Output shape measured, not assumed.** The verifier diffed actual emitted lines
    between pino 9 and 10 on Node 26 across plain objects, the repo's exact
    `{context, trace}` error shape, nulls/undefined/arrays/nested/unicode/escaped quotes,
    serialized `Error`s and printf `%s/%d/%o`: **character-for-character identical** after
    normalising `time`/`pid`/`hostname`. `levels.values` unchanged, `time` still epoch-ms
    integer, key order unchanged. **No downstream log-consumer risk.**
  - **Two plan-prose corrections (plan file updated):** (1) the
    `pino-abstract-transport` ^2→^3 + `thread-stream` →v4 moves landed in **10.1.1**, not
    10.2.0. (2) "`pino-pretty` must resolve >= 13.1.3" **overstated the facts** —
    `pino-abstract-transport@3.0.0`'s whole changelog is "drop tap and Node 18", **zero
    API change**, so a nested `pat@2` would have worked; the dedupe is a bonus, not a
    requirement.
  - **Executor framing corrected:** the `try/catch` at `pino-logger.ts:10-15` wraps
    **only `require.resolve`** — `pino({...transport})` at `:17` is outside it, so a
    transport that resolves but fails to *load* throws loudly at boot. The silent path is
    narrower than stated: it covers only "pino-pretty absent", which is the intended
    production behaviour (`Dockerfile` runs `npm ci --omit=dev`).
  - **NEW: `src/common/pino-logger.spec.ts` — beyond plan, deliberately.** The plan said
    the manual boot smoke was sufficient proof. But this was the **second** phase whose
    only evidence for the dev transport was a hand-run boot, six phases remain, and the
    verifier validated the mechanism before it was written. The file had **no spec at
    all**. **Mutation-verified:** removing the transport (simulating the silent
    fallback-to-JSON this guards) fails the test; restored, it passes.
  - **Gates:** tsc (both projects) 0, build 0, lint 0, conventions 0, no `src/` source
    diff; unit **69 suites / 768 passed / 3 skipped** (was 68/766/3 — the new spec);
    integration 25 suites / 155 tests; `npm ci --dry-run` 0.
    Coverage **rose** on every metric: 73.25→73.43 stmt, 62.40→62.44 br, 58.62→59.41 fn,
    74.01→74.21 ln; thresholds (70/58/55/70) unchanged and met.
  - **Boot proof, both fork branches** (independently reproduced by the verifier):
    production → `/healthz` 200, 69 pino JSON lines, "Nest application successfully
    started"; development → `/healthz` 200, **0** raw JSON lines, colorized ANSI.
  - `npm audit` delta: **zero** — no pino-family package appears in the 12 pre-existing
    findings. `thread-stream@4` adds `engines: node >=20`, the only new floor (CI 22,
    Docker 26 — satisfied).
  - **Next:** Phase 4 — `@types/node` 22→26, `@types/supertest` 6→7.
- **2026-09-11 — Phase 4 (`@types/node` 22→26; **delete** `supertest`+`@types/supertest`,
  issue #137): DONE.** 1 verify round, **PASS** + 3 advisories (2 actioned, 1 deferred).
  Opus-tier.
  - **Files:** `package.json`, `package-lock.json`, `.github/dependabot.yml` (stale
    comment). **Zero changes under `src/` or `test/`** — byte-identical to `main`.
  - **Diverged from plan: `@types/supertest` DELETED, not bumped.** The gate found
    `supertest` + `@types/supertest` are imported nowhere (`test/helpers/test-client.ts`
    is a hand-rolled `node:http` client, deliberately dependency-free). **Phase 1's
    dead-dep sweep missed them.** Applying Phase 1's own confirmed ruling, deletion beats
    bumping a package nothing consumes. That makes **four** of #137's eighteen bundled
    packages dead code rather than migrations (`uuid`, `nestjs-pino`, `pino-http`,
    `supertest`). See `ASSUMPTIONS.md`.
  - **Two plan premises disproved (plan file corrected):** (a) `Buffer<ArrayBufferLike>`
    **already shipped in `@types/node@22.19.20`** — it was never friction for this jump.
    (b) **No `Buffer` crosses into the `acdp` NAPI binding in production code** —
    everything `src/` calls is string-in/string-out; `cosign.ts:757`'s `rawPub: Buffer` is
    a local helper, and the only Buffer→binding crossings are two `.spec.ts` files.
  - **Two hard questions answered with evidence, not assurance:**
    1. *Is `skipLibCheck: true` hiding call-site errors?* **No.** Running with
       `--skipLibCheck false` yields 66 errors, **zero** in `src`/`test` — all
       `drizzle-orm` declaration bugs in dialects never imported. A purpose-written probe
       confirmed call-site checking stays live *with* `skipLibCheck` on (a wrong
       `Uint8Array` arg to the binding still errors `TS2345`).
    2. *Does typing against Node 26 while CI runs Node 22 hide a Node-26-only API?* **No,
       proven structurally.** Since `src`/`test` are byte-identical to `main`, the gate
       compiled the SAME source against `@types/node@22.19.20` in a clean worktree →
       exit 0. If a Node-26-only API were in use, that compile would have failed. Stronger
       than any grep.
  - **DEFERRED, needs a decision:** CI runs Node 22; Docker and now the types say Node 26.
    Before this bump the types were *stricter* than both runtimes (safe direction); now
    they are *looser* than CI's, so the compiler will no longer catch a Node-26-only API
    before it reaches a Node-22 CI run. Harmless today (proven above), but unguarded.
    Cleanest fix is raising CI to Node 26 — its own PR, its own risk. Logged UNCONFIRMED.
  - **Gates:** tsc 0 on both projects; build 0; lint 0; conventions 0; **clean `npm ci` 0**
    (the gate that matters when deleting a devDependency); no escape hatches added
    (`@ts-nocheck`/`@ts-expect-error`/`@ts-ignore` still 0 repo-wide); unit 69 suites /
    768 passed / 3 skipped; integration 25 suites / 155 tests; coverage unchanged
    73.43 / 62.44 / 59.41 / 74.21. `npm audit` delta zero.
  - **Lockfile:** zero packages added, `supertest`/`@types/supertest`/`@types/superagent`
    removed, `@types/node` 22.19.20→26.5.1 + transitive `undici-types` 6.21.0→8.9.0.
  - **Next:** Phase 5 — `eslint` 9→10, `eslint-config-prettier` 9→10,
    `@typescript-eslint` → 8.70.
