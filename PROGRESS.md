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
