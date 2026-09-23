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
| 8 | `typescript` 5.7 → 6.0.3 | Highest — 4 config-level breaks, plus a genuinely silent second-build no-emit regression the mitigations themselves introduced |
| 9 | `@nestjs/cli` + `@nestjs/schematics` 11 → 12 (build tooling only) | Medium — not throttler-blocked; dependency hygiene (drops a redundant nested `typescript`). *Originally "removes the TS compiler split" — that split never existed; see Phase 8.* |
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
  no phase → new **Phase 9**. *(That round also justified Phase 9 as retiring "Phase 8's
  compiler-divergence workaround". Phase 8's verify round 3 later established there was no
  compiler divergence — `nest build` already loaded the top-level compiler — so Phase 9's
  real value is dependency hygiene. Left here as written, corrected in place, because this
  block is a record of what that round concluded.)*
- **Trivially-passing criteria** rewritten: Phase 8's `grep -c '"types"'` (passed on
  `"types": []`), Phase 8's docker-build claim (*asserted then* to prove nothing under option (a) —
  false, per Phase 8 round 3: the image does exercise the TS 6 emit; CI only
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
    Deserves its own issue. **Filed as #158** during the §4 finalization pass, with a
    measured repro: the process exits **1**, not 0, and `stopTelemetry()` never runs.
  - **Next:** Phase 2 — align the `express` declaration to `5.2.1` + add the missing
    `/agents/*did` route-shape test.
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

- **Phase 5 — `eslint` 9→10, `eslint-config-prettier` 9→10, `@typescript-eslint` → 8.70.**
  Branch `chore/eslint-10` off `main` @ `6884e99`. Verify gate: **PASS-WITH-GAPS**,
  Opus-tier, no functional defect found.
  - **Files:** `package.json`, `package-lock.json`. **Zero changes under `src/`, `test/`,
    or `eslint.config.js`** — the config file needed no migration for ESLint 10.
  - **The enforced rule set is provably unchanged, across every config scope.** The
    resolved config grows 183 → 363 entries, but **all 180 additions are `@stylistic/*`
    at severity `0`**, contributed by eslint-config-prettier 10. Added-and-ENABLED 0,
    removed 0, severity-changed 0, options-changed 0. Enforced set is exactly
    `[@typescript-eslint/no-unused-vars, no-console, no-var, prefer-const]`.
  - **Gate correction: my evidence covered 1 of 4 config scopes.** `eslint.config.js` has
    three rule-bearing blocks, so a single-file probe cannot speak for the whole config.
    The gate re-derived across all four: `.ts` files resolve 183→363, **`.spec.ts` files
    resolve 184→364** (the extra entry is `@typescript-eslint/no-explicit-any`, off), and
    `.js` files 178→358. All four scopes: 0 added-and-enabled, 0 removed, 0 changed.
    Conclusion held; the evidence for it had been a quarter as broad as claimed.
  - **Correction to my own claim: the enforced set is NOT identical across scopes.** I
    wrote "enforced set is exactly [4 rules]" for every scope. It is 4 for `.ts` but
    **3 for `.spec.ts`** — `no-console` is deliberately disabled there by the spec
    override block (matching the `check:conventions` exemption for `*.spec.ts`). The
    property that matters — enforced set **unchanged base→branch, per scope** — holds in
    both: `.ts` 4→4 identical, `.spec.ts` 3→3 identical. "Identical across scopes" was my
    wording, not the measurement.
  - **Plan criterion 3 was itself wrong and was rewritten.** It demanded a *byte-identical*
    resolved config, which fails benignly here — 180 entries legitimately appear, all
    disabled. Replaced with "enforced rule set unchanged", which is the property that
    actually protects us and which fails loudly (`exit 1`) on any add-and-enable,
    removal, or severity change.
  - **Fixed a real local/CI divergence the gate surfaced (`package.json:15`).** The `lint`
    script was `eslint "{src,test}/**/*.ts"` with **no `--max-warnings 0`** — that flag
    lived only in `ci.yml:40` / `release.yml:42`. Since **3 of the 4 enforced rules are
    `warn`**, `npm run lint` exited **0** locally on code CI rejects. Moved the flag into
    the script. Proven both directions: a file violating `prefer-const` + `no-console` now
    exits **1** under bare `npm run lint` (it exited 0 before), and CI's
    `npm run lint -- --max-warnings 0` is an idempotent duplicate, still exit 0.
    Pre-existing bug, not introduced here.
  - **Two silent-green failure modes ruled out by direct measurement**, since both would
    have produced exactly the "clean lint" reported:
    1. *Did the lint surface shrink?* **No.** ESLint 10 changed ignore semantics, so the
       gate diffed the `filePath` set from `--format json`: **235 files on base, 235 on
       branch, byte-identical lists**, 0 errors / 0 warnings both sides.
    2. *Does lint still have teeth?* **Yes.** Each of the 4 enforced rules was violated
       individually in a scratch file and each fired — `no-var` as `error`, the other
       three as warnings failing under `--max-warnings 0`.
  - **eslint-config-prettier 10 (a major) is safe here:** export shape unchanged (main
    entry still exports `{rules}`, valid as a flat-config object), `require(...)` in
    `eslint.config.js` still correct, **0 rules removed** (so nothing was silently
    re-enabled), and it **touches none of the 4 enforced rules** — the prettier tail
    cannot disable our enforcement.
  - **No ESLint 10 breaking change applies.** Walked the migration guide item by item: no
    `.eslintrc*`/`.eslintignore`, no `eslint-env` comments (now an error), no `.tsx/.jsx`,
    no programmatic ESLint API, no removed CLI flags (`--no-eslintrc`, `--env`,
    `--rulesdir`, `--ignore-path`, `--resolve-plugins-relative-to`) anywhere in
    `package.json`/`.github/`/`scripts/`, single root config, no custom rules, and the
    repo does not extend `eslint:recommended` so v10's three new recommended rules don't
    land. `linterOptions.reportUnusedDisableDirectives` is unchanged — load-bearing for
    the repo's three live `eslint-disable` comments.
  - **Peers are officially satisfied, not forced:** `@typescript-eslint@8.70.0` declares
    `peer eslint: ^8.57.0 || ^9.0.0 || ^10.0.0`. Single deduped `eslint@10.10.0`, no
    shadow copy, `npm ci` clean with no `--force`/`--legacy-peer-deps` and no peer
    warnings.
  - **Gates:** lint 0 (both invocation forms); tsc 0; build 0; conventions 0; unit 69
    suites / 768 passed / 3 skipped; integration 25 suites / 155 tests.
  - **DEFERRED, third phase to raise it:** ESLint 10's engine floor is
    `^20.19.0 || ^22.13.0 || >=24`. There is **no `engines` field, no `.nvmrc`, no
    `engine-strict`** — nothing stops a contributor on Node 20.18 or 22.12 from installing
    and hitting a runtime failure. CI's `node-version: '22'` satisfies the floor only
    because it resolves to the latest 22.x. This compounds the Phase 4 divergence (CI 22 /
    Docker 26 / types 26). Still its own PR. Logged UNCONFIRMED.
  - **REBASED mid-flight onto #146.** A Dependabot bundle ("bump the minor-and-patch
    group with 8 updates", `8cceb7b`) landed on `main` while PR #148 was open, touching
    the same two manifests → `DIRTY`. Caught by the monitor's mergeability check on the
    first poll, **before** CI ran. Notes:
    - **#146 already bumped `@typescript-eslint/eslint-plugin` to `^8.70.0`**, so that
      package is now main's and Phase 5's diff shrinks to `parser` + `eslint` +
      `eslint-config-prettier` + the lint-script fix.
    - **#146 also moved runtime deps my gates never covered** — the ACDP SDK
      `0.8.3→0.8.5` and four OpenTelemetry packages. Every gate was therefore **re-run
      from scratch** rather than carried forward, since the pre-rebase results described
      a tree that no longer exists. All re-passed: lint 0, tsc 0 (both projects), build 0,
      conventions 0, unit 69/768/3, integration 25/155.
    - **All evidence above was re-derived against the new base `8cceb7b`**, not the
      original `6884e99`: enforced sets identical per scope, and the lint surface is
      **235 files on base, 235 on branch, byte-identical**.
    - Resolution method: took main's `package.json` wholesale and re-applied exactly the
      four edits (verified by `git diff origin/main -- package.json`), then regenerated
      `package-lock.json` from main's rather than hand-merging 587 conflicted lines.
    - **The Phase 2 rule ("branch each phase only after the previous merges") does not
      prevent this** — Dependabot can land on `main` at any time. The monitor's
      `DIRTY`/`CONFLICTING` check is the actual defense. Keep it in every phase.
  - **Phase 6 intel — a named open handle.** The integration run reports exactly one:
    **`CustomGC`**, the NAPI binding's native GC thread, triggered by importing
    `@agentcontextdistributionprotocol/acdp` (`src/auth/acdp-verify.ts:17`). Pre-existing
    and structurally unattributable to this diff (eslint devDependencies cannot reach
    runtime NAPI threads). Jest 30's stricter teardown is expected to surface this exact
    class of handle — so Phase 6 now has a *named* baseline handle to compare against
    instead of a vague "a worker process failed to exit gracefully".
  - **Next:** Phase 6 — `jest` 29→30, `@types/jest` 29→30. **Baseline must be re-recorded
    first:** the plan gates against `68 suites / 766 passed / 3 skipped`, but Phases 2–3
    added specs and `main` is now **69 / 768 / 3**. Phase 6 is also the one phase with
    genuinely uncertain evidence — a jest-30 trial showed `67 / 748 / 21`, and the tidy
    explanation for that delta was **disproved in Phase 0**, so any deviation must be
    investigated, not waved through.

- **Phase 6 — `jest` 29→30, `@types/jest` 29→30.** Branch `chore/jest-30` off `main` @
  `5ab392f`. **No `ts-jest` bump** — `ts-jest@29.4.12` already peers
  `jest: ^29.0.0 || ^30.0.0`.
  - **Files:** `package.json`, `package-lock.json`. **Zero changes under `src/` or
    `test/`**, and `coverageThreshold` is numerically untouched.
  - **THE 18-TEST MYSTERY IS SOLVED — and it was never jest.** Two prior investigations
    (the round-1 trial, then Phase 0) chased a `67 / 748 / 21` spec count against the
    expected `.. / .. / 3`. Phase 0 tested the `ACDP_SPEC_DIR` hypothesis and correctly
    **disproved** it, leaving the delta unexplained and flagged as "a possible real
    jest-30 effect." It is neither. The cause is **location-dependent fixture
    discovery**:
    - `src/audit/cosign.spec.ts:46` and `log-verify.parity.spec.ts:39` locate conformance
      fixtures via `path.resolve(__dirname, '../../../agentcontextdistributionprotocol/schemas/conformance')`
      — a `__dirname`-relative **sibling** path, with `ACDP_SPEC_DIR` as the only override.
    - From the canonical checkout that resolves to a real sibling repo → fixtures found →
      conformance runs → **3 skips**.
    - From **any other location** (a git worktree, a copied tree, a CI checkout without
      the sibling) it resolves to a nonexistent path → `describe.skip` → **1 suite + 18
      tests skip → 21 skips**.
    - **Proved by reproducing it on jest 29**, not jest 30: the same commit run in a
      worktree gives `68 / 750 / 21`; re-run with `ACDP_SPEC_DIR` pointed at the real
      fixtures it gives `69 / 768 / 3`. The variable is the tree's filesystem location —
      which nobody had thought to vary, because it is not a variable anyone expects.
    - **The arithmetic closes exactly.** My reproduction is `68 / 750 / 21` while the
      number being explained was `67 / 748 / 21`. The residual is not slack: `main` was
      `68 / 766 / 3` when that older trial ran (Phases 2-3 had not yet added their
      specs), and `68 − 1 suite = 67`, `766 − 18 tests = 748`. Same mechanism, older
      baseline.
    - **This invalidated my own first measurement**, which compared jest-29-in-a-worktree
      against jest-30-in-the-main-tree — i.e. two different test sets. Discarded and redone.
    - **The gate strengthened the proof**: it reproduced the split on **jest 30 alone**
      (worktree without `ACDP_SPEC_DIR` → `68/750/21`; same tree with it → `69/768/3`),
      which removes the jest version as a variable entirely rather than merely showing
      jest 29 can also exhibit it.
  - **CI is NOT exposed to that skip.** `ci.yml:27-31,51-52` checks the spec repo out to
    `acdp-spec`, sets `ACDP_SPEC_DIR` explicitly, AND sets `ACDP_REQUIRE_CONFORMANCE=1`
    so a missing checkout is a **hard failure** rather than a silent skip — the CP-7
    lesson, already correctly applied. The silent skip only bites local runs from a
    non-canonical path. Pre-existing; out of scope for a jest bump, but recorded because
    it cost two investigations.
  - **Spec counts identical to baseline.** Unit `69 suites / 768 passed / 3 skipped`;
    integration `25 suites / 155 passed`. The feared delta did not occur.
  - **Open handles — I reported a LOSS OF SIGNAL as good news. Corrected.** jest 29's
    integration run reports `CustomGC` (the NAPI binding's native GC thread); jest 30
    reports zero (`grep -ic` → 29: 2, 30: 0). I wrote that the handle is "**gone**". It
    is not. The gate held Node (`v26.8.1`) and the SDK (`acdp@0.8.5`) constant across
    both runs, leaving jest as the only variable — so **nothing stopped leaking; jest 30
    stopped reporting it.** That is a small *reduction* in `detectOpenHandles` fidelity
    on the integration config, not a fix.
    **The feature is narrower, not dead** — the gate planted a real leak (a listening
    `net.Server`) and jest 30 still reported it (`● TCPSERVERWRAP`). So the plan's
    prediction (that jest 30 would surface MORE handles) was still wrong, but the right
    reading is "one fewer native handle is reported", not "a leak was fixed".
  - **Coverage: only BRANCH COUNTING changed. This is NOT a coverage improvement.**
    Global branches rise 62.44 → 66.02, which looks like good news and isn't. Measured
    raw, both runs at an identical `69/768/3`:

    | | jest 29 | jest 30 |
    |---|---|---|
    | statements | 3723 / 5070 | **3723 / 5070** |
    | functions | 448 / 754 | **448 / 754** |
    | branches | 1362 / 2181 | 1852 / 2805 |

    Statements and functions are **byte-identical in both numerator and denominator** —
    that is the control, and it proves test *execution* is unchanged and only branch
    **instrumentation** moved. jest 30 instruments **+624 branches (+28.6%)**, of which
    490 happen to be covered. Consistent with its istanbul upgrade now counting `?.` and
    `??` (359 occurrences in `src` alone, and `collectCoverageFrom` includes specs).
    Branch % moved in **70 of 165 table ROWS in BOTH directions** — 57 better, **13
    worse**. (Counting actual FILES rather than rows: `coverage-final.json` holds **132**
    files in both runs with identical key sets, and branch % moved in **48 of 132**. The
    165 is 132 files + 32 directory rows + the `All files` row — my earlier "70 of 165
    files" used the wrong noun.)
    **The 13 regressed rows span 8 source files — I originally listed only two, a 4×
    undercount:**

    | file | jest 29 | jest 30 |
    |---|---|---|
    | `auth-sweeper.service.ts` | 62.50 | 50.00 |
    | `app-config.service.ts` | 73.55 | 68.55 |
    | `safe-federation-client.ts` | 80.00 | 78.57 |
    | `memory-stream-hub.strategy.ts` | 56.25 | 54.16 |
    | `redis-stream-hub.strategy.ts` | 64.28 | 52.94 |
    | `event-processor.service.ts` | 94.38 | 93.00 |
    | `quota.guard.ts` | 93.75 | 90.90 |
    | `data-retention.service.ts` | 66.66 | 64.70 |

    All are instrumentation artifacts, and the only threshold is `global` (no per-file,
    no per-glob), so none is at risk. Statements/functions/lines differ in **0** rows —
    and per-file `statementMap`/`fnMap` entry counts differ in **0 of 132 files**,
    which is the strongest form of the control.
    Mechanism confirmed in the lockfile: **`babel-plugin-istanbul` 6.1.1 → 8.0.0**, with
    the pinned `istanbul-lib-instrument@5.2.1` dropped.
    **Do not report this as improved coverage.** The thresholds still pass on merit
    (branches 66.02 vs 58), but the aggregate rise is a measurement artifact.
  - **jest 30 adds TWO packages with install scripts, not one — I missed the riskier
    one.** I flagged `unrs-resolver@1.12.2` (`postinstall: napi-postinstall … check`).
    The lockfile diff also adds **`@parcel/watcher@2.6.0`**, whose script is
    `install: node scripts/build-from-source.js` — a **compile-from-source** step,
    strictly higher-risk than a check script and the one that could actually fail an
    install on an unusual platform. Benign here (prebuilt bindings for all 12 platforms
    are in the lockfile, and it is only used by `--watch`), but it was absent from my
    blast-radius sweep.
  - **Correction: my Dockerfile reasoning was half-wrong.** I wrote "the production image
    builds `--omit=dev` so it never sees jest." Only the **runner** stage does.
    `Dockerfile:16` is `RUN npm ci --no-audit --no-fund` in the **builder** stage, which
    installs jest 30, `unrs-resolver` and `@parcel/watcher` *with* their scripts — and it
    runs on every PR via CI's `docker` job. The conclusion (safe) survives; the stated
    reason did not. Verified in fact: `npm run build` → 0.
  - **A blocked postinstall does not break jest** — verified, not assumed. In a pristine
    clone this npm blocked both scripts (`6 packages have install scripts not yet covered
    by allowScripts`) and `npm ci` still exited **0**, with jest running **69/768/3** in
    that tree. The native binding arrives via `optionalDependencies`, not the script; all
    22 `@unrs/resolver-binding-*` platforms (incl. `linux-x64-gnu`/`-musl`) are in the
    lockfile, so CI's ubuntu `npm ci` has no cross-platform gap. No `--ignore-scripts`
    in any workflow or the `Dockerfile`; no `.npmrc`.
  - **`@sinonjs/fake-timers` jumped 10 → 15** (two majors). Exposure is exactly one spec,
    `src/contexts/safe-federation-client.spec.ts:305` (`advanceTimersByTimeAsync`) — passes.
  - **Pre-flight sweep, all zero:** removed matcher aliases (`toBeCalled*`, `lastCalledWith`,
    `nthCalledWith`, `toReturn*`, `lastReturnedWith`, `nthReturnedWith`, `toThrowError`),
    `genMockFromModule`, `testPathPattern`, `--filter`. All three `jest.mock()` paths
    case-match exactly (jest 30 made these case-sensitive). Both configs set
    `moduleFileExtensions`/`testRegex`/`testEnvironment` explicitly, so jest 30's changed
    defaults are not in play.
  - **Gates:** tsc 0 on `tsconfig.json` **and** `test/tsconfig.test.json` (the latter is
    what proves `@types/jest@30` globals still satisfy every spec); build 0; lint 0;
    conventions 0; unit 69/768/3 with coverage thresholds met; integration 25/155.
  - **Next:** Phase 7 — `ioredis` 5→6. Needs a **CI change, not just a bump**: a `redis:7`
    service on the integration job plus a live-Redis spec that fails loudly when
    `CI=true` and `REDIS_URL` is unset. Both existing Redis specs mock the client away
    and prove nothing about v6's RESP3 default.
  - **Verify gate also confirmed, independently, what I had NOT proven:**
    - **No production-dependency drift from the lockfile regeneration** — the classic
      defect for a phase of this shape. Every non-dev package diffed between `5ab392f`
      and this branch: **0 added, 0 removed, 0 version changes, 0 dev-flag flips**.
    - **No silent test SWAP behind an equal count.** `768 == 768` could hide a
      substitution, so the gate exported `--json` from both jest versions on identical
      trees and compared `file :: fullName :: status` triples: `771` vs `771`,
      **0 only-in-29, 0 only-in-30**. Same tests, same statuses.
    - **The suite still has teeth under jest 30** — three source mutations, all caught:
      `log-verify.ts` §5.1 node-hash prefix `0x01→0x02` → 3 suites / 8 tests failed;
      `tenantOf()` → always `DEFAULT_TENANT_ID` → 4 failed; `ingest.service.ts:103` HMAC
      check → `if (false)` → 2 unit + **1 integration suite / 2 tests** failed (so the
      integration suite has teeth too, not just the unit suite).
    - **`@types/jest@30` did not loosen type checking.** It still uses the
      DefinitelyTyped two-parameter `jest.fn<TReturn, TArgs>` shape, so jest 30's
      advertised strict `CalledWith` inference does **not** apply — but that is
      **identical under `@types/jest@29`**, i.e. pre-existing looseness, not a
      regression. Real type errors are caught identically under both (`TS2345 ×2`,
      `TS2322 ×1`). No `jest.Mocked`/`jest.SpyInstance`/`expect.extend` in the repo.
    - **The one jest 30 change that could create FALSE PASSES was tested empirically** —
      "non-enumerable properties excluded from object matchers". 45 `toMatchObject` call
      sites, `message:` inside them → 0, and the asserted props are own-enumerable. Under
      jest 30 both `toMatchObject({hidden:'WRONG'})` on a non-enumerable prop and
      `toMatchObject({message:'WRONG'})` on an Error still **fail**. No teeth lost.
    - `npm ls jest` → single `jest@30.5.1`, `ts-jest` deduped onto it, all `@jest/*` at
      30.x, no 29.x stragglers. Snapshots: **0 total**, so every snapshot-format change
      in jest 30 is inert. Docs carry no stale jest version strings.

- **Phase 7 — `ioredis` 5→6.** Branch `chore/ioredis-6` off `main` @ `88bed02`. **The
  first phase with real code + CI changes, not a manifest bump.**
  - **Files:** `package.json`, `package-lock.json`,
    `src/events/redis-stream-hub.strategy.ts`, `src/events/redis-stream-hub.strategy.spec.ts`
    (comment only), `.github/workflows/ci.yml`, `docker-compose.test.yml`,
    `test/setup/global-setup.ts`, **NEW** `test/integration/redis-live.integration.spec.ts`.
  - **RESP3 verified against a LIVE server — the only thing that could verify it.**
    `redis-stream-hub.strategy.spec.ts` mocks `ioredis` away and `quota-store.spec.ts`
    duck-types `.eval`, so **neither proves anything about the wire protocol**. Stood up
    a real `redis:7` and drove the exact three operations the repo depends on:
    - pub/sub round-trip **delivered**, and `sub.mode === 'normal'` (as the plan predicted
      — RESP3 uses push frames but ioredis does not flip `mode`)
    - the quota Lua returned `[1,60]` then `[2,60]` — the exact 2-element numeric shape
      `RedisQuotaStore.increment` reads at `quota-store.ts:97-102`
    - `quit()` → `OK` on both clients
    All three v6 defaults the plan flagged, confirmed on the live client: `protocol: 3`,
    **`replyMapping: 'legacy'`** (this is what preserves the v5 reply shapes the Lua
    reader depends on — do NOT set `resp3`), `keepAlive: 30000` (was `0`).
  - **I proposed a bug and then DISPROVED IT MYSELF.** I expected the missing `'error'`
    listener on `RedisStreamHubStrategy` to crash the process, since an EventEmitter
    emitting `'error'` unhandled throws. **Tested on both ioredis 5 and 6: it does not.**
    ioredis guards the EventEmitter default internally and prints
    `[ioredis] Unhandled error event: …` on raw stderr. So the defect is **narrower than
    I claimed**: that line bypasses the pino/Nest logger entirely, so a connection
    failure is invisible to structured log aggregation while SSE fan-out silently stops.
    Fixed by attaching handlers that route through the Nest logger. Written up as what it
    is, not what I guessed.
  - **"Normalizing the imports" was supposed to be cosmetic. It exposed a type that was
    lying.** The plan (round 1) correctly established that both `require('ioredis')` and
    `await import('ioredis')` work in v6, so normalizing is hygiene, not a fix. But
    switching `require()` → `await import()` turns on **real typing**, and `tsc`
    immediately failed: the hand-written duck type declared subscribe's callback as
    `(err: Error | null) => void`, while ioredis's actual `Callback<T>` **also admits
    `undefined`**. The untyped `require()` had been concealing the mismatch. Both clients
    are now typed against ioredis's own `Redis` type via `import type` — erased at
    runtime, so **no new runtime coupling**.
  - **Checked, not assumed: does the unit mock survive the new import form?**
    `jest.mock('ioredis', () => FakeRedis)` returns the class itself, which has **no
    `.default`** — and the strategy now destructures one. `FakeRedis.default` is
    `undefined`, so `new undefined()` would throw into `connect()`'s catch and **the spec
    would still have passed while exercising nothing** (exactly the plan's item-5
    concern). Verified empirically instead: the spec logs `Connected to Redis stream hub`,
    so TypeScript's `esModuleInterop` helper synthesizes `.default` for the CommonJS mock
    and the destructure resolves. Benign — but only because it was measured.
  - **CI wiring done the way the plan insists — a GitHub Actions service, NOT compose.**
    `global-setup.ts:10` skips docker-compose entirely when `CI` is set, so a
    compose-only Redis **would never exist in CI** and the live spec would skip forever
    while reporting green. That is the CP-7 defect this repo already fixed once. So:
    `ci.yml` gets a `redis:7` **service** + `REDIS_URL` on the `integration` job (renamed
    "jest integration (Postgres + Redis)"), and `docker-compose.test.yml` gets a
    `redis-test` service on **6380** (not 6379, so it cannot collide with a developer's
    own Redis) that `global-setup` now starts alongside `postgres-test`.
  - **The new spec CANNOT report a false green — all four paths proven:**

    | scenario | result |
    |---|---|
    | `CI=true`, `REDIS_URL` unset | **fails loudly** (`exit 1`), never skips |
    | `CI=true`, Redis unreachable | **fails loudly** (`exit 1`) |
    | pub/sub delivery broken (mutant: publish to wrong channel) | **fails** — `no message delivered within 5s` |
    | Lua returns 1 element instead of 2 (mutant) | **fails** |

    Local-without-Redis is the only skip path, and CI can never reach it.
  - **Deliberate trade-off recorded:** each case early-returns when Redis is absent rather
    than using `it.skip`, because reachability is not known at collection time. That path
    is **local-only** — `beforeAll` throws in CI — so CI can never produce a
    trivially-passing green.
  - **Gates:** tsc 0 on both projects; build 0; lint 0; conventions 0; unit **69 suites /
    768 passed / 3 skipped** (unchanged); integration **26 suites / 158 passed** (was
    25/155 — exactly the three new cases).
  - **Process note:** I briefly ran a second jest against the integration config while one
    was already running. Both share `globalSetup`/`globalTeardown`, which start and
    **remove** docker containers — so concurrent integration runs can tear down each
    other's Postgres. No damage (the first run had already finished), but integration
    runs must be serial.
  - **Next:** Phase 8 — `typescript` 5.9→6.0.3. The only phase that changes compiler
    *semantics*; needs `types: ["node","jest"]` in `tsconfig.json`, `rootDir` in BOTH
    `tsconfig.build.json` and `test/tsconfig.test.json`, and `ignoreDeprecations: "6.0"`.
  - **VERIFY GATE RETURNED *FAIL*. One blocking CI-only defect I introduced, plus a
    vacuous assertion in the very spec whose selling point was "cannot report a false
    green." Both fixed and re-proven.**
    1. **BLOCKING — my CI change would have hung the integration job forever, AFTER
       printing all-green.** Adding `REDIS_URL` to the job env makes `QuotaModule`'s
       factory build a real, never-closed ioredis client in **24 of the 26** integration
       specs (every one that boots `AppModule`). The open socket keeps Node's event loop
       alive, so jest never exits: all tests pass, `npm run test:integration` never
       returns, and the job burns to GitHub's 360-minute timeout. The gate proved it with
       an A/B differing ONLY in `REDIS_URL` (`EXIT=0` in 3s vs killed at 60s; one attempt
       ran >600s past the summary line) plus `lsof` on the hung PID showing the
       ESTABLISHED socket to 6380.
       **Why I missed it:** I proved the four false-green paths on the live spec **in
       isolation**, and ran the FULL suite only **without** `REDIS_URL` — which is exactly
       how it runs locally, since `global-setup` starts `redis-test` but deliberately
       never exports `REDIS_URL`. I never once ran the full suite under the CI env I was
       adding. *A CI-only change must be tested under the CI environment, not the local one.*
       **Fixed two ways, both proven:**
       - **`quota.module.ts` now honors the condition it already DOCUMENTED.** Its
         docblock promises "no Redis traffic even when a Redis URL is configured" when
         `TENANT_QUOTAS` is empty, and the factory comment claims it requires "(a) tenants
         configured AND (b) REDIS_URL" — but the code only ever checked (b). Condition (a)
         was documented and never implemented. Now `config.redisUrl && quotaConfig.byTenant.size > 0`.
       - **`QuotaModule.onModuleDestroy` + `RedisQuotaStore.close()`** release the client
         on shutdown, for the case where quotas ARE configured. `close()` never throws, so
         a failing transport cannot block shutdown.
       **Proof of the fix, under the EXACT CI env** (`CI=true REDIS_URL=redis://localhost:6380`,
       full suite): **`EXIT=0` in 14s**, 26 suites / 158 passed, and **0 specs build a
       Redis quota store**. Proof `onModuleDestroy` is not dead code: with
       `TENANT_QUOTAS=acme:publish=100/min` the factory logs `Quota store: redis`, and
       after `app.close()` the process **exits on its own** (`EXIT=0`).
    2. **The RESP3 test was VACUOUS — it asserted a library constant.** It checked
       `pub.options.protocol === 3`, but that is the **compile-time default**, and ioredis
       deliberately never mutates it on a downgrade — it sets `condition.protocol = 2` and
       leaves the option alone (`built/redis/event_handler.js`: *"so just warn — don't
       touch the option"*). So a connection that had silently fallen back to RESP2 passed
       green under a title claiming it "negotiates RESP3". **Measured against a real
       `redis:5-alpine`: `options.protocol=3` while `condition.protocol=2`.** Now asserts
       the NEGOTIATED value. **Teeth re-proven:** against redis:5 the fixed test FAILS
       (`Expected: 3, Received: 2`) where the old one passed.
    3. **Docs were stale** — the change added a Redis prerequisite that nothing documented.
       Following `docs/TROUBLESHOOTING.md` verbatim brought up Postgres only, landing the
       new spec on its local-skip path. Updated `docs/TESTING.md`, `docs/TROUBLESHOOTING.md`
       (incl. a new entry for the skip message), and `README.md` with the `redis-test`
       service, port 6380, and the skip policy. Also recorded WHY `global-setup` must not
       export `REDIS_URL`: doing so flips `QuotaModule` onto the Redis store for every
       other spec — which is defect 1.
    4. **Image drift:** compose used `redis:7-alpine` while CI used `redis:7`. A
       wire-protocol spec that verifies against a different server locally than in CI
       defeats its own purpose. Both now `redis:7`.
    5. **The new error handler flooded logs.** It logged at ERROR on *every* reconnect
       attempt and ioredis 6 retries indefinitely — 14 ERROR lines in 4s against a dead
       port. Now logs once per healthy→failed TRANSITION, with a matching `reconnected`
       line on recovery. **Measured after the fix: 2 lines in 5s** (one per client).
  - **Gate independently confirmed, clean:** the mock-survival claim (instrumented
    `FakeRedis` with a constructor counter: `PROBE_CTOR_COUNT=2`, both clients are real
    `FakeRedis` instances — `esModuleInterop` does synthesize `.default`); the no-crash
    claim (ioredis `built/Redis.js:580-586` only emits when a listener exists, else
    `console.error` and `return false`); every RESP3 live fact; ioredis 6's CHANGELOG
    documents exactly **two** breaking changes (Node ≥20, RESP3 default) and neither
    `Cluster`/`defineCommand`/`stringNumbers`/`reconnectOnError` nor changed
    `maxRetriesPerRequest`/`enableReadyCheck`/`lazyConnect` defaults apply here; and
    **`@opentelemetry/instrumentation-ioredis@0.70.0` declares `['>=2.0.0 <7']`, so
    ioredis 6 is still instrumented** — a range miss there would have silently dropped
    every Redis span.
  - **Revised gates:** tsc 0 (both projects); build 0; lint 0; conventions 0; unit **69
    suites / 770 passed / 3 skipped** (+2 — the new `close()` cases); integration **26
    suites / 158 passed**, and critically **exits 0 in 14s under the full CI env**.
  - **CI CONFIRMED the fix, then a COSMETIC RENAME blocked the merge — my error.**
    PR #152's CI went fully green in 44s: `jest integration` **SUCCESS** with **26 suites
    / 158 passed**, matching local exactly. That is conclusive that the live spec RAN
    rather than skipped — in CI an unreachable Redis makes `beforeAll` throw and the
    suite fail, so a green 26/158 proves it connected to the service container. It also
    proves the `services:` block is valid and **the job did not hang**.
    But the merge was refused: *"the base branch policy prohibits the merge."*
    **Cause: I renamed the job to `jest integration (Postgres + Redis)`, and
    `main`'s branch protection requires a status check named EXACTLY
    `jest integration (Postgres)`** (`required_status_checks.contexts`). A renamed job
    means the required check never reports, so the PR is blocked **forever** — not
    failed, just permanently unmergeable. **Reverted the name** and added a DO-NOT-RENAME
    comment citing the protection rule. Deliberately did NOT edit branch protection or
    reach for `gh pr merge --admin`: the rename bought nothing, and weakening a
    protection rule to accommodate cosmetics is the wrong trade.
    **Lesson: a CI job's `name:` is an API contract with branch protection, not a label.**
  - **Also fixed: my CI watcher reported a false green.** It declared all checks passed
    while `jest integration` was still `IN_PROGRESS`. Cause: `jq`'s `.conclusion // .status`
    only falls back on `null`/`false`, and an in-progress check carries `conclusion` as an
    **empty string**, which is truthy — so the expression yielded `""` and the
    pending-pattern never matched. Now gates on `status == "COMPLETED"` with an explicit
    pending count. This matters disproportionately here: the defect this phase fixes
    presents as a job that runs FOREVER, not one that fails, so a watcher that treats
    "not yet reported" as "passed" is precisely blind to it.

- **Phase 8 — `typescript` 5.7 → 6.0.3.** Branch `chore/typescript-6` off `main` @
  `a97d311`. **The only phase that changes compiler SEMANTICS.**
  - **Files:** `package.json`, `package-lock.json`, `tsconfig.json`,
    `tsconfig.build.json`, `test/tsconfig.test.json`. **Zero changes under `src/` or
    `test/`** — and, importantly, **zero suppressions**: `@ts-ignore` /
    `@ts-expect-error` / `@ts-nocheck` remain at **0 repo-wide**. The migration passes on
    merit, not by silencing the compiler.
  - Version bump and tsconfig changes land in **one commit**, per the plan — splitting
    them produces a knowingly-broken intermediate state.
  - **All three mitigations PROVEN load-bearing by removing each and measuring**, rather
    than applied on faith:

    | mitigation | removed → | restored → |
    |---|---|---|
    | `types: ["node","jest"]` in `tsconfig.json` | **3315 errors** — 2160 `TS2304` (1832 × `expect`, 261 × `jest`, 32 × `beforeAll`, …), 1105 `TS2593`, 40 `TS2503`, 10 `TS7006`/`TS7031` | 0 |
    | `rootDir: ".."` in `test/tsconfig.test.json` | **71 × `TS6059`** ("not under 'rootDir'") | 0 |
    | `rootDir: "./src"` in `tsconfig.build.json` | **`TS5011`, `nest build` exits 1**; emit relocates to `dist/src/` and `dist/main.js` is ABSENT | `dist/main.js` present |

    **Correction (verify round 1).** An earlier version of this entry claimed the third
    mitigation's absence was "a silent, runtime-only break — the build still SUCCEEDS."
    That was wrong, and the verifier caught it. Re-measured: removing the build `rootDir`
    makes `nest build` exit **1** with `TS5011` ("The common source directory … must be
    explicitly set"), and raw `tsc -p tsconfig.build.json` exits **2**. The relocation to
    `dist/src/` and the absence of `dist/main.js` are real, but the failure is **loud**.
    The plan itself listed `TS5011` as a hard error; the narrative contradicted it.
    This mattered beyond bookkeeping: it inverted the risk a reviewer was being asked to
    accept, and it attached the words "silent" and "exit 0" to the wrong mitigation —
    while the change that genuinely *did* fail silently at exit 0 (below) went unnamed.
  - **The `test/tsconfig.test.json` `rootDir` is the item the ROUND-0 PLAN MISSED** and
    which would have failed its own criterion 4 outright. Round 1 caught it; this phase
    confirms the measurement exactly (71, predicted 70-72). `TS6059` fires even under
    `--noEmit`, so it would also have broken ts-jest's integration transform, which points
    at that same config (`test/jest.integration.config.ts:11`).
  - **There is NO two-compiler split — I claimed one twice, and both times it was wrong.**
    `npm ls typescript` shows `6.0.3` top-level plus a nested `5.9.3` under
    `@nestjs/cli@11.0.24`, and I concluded from that listing that `nest build` emits with
    5.9.3. It does not. `@nestjs/cli`'s `typescript-loader.js` resolves the compiler with
    **`process.cwd()` first**, and npm scripts run with cwd = package root, so
    `nest build` loads the **top-level 6.0.3**. The nested copy is installed but never
    executed. Proven three ways: the loader's own `load().version` reports `6.0.3`;
    moving the nested install aside entirely leaves `npm run build` green at 133 files;
    and removing the build `rootDir` makes `npm run build` fail with `TS5011 … Visit
    https://aka.ms/ts6` — a TypeScript **6.0-only** diagnostic, emitted through the CLI.
    **Round 1's "correction" was itself wrong** and made things worse: it added the claim
    that `@nestjs/cli` "discards config-level diagnostics," which that same `TS5011`
    result directly falsifies — and the evidence contradicting it was already sitting in
    this file's own mitigations table, unreconciled. The measurement round 1 *did* make
    (`@nestjs/cli/node_modules/typescript/bin/tsc` → `TS5103`) is real but exercises a
    binary nothing ever runs, which is precisely why a wrong conclusion looked evidenced.
    **Lesson worth keeping: `npm ls` describes what is INSTALLED, not what is LOADED.**
    Resolution order decides, and it had to be read from the tool's source.
    Consequences: the assumption is **WITHDRAWN**, not left unconfirmed; the two nodes in
    `npm ls typescript` are cosmetic; and **Phase 9 is dependency hygiene, not compiler
    unification** — every compiler the repo runs is already 6.0.3.
  - **Emit parity is CROSS-VERSION and stronger than first recorded:** `main` @ `a97d311`
    built with 5.9.3 vs this branch built with 6.0.3 — all 133 `.js` and every `.d.ts`
    **byte-identical**, decorator metadata equal on both sides (`__metadata` 287/287,
    `design:paramtypes` 109/109, `design:type` 135/135). That is what actually licenses
    this bump, and it holds independently of the split confusion above.
  - **`baseUrl` deleted, `ignoreDeprecations: "6.0"` added.** Under 6.0 these are HARD
    errors, not warnings (`TS5101` for `baseUrl`, `TS5107` for `moduleResolution: node10`).
    `baseUrl: "./"` was safely deletable — no `paths`, every import relative or a bare
    package specifier. Kept node10 resolution behind `ignoreDeprecations`:
    switching to `nodenext` imposes ESM/CJS interop strictness on 100+ files, drizzle's
    exports map, and the NAPI binding all at once — a separate migration, not a bump.
    **Correction (verify round 1):** criterion 3 requires that deferral to carry a TODO
    referencing the TS 7 removal, and this commit originally claimed one while `tsconfig.json`
    had none. Now added — with the forward risk measured rather than asserted: against
    `typescript@7.0.2` this exact config yields exactly one error, `TS5108: Option
    'moduleResolution=node10' has been removed`, and `ignoreDeprecations` itself stops
    working in 7.0, so there is no second reprieve. The TODO also records that TS 6.0 newly
    permits `module: commonjs` with `moduleResolution: bundler` (TS5095 in 5.9), making
    `bundler` a materially smaller escape than the `nodenext` migration rejected here.
  - **Verified, not assumed, for the changes the plan called "already satisfied":** legacy
    `module Foo {}` namespace syntax → **0 hits**; `target: ES2022` (es5 deprecated /
    `downlevelIteration` removed — neither in play); `module: commonjs` (amd/umd/systemjs
    removed); `alwaysStrict` not set; `experimentalDecorators` + `emitDecoratorMetadata`
    still **true** — load-bearing for every NestJS decorator and `class-validator` DTO,
    and unaffected by 6.0.
  - **BLOCKING defect found at the verify gate, and it was self-inflicted by this very
    phase.** Adding `rootDir: "./src"` moves the DEFAULT `.tsbuildinfo` out of `outDir` —
    tsc resolves it as `resolve(outDir, relative(rootDir, <config>))`, which lands it at
    the **repo root**. `nest-cli.json` sets `deleteOutDir: true`, so `dist/` is wiped while
    the build state survives; tsc then concludes everything is up to date and **emits
    nothing, exiting 0**. Measured on the branch:

    ```
    build 1: exit=0  js=133
    build 2: exit=0  js=0     <-- dist/ DOES NOT EXIST, and the build reports success
    ```

    `npm run start` / `start:dev` — the documented dev loop in `CLAUDE.md` — died with
    `Cannot find module '.../dist/main'`. **This is the mirror image of Phase 7's defect:**
    that one was CI-only, this one is local-only. CI never runs `npm run build` outside
    Docker (`ci.yml` used `npx tsc --noEmit`), and the Dockerfile's explicit `COPY` list
    never copies a root `tsbuildinfo`, so **CI stayed green while local development was
    broken**. Criterion 7 (`rm -rf dist && npm run build`) structurally cannot catch it —
    deleting `dist` does not delete a root-level buildinfo, and the first build always
    looks fine.
    **I saw the symptom and misfiled it.** The `.gitignore` hunk I added in this same
    commit describes the relocation as untracked-file hygiene. It was a build-correctness
    regression, and I documented it as tidiness.
    **Fix:** `tsBuildInfoFile: "./dist/tsconfig.build.tsbuildinfo"` in
    `tsconfig.build.json`, putting the state back inside `outDir` so it shares `dist/`'s
    lifecycle. Three consecutive builds now emit 133 files each. The `.gitignore` entry
    stays as belt-and-braces.
  - **New regression guard: `scripts/check-build-emit.sh`** (`npm run check:build`), wired
    into CI's unit job. The plan recommended an emit-shape smoke check and Phase 8
    originally shipped without one — it was the exact control needed. It asserts
    `dist/main.js` + `dist/db/migrate.js` exist, no `dist/src/`, ≥100 `.js` emitted, no
    stray root `.tsbuildinfo`, and that `dist/main.js` actually loads (module graph intact,
    not just file-present). Crucially it **builds TWICE** — a single build cannot detect
    the defect above. Proven to have teeth in both directions: reverting `tsBuildInfoFile`
    → fails on build 2; removing build `rootDir` → fails on `TS5011`.
  - **Verify gate:** Opus, **3 rounds**.
    - **Round 1 = `GAPS`** — 1 blocking (buildinfo escape), 1 high (false split-safety
      claim), 4 smaller (loud-vs-silent mischaracterisation, missing TS 7 TODO, missing
      emit guard, wrong error-code attribution).
    - **Round 2 = `GAPS`** — 5 of 6 confirmed closed, but **the round-1 fix to the split
      claim was itself wrong**: it replaced one false mechanism with another (see above),
      propagating it into four documents plus the plan. Also found that
      `check-build-emit.sh` had a `set -euo pipefail` defect where `find` on a missing
      `dist/` aborted the script mid-report — CI still went red, but the run omitted the
      stray-`.tsbuildinfo` line that names the root cause. Both fixed; the guard now
      prints its full report under the regression, and additionally asserts that build 1
      and build 2 emit the *same* count.
    - **Round 3 = `GAPS` (prose only)** — mechanism confirmed correct and every gate
      green, but the round-2 correction had been applied to most, not all, of the places
      carrying the false claim: 6 residual spots, including the Phase 8 entry's own
      closing line still saying Phase 9's "whole point is retiring the split above", 100
      lines after the entry withdrew it. All corrected, then verified by an exhaustive
      `command grep` sweep over tracked *and* gitignored docs rather than spot checks.
      No code, config or gate was affected. **This is the round cap** — the phase is not
      re-verified a fourth time, since the remaining work was enumerated line-by-line and
      mechanically checkable.
    - The round-2 finding is the one worth remembering: **`npm ls` tells you what is
      installed, not what is loaded.** Two rounds of confident, evidenced-looking claims
      rested on reading a dependency tree instead of the resolver. The fix was to read
      `@nestjs/cli`'s loader source and then delete the nested install to see if anything
      broke. Nothing did.
  - **Gates (re-run after the gap fixes):** tsc **0 on both projects**; build 0 with
    identical emit **and stable across three consecutive builds**; `check:build` green;
    lint 0; conventions 0; unit **69 suites / 770 passed / 3 skipped**; integration
    **26 suites / 158 passed**.
  - **Next:** Phase 9 — `@nestjs/cli` + `@nestjs/schematics` 11 → 12. Hard-depends on this
    phase (CLI 12 pins `typescript: ~6.0.2`). **Its value is dependency hygiene, not
    compiler unification** — it drops the redundant nested `typescript@5.9.3` and realigns
    the CLI's declared dependency with the version already in use. There is no split to
    retire; see the correction above.

- **Phase 9 — `@nestjs/cli` + `@nestjs/schematics` 11 → 12 (build tooling only).** Branch
  `chore/nestjs-cli-12` off `main` @ `ed51bbb`. Final phase of #137.
  - **Files:** `package.json`, `package-lock.json`. No source, config or CI changes.
  - **Criterion 1 met, and it retires Phase 8's open item:** `npm ls typescript` now shows
    **exactly one** node, `6.0.3`. The nested `typescript@5.9.3` under `@nestjs/cli` is
    gone, because CLI 12 pins `typescript: ~6.0.2` which our `^6.0.3` satisfies, so npm
    dedupes it.
  - **The empirical close on Phase 8's round-3 correction.** The compiler `nest build`
    *loads* was `6.0.3` before this phase and `6.0.3` after — measured both times via
    `TypeScriptBinaryLoader().load().version`. Only the *installed* tree changed. Emit is
    **byte-identical** between CLI 11 and CLI 12: `diff -rq -x '*.tsbuildinfo'` over both
    `dist/` trees reports nothing across all 400 emitted artifacts (133 `.js` + 133 `.d.ts`
    + 133 `.js.map`, plus one). **Precisely:** the unfiltered `diff` does report exactly
    one difference — `dist/tsconfig.build.tsbuildinfo`, the incremental build-state file,
    whose program graph lost one entry (`buffer@5.7.1`, removed with `ora@5`). Every
    *emitted* file is identical; the build-state file is not an artifact. Saying "no
    differences" unqualified was false, and over-confident phrasing of exactly this shape
    is what Phase 8 shipped twice. That is what "dependency hygiene, not compiler unification"
    looks like when measured rather than argued.
  - **Exercised two paths a CLI major could break that the plan did not list:**
    `nest start` and `nest start --watch` both compile, emit 133 files, reach Nest
    bootstrap and fail only on the absent DB — so the `chokidar` 4 → 5 bump inside the CLI
    did not break watch mode.
  - **Wider transitively than "build tooling only" suggests**, though none of it reaches
    runtime: `@angular-devkit/*` 19 → 22, `@inquirer/*` majors, `chokidar` 4 → 5, and CLI
    12 **drops** `webpack`, `fork-ts-checker-webpack-plugin`, `webpack-node-externals` and
    `tsconfig-paths-webpack-plugin` to optional peers (28 fewer packages overall).
    **A real capability regression, unused here:** `nest build --webpack` worked on CLI 11
    and now fails with *"The `webpack-node-externals` package is required when using the
    webpack compiler but could not be found."* Nothing in this repo invokes that path
    (`command grep` finds zero references to `webpack`/`--builder`/`swc`/`rspack`
    anywhere outside the lockfile) and it fails loudly with an actionable message, so it is
    informational rather than a defect — but it is a capability this repo no longer has.
    Note `webpack@5.107.2` is still installed top-level, as `ts-loader`'s non-optional
    peer, not from the CLI. Safe here because `nest-cli.json` declares no `webpack`/`plugins`
    — the build is the plain tsc path. Criterion 2 confirms runtime Nest was not dragged
    along: `@nestjs/{core,common}` still **11.2.3**.
  - **NEW FINDING — the first real Node floor in this repo's tree.**
    `@nestjs/schematics@12` and `@angular-devkit@22` require
    `node: ^22.22.3 || ^24.15.0 || >=26.0.0`, which excludes Node **23** and **25**
    outright. CI is safe (`node-version: '22'` → v22.23.2, above the floor, and 22.x only
    moves forward); Docker `node:26` and this workstation satisfy it. On an excluded
    version (`node:23`, v23.11.1) `npm ci` emits `EBADENGINE` **warnings and still exits
    0**. The repo declares no `engines` field, so nothing records any of this.
    **Deliberately not fixed here** — see `ASSUMPTIONS.md`; it is the standing
    Node-version question (now raised by phases 4, 6, 8 and 9), and declaring `engines`
    would hard-fail installs for anyone running `engine-strict`.
  - **Gates:** tsc 0 on both projects; `npm run build` green, emit byte-identical to
    Phase 8; `check:build` green (the plan called Phase 9 its "first real consumer" — not so: the
    script, the npm script and the CI step all shipped in Phase 8 itself, so CI already ran
    it on PR #154 and Phase 9 is the second consumer); lint 0;
    conventions 0; unit **69 suites / 770 passed / 3 skipped**; integration **26 suites /
    158 passed**; `npm ci` from clean 0; docker green with 133 `.js`, `dist/main.js`, no
    `dist/src/`.

- **§4 Finalization (issue #137, whole-feature pass).** Branch `chore/nestjs-cli-12`,
  on top of Phase 9.
  - **Phase 9 verify gate:** Opus, 1 round = `GAPS`. The code was clean — all 7 criteria
    re-verified independently, and the three riskiest claims survived direct attack,
    including the `node:22` install I had NOT run (the verifier did: exit 0, zero
    EBADENGINE on v22.23.2, the exact version `setup-node: '22'` resolves to). The gaps
    were all close-out:
    1. **BLOCKING — `Closes #137` would have closed an issue with unaddressed scope.**
       #137's item 1 is runtime NestJS 11→12, hard-blocked on `@nestjs/throttler`
       (latest 6.5.0 peers `@nestjs/common ^7||…||^11`, no v7 exists). Downgraded to
       `Refs #137`, and the follow-ups filed as **#155** (throttler blocker), **#156**
       (TS 6 → 7 runway — `node10` and `baseUrl` are REMOVED in 7.0, measured as
       `TS5108`), **#157** (evaluate adopting `nestjs-pino`). The fourth follow-up the
       plan called for — CI-Node-22-vs-Docker-26 — was **resolved in this pass instead of
       filed**, see below; filing an issue for something fixed in the same commit is noise.
    2. `docs/TROUBLESHOOTING.md`'s "Two TypeScript versions" section went counterfactual
       the moment Phase 9 deduped them to one. Reframed around the loader-resolution
       point that actually matters, which is the part worth keeping.
    3. **"`diff -rq` reports no differences" was false.** It reports exactly one:
       `dist/tsconfig.build.tsbuildinfo`. Every *emitted* artifact is identical; the
       build-state file is not one. Corrected — this is the third time in this series
       that over-confident phrasing outran the measurement.
    4. "check:build's first real consumer" was wrong — Phase 8 shipped the script AND the
       CI step, so CI ran it on PR #154. Phase 9 is the second consumer.
    5. CLI 12 also drops `webpack-node-externals` + `tsconfig-paths-webpack-plugin`, and
       `nest build --webpack` now fails. Unused here, fails loudly, recorded.
  - **NEW seam test: `test/integration/quota-store-lifecycle.integration.spec.ts`.** The
    §4 question is what the phases collectively introduced that no single phase's tests
    cover. Answer: Phase 7's blocking defect had only *unit* coverage of
    `RedisQuotaStore.close()` against a hand-written fake. Nothing proved the two things
    that actually failed — that the factory picks the in-memory store when Redis is
    configured but no tenants are, and that `QuotaModule.onModuleDestroy` closes a REAL
    client on app shutdown. Both are seams between a module, a factory, a lifecycle hook
    and a live socket, which a faked unit test cannot reach. 4 tests, live Redis, same
    never-skip-in-CI policy as `redis-live`. **Proven to have teeth:** reintroducing the
    exact Phase 7 defect (`if (config.redisUrl)` without the tenant check) fails it at the
    designed assertion. Restored and verified byte-identical to HEAD afterwards.
  - **Node-version question SETTLED by the repo owner: raise CI to Node 26.** All three
    pins (`ci.yml` × 2, `release.yml`) 22 → 26, matching the Dockerfile's
    `node:26-bookworm-slim`, with the rationale recorded inline so it is not silently
    reverted. CI now validates the Node major that actually ships. This had been deferred
    in phases 4, 6, 8 and 9. Both related `ASSUMPTIONS.md` entries move to **RESOLVED**;
    `engines` stays undeclared, now harmlessly, since no environment this project controls
    is outside the transitive floor.
  - **Tracked-file sweep found a real gap:** six merged phases (1, 2, 3, 5, 6, 7) still
    read `Status: TODO` in the plan despite being merged weeks earlier. Marked DONE with
    their merge SHAs. Also caught two more survivals of the withdrawn compiler-split claim
    in this file's own plan-re-verification notes — phrasing my earlier sweep missed
    because I grepped for my wording, not the wording that round used.
  - **Process error worth recording:** I edited this repo while the Phase 9 verifier was
    running in it, which dirtied its working tree and made it report an unexplained
    concurrent writer. Harmless here, but a verifier's tree should be left alone.

- **2026-09-11 — §4 finalization, ROUND 2 (cumulative-diff verify: `GAPS` → closed): DONE.**
  Fresh Opus verifier over the whole `e07fe6e~1..HEAD` range returned **`GAPS` — 4 items**,
  all closed here. Verifier tier: Opus (the feature as a whole is reversible — no one-way
  door — so Fable was not pulled in).
  - **Gap 1 — a committed git conflict marker.** `PROGRESS.md:700` carried a bare diff3
    `||||||| parent of b214486` line with no matching `<<<<<<<`/`=======`/`>>>>>>>`. It was
    introduced by Phase 2 (`f4cdae4`, PR #143), **merged to `main`**, and survived seven
    later phases plus a §4 pass whose own notes claimed a tracked-file sweep. Removed;
    verified no content was duplicated around it (single Phase 2 entry) and that it was the
    only such marker in the repo.
  - **Gap 2 — `docs/TROUBLESHOOTING.md` falsified by our own change.** It still read "CI runs
    Node 22 (currently v22.23.2)" after the same finalization commit moved all three pins to
    `'26'`. Fixed, and `ASSUMPTIONS.md`'s "Measured, not assumed" block — which a RESOLVED
    entry points readers at — now dates its measurements as pre-§4 rather than current.
    Same failure class that seeded #137's false premises: a doc describing an architecture
    the repo no longer has.
  - **Gap 3 — the §4 seam spec was itself defective** (found independently while the verifier
    ran; it confirmed the same). Two distinct bugs:
    1. `:46` defaulted `REDIS_URL` to a hardcoded URL outside CI, so `:103`'s
       `REDIS_URL ? describe : describe.skip` was **always truthy** — the documented
       "local, no Redis → skip" branch and its instruction `console.warn` were **unreachable
       dead code**. The docblock claimed to mirror `redis-live.integration.spec.ts`'s policy;
       the reachability probe that policy depends on was never implemented.
    2. Every test called `await close()` as its **last statement**, so a failed assertion
       skipped cleanup and leaked a reconnecting ioredis client.
    Combined effect, **measured**: against a closed port the suite ran `1 failed / 3 passed`
    and then **never exited** (observed >600s; two such processes were still alive hours
    later and had to be killed). No workflow declared `timeout-minutes`, so in CI that burns
    to GitHub's **6-hour** default. The spec written to prevent a hang-after-green reproduced
    exactly that in its own failure path.
    Fixed with a real `beforeAll` probe (`lazyConnect`, `maxRetriesPerRequest: 1`, and the
    load-bearing `retryStrategy: () => null`), cleanup moved into `withApp`'s `finally` and
    time-bounded with a `disconnect()` fallback, and `clientOf` made non-vacuous — a rename
    of the private `redis` field now throws instead of turning `toBeUndefined()` into a
    tautology. **Re-measured:** unreachable Redis → skips and **exits 0 in 7s**; defect
    reintroduced → `1 failed / 3 passed`, **jest exit code 1**, exits in 6s.
    Defence in depth: every job in `ci.yml`/`release.yml` now declares `timeout-minutes`.
    Job `name:` lines verified **byte-identical to `origin/main`** so branch protection's
    required contexts still match.
  - **Gap 4 — two dead devDependencies.** `ts-loader` and `tsconfig-paths` had zero
    references outside `package.json`. `tsconfig-paths` became provably inert once Phase 8
    deleted `baseUrl` (the repo declares no `paths`); `ts-loader` served only
    `nest build --webpack`, which `nest-cli.json` never enables. Removed — **648 lines of
    lockfile**, and `webpack@5.107.2` went with them (CLI 12 declares webpack an *optional*
    peer, so `ts-loader` was the only thing pulling it in). Both survived Phase 1's and
    Phase 4's "delete, don't bump" sweeps.
  - **Also fixed (pre-existing, not a verifier gap):** all nine `docs/*.md` ended with a
    stray literal `</content>`, and `docs/README.md` also had `</invoke>` — leaked tool-call
    fragments from `e3d079f` (#62). Harmless at EOF, but the §4 pass appended ~80 lines after
    `TROUBLESHOOTING.md`'s, leaving it mid-document. All ten removed.
  - **Tooling note:** `npx prettier --write` was reformatting specs to double quotes — this
    repo has **no prettier config at all**, so prettier applies its own defaults against a
    single-quote codebase. Reverted and hand-edited in-style. Do not run bare `prettier`
    here.
  - **Gates, all from a clean tree:** tsc 0 (both projects) · lint 0 · conventions 0 ·
    `check:build` passed (133 `.js`, both builds agree) · unit **69 suites / 770 passed /
    3 skipped** · integration **27 suites / 162 passed**, exit 0.
  - **Next:** push, PR (`Refs #137`, not `Closes` — #155 scope is deliberately undelivered),
    CI on Node 26 (first run), merge. Then #158 (SIGTERM) as its own PR.

## Plan: rfc-0014-0015-upgrade

Plan: `plans/rfc-0014-0015-upgrade.md` (15 phases). Cross-repo companion:
`plans/cross-repo/acdp-rs-bump-dispatch-fix.md`. Scope: bump the `acdp` SDK `^0.8.5` →
`^0.14.1` safely, adopt RFC-ACDP-0014 (producer key revocation) end to end, and fix the
nine + two defects a fresh correctness audit found in the already-merged RFC-ACDP-0015
witness/cosign code.

**Repo map** (for `/implement` to reuse, not re-scan):

*SDK surface & the bump*
- `src/audit/receipt-verify.ts:19-32` — `interface ReceiptCapableVerifier` (hand-written,
  **five**-arg `verifyReceipt`) then `AcdpVerifier as unknown as Partial<…>` at `:32`. The
  cast that hides the one breaking change in 0.8.5→0.14.1 from `tsc`. Call site `:74-80`.
- `src/audit/cosign.ts:165-179` (`CosignCapableVerifier`), `:256`, `:466`, `:586-595`
  (`QuorumCapableVerifier`), `:618` — the same `as unknown as` pattern; `:156` is a *probe*
  (`Record<string, unknown>`), not a call.
- `src/audit/log-verify.ts:53-63` — third instance of the pattern.
- **Verified SDK delta 0.8.5 → 0.14.1 = exactly two public changes.** (1) NEW
  `verifyCtxIdBinding(bodyJson, expectedCtxId): boolean`. (2) BREAKING: `verifyReceipt`
  gains `bodyJson` as positional param **#2**. Everything else — the entire witness/cosign/
  quorum surface, the log surface, `parseKeyRevocation`, `classifyUnderRevocation` — is
  byte-identical between the tags. Three *behavioural* tightenings inside `verify_receipt`
  (`bindings/acdp-node/src/verifier.rs`): `CtxId::parse` replaces the unvalidated newtype;
  strict `serde_json::from_str::<Body>`; new `receipt.cross_check_body(&body)` (§8 step 3).
- `package.json:24` — `"@agentcontextdistributionprotocol/acdp": "^0.8.5"`. The old `npm:`
  alias key is **gone** (removed by `a5957bd`); any reference to `package.json:37` holding it
  is stale.
- `.github/dependabot.yml:31-38` — group `acdp-sdk` with `patterns: [acdp]`, which no longer
  matches the manifest key, plus a comment describing the removed alias.
- `.github/workflows/bump-acdp.yml` (26 lines) — correct as-is; listens on
  `repository_dispatch: types: [acdp-released]`. The break is upstream (see cross-repo plan).
- `scripts/ci-conventions.sh` — five `check()` calls today; Phase 1 adds a sixth.

*Receipt audit (RFC-ACDP-0010) — the RFC-0014 §7 integration point*
- `src/audit/receipt-audit.service.ts` (521 lines) — `:165` advisory lock; `:253-257`
  `key_fingerprint_mismatch`; `:263` naive `did:web:${authority}` (**B10**); `:331-351` body
  fetch; `:356` `const bodyJson = JSON.stringify(body)` (already computed — thread it);
  `:375` `producerFp` (the §7 `signerFingerprint`); `:401` second naive DID (**B10**);
  `:423-429` the five-arg `verifyReceipt` call; `:484-491` non-ed25519 producers get the
  receipt's *claimed* fingerprint passed through.
- Statuses: `verified` | `verified_historical` | `structural` | `discrepancy` | `no_receipt`
  | `error`.
- `src/storage/receipt-audit.repository.ts` — `record` `:44-51` (`onConflictDoNothing` on
  PK `event_id` ⇒ verdicts seal once); `findUnauditedPublishes` `:66-81` (`isNull` anti-join
  + lookback window ⇒ **no retroactive re-audit**, the Phase 15 gap); `summarizeByRun`
  `:83-114` (`RunTrustSummary`, `:14-33`); `deleteBefore` `:116-123` (present, **not** wired
  into `DataRetentionService`).
- `src/audit/registry-profile.service.ts:28-32` — `ProfileCacheEntry` caches only
  `{profiles, cachedAt}`; needs widening to carry `registry_did` + `acdp_version` for the
  RFC-0014 §6 binding check. 10-minute TTL, keyed `(tenant, authority)`.

*Witness / cosigning (RFC-ACDP-0015) — the audit findings*
- `src/audit/checkpoint-witness.service.ts` (785 lines) — `:8-10` **FALSE** header claim that
  cosigning is not implemented; `:153-158` boot log that contradicts it; `:174` advisory
  lock; `:182-197` per-enrollment catch; `:239-249` §6.1 aggregated `witness_signatures`
  consumption (no §6.2 direct path — see Open Question 7); `:266` naive `did:web:${authority}`
  (**B10**); `:384-388` the comment justifying **B1** ("we retain the first per tuple rather
  than re-mint a liveness copy"); `:510-564` `cosignSafe`; `:520` `witnessedAt`; `:645`/`:658`
  the MUST-NOT-cosign guards; `:666-672` `updateQuorum(...)` with **no `tenantId`** (**B7**);
  `:687-688` the "counts EXTERNAL attestations" claim (true only by operator discipline,
  **B8**); `:712` `resolveKey(...)` — **B2** (throws for `did:key`) and **B3** (strict
  `assertionMethod`); `:714-718` the debug-only "unresolved" path; `:730-733` the failure log
  that receives `"[object Object]"` (**B4**).
- `src/audit/cosign.ts` (770 lines) — `:65` `LOG_ID_RE` allows `_` (schema does not, **B9b**);
  `:67` `WITNESS_DID_RE` (accepts `did:key`); `:489-493` reads `parsed.error`, drops `.code`
  (**B5**); `:508-514` the §8 step-3 witness binding; `:635` sends only `{min_witnesses}`
  (**B6**); `:641-660` reads 4 of 6 report fields, dropping `fresh_witnessed_count` /
  `meets_fresh_quorum` (**B6**); `:659` `.map((f) => String(f))` (**B4**); `:705`
  `hostEvaluateQuorum` re-dispatches to `verifyCosignature` → native, so host arithmetic is
  untested in a real install; `:754-770` duplicate base58btc **encoder**.
- `src/witness/witness-signing.service.ts` (285 lines) — `:47` `WITNESS_DID_RE`; `:141-142`
  `did:key` exempted from host binding; `:216-218` `ownCosignatureVerifies` — **dead code,
  zero call sites, verifies nothing** (**B9a**); `:234-257` second duplicate base58btc
  encoder; `:264-274` `didWebAuthority()` — the **correct** `%3A` handling precedent.
- `src/witness/witness.controller.ts` (126 lines) — `/log/witness` `@Public()`, witness_id
  scoped, `limit: 50`; `:34` third `LOG_ID_RE`; `:44-101` the two `/.well-known/` documents;
  `:60-66` the existing 400-on-malformed-query precedent.
- `src/storage/log-cosignature.repository.ts` (81 lines) — `record` `:26-33`
  `onConflictDoNothing` (**B1**); `list` `:52-57` `ORDER BY witnessed_at DESC, tree_size DESC
  LIMIT 50` (**B11** — re-mints would crowd out older heads); `list`/`coveredLogs` untenanted
  and **correctly so** (single-identity public feed).
- `src/storage/log-witness.repository.ts` (298 lines) — `:36-43` append-once insert;
  `:51-68` `updateQuorum` **no `tenantId`** (**B7**); `:71-87` `latestForAuthority` (tenant
  *is* filtered — hence the silent evidence loss); `:94-109` `findByLogIdAndSize` **no
  `tenantId`** (**B7**, called from `src/audit/log-inclusion-audit.service.ts:296`);
  `:279-297` `markFailure` read-modify-write (safe: single writer under advisory lock).
- `src/audit/log-inclusion-audit.service.ts:231` — fourth naive `did:web:${authority}`
  (**B10**); `:296` the untenanted cross-binding read.
- `src/auth/did-web/did-web-resolver.service.ts` (339 lines) — `resolveKey` `:159-195`
  (unconditional `AcdpDid.webToUrl` ⇒ throws `not_did_web` for `did:key`; strict
  `keyForAlgorithm`); `resolveReceiptKey` `:212-245` (`receiptKeyForAlgorithm`, returns
  `{keyId, algorithm, publicKeyB64, historical}`) — **semantically exactly what RFC-0015 §9
  witness keys need**; `:259-326` the per-DID document cache (1h).
- **Upstream cross-check:** the SDK's own `verify_witness_cosignature_value` uses
  `doc.find_by_fragment(...)` — a plain `verificationMethod` lookup with **no**
  `assertionMethod` gate. The over-strictness in B3 is purely host-side.
- **No `did:key` decoder exists anywhere in the SDK's public surface at 0.14.1** (full export
  list enumerated). The repo has the *encoder* twice and no decoder.
- `bindings/acdp-node/src/v040.rs:72-78` — `failure(e)` builds
  `{"valid":false,"code":…,"error":…}`; `:284-402` `evaluate_witness_quorum_report` returns
  `{witnessed_count, witnesses, meets_quorum, fresh_witnessed_count, meets_fresh_quorum,
  failures}`. Confirms **B4/B5/B6** precisely.
- `acdp-client/src/witness.rs:185-193` — `WitnessPolicy` defaults `min_witnesses=1`,
  `max_age_seconds=Some(300)`, `max_clock_skew_seconds=120`. With
  `LOG_WITNESS_INTERVAL_SECONDS` also defaulting to **300**
  (`src/config/app-config.service.ts:255`), **B1 is the default behaviour, not an edge case**.

*Config*
- `src/config/app-config.service.ts` (516 lines) — witness block `:254-297`; `validate()`
  `:355-515`; `:433-437` the `WITNESS_COSIGNING_ENABLED requires LOG_WITNESS_ENABLED`
  **precedent pattern** for a prerequisite throw; `:443-457` the quorum block with **no**
  `WITNESS_ID ∉ WITNESS_QUORUM_TRUSTED` check (**B8**).

*Errors*
- `src/errors/error-codes.ts` (19 lines) — `INVALID_LOG_PROOF` at `:9-16` with a 7-line
  RFC-citing comment block (the **style precedent**). No `INVALID_WITNESS_COSIGNATURE`
  (RFC-0015 §10, HTTP 502, MUST NOT collapse with `invalid_log_proof`), no
  `CONTEXT_ID_MISMATCH` (RFC-0006 §4.1 step 7).

*Ingest & federation*
- `src/ingest/ingest.service.ts:128-137` — the domain-pack gate (runs only when
  `packs.length > 0`); `:185-190` `ACDP_BASE_TYPES` = `data_snapshot, analysis, prediction,
  alert` — **missing `key-revocation` and `acdp:key-revocation`**. A 4xx here is a
  **permanent** delivery failure upstream: the revocation is lost silently.
- `src/contexts/contexts.controller.ts` (106 lines) — `:67-72` the proxy relays the upstream
  body **verbatim and unparsed** (the `verifyCtxIdBinding` insertion point); `:76-83` the
  `FederationFetchError → BadGatewayException` classification; `:94-105` `parseAcdpCtxId`
  accepts `/^[a-zA-Z0-9.:-]+$/` authority (uppercase + ports) and any non-empty id — far
  looser than `CtxId::parse`.
- `src/contexts/safe-federation-client.ts:59` — `get()` is the **only** method. Confirms the
  registry v0.1.4→v0.1.5 wire changes (415 gate, 422→400, publish-side revocation rejections)
  are **all POST-only ⇒ zero risk** to this repo.
- `CtxId::parse` (`acdp-primitives/src/primitives.rs:29-48`) — requires `acdp://` +
  `is_valid_dns_authority` (lowercase ASCII / digits / `-` / `.`; **rejects `:`, so ports are
  invalid**) + a lowercase v4 UUID. The registry parses path ctx_ids through it at
  `acdp-registry-core/src/handlers/context.rs:899` and `:1484`, so tightening the CP's parser
  converts an upstream 400 into a local 400 — no conformant caller sees a change.

*RFC-ACDP-0014 upstream facts (verified, not assumed)*
- `WebhookEvent::ContextPublished` (`acdp-registry-types/src/event.rs:11-53`, single
  construction site `acdp-registry-core/src/handlers/context.rs:697-732`) has **no `metadata`
  field**. Revocation discovery must be by `context_type` + a body fetch — **not** an
  ingest-time projection of `revoked_key_fingerprint` / `compromised_since`.
- The registry mints a receipt for **every** accepted publish with **no `context_type` gate**,
  so revocation contexts do carry receipts.
- The reference registry advertises `acdp_version = "0.5.0"` **unconditionally**
  (`acdp-registry-server/src/main.rs:1198-1213`, pinned by a test at `:2523`) and therefore
  **rejects new interim `acdp:key-revocation` publishes** with `schema_violation`
  (`validator.rs:225-234`). Both spellings must still be accepted (§10 retrieval, third-party
  registries, and §7's disarm clause names the interim form).
- `capabilities.registry_did` and `acdp_version` are **non-`Option` `String`s**, always
  present (`acdp-types/src/capabilities.rs:9-44`); `registry_did =
  authority_to_did_web(&cfg.registry.authority)`.
- `authority_to_did_web` (`acdp-did/src/web.rs:422-425`) = `authority.replace(':', "%3A")`.
  **This is the proof for B10.** The reverse (`:433-440`) decodes only the first
  colon-separated segment.
- `acdp-client/src/revocation.rs:139-149` `verify_revocation_body` (the pipeline to mirror);
  `:304-351` `walk_revocation_lineage` (the empty-lineage fail-closed, permanent-drop /
  transient-abort asymmetry); `:47` `MAX_LINEAGE_WALKS = 100`.
- `KeyRevocation::cross_check_registry_binding` (`acdp-types/src/revocation.rs:384-405`,
  rationale `:369-383`) exists in Rust but is **not exposed to Node** — pure string
  comparison, reimplemented host-side in Phase 11.
- `classifyUnderRevocation` returns `{"authorization":"none"}` for BOTH "inert" and
  "fail-closed"; the fail-closed shape adds `boundary` + `error`. **Disambiguate on
  `boundary`/`error`, never on `authorization`** — conflating them silently disables §7.

*Schema & migrations*
- `src/db/schema.ts` (601 lines) — `:368-401` `receiptAudits`; `:403-406` **FALSE** comment
  that cosigning is unimplemented; `:407-446` `logWitnessCheckpoints` with `uniqueHead` at
  `:437` over `(logId, treeSize, rootHash)` — **no tenant** (**B7**); `:451-483`
  `logWitnessCursors` (PK correctly `[tenantId, registryAuthority]` — the right precedent);
  `:485-489` the `logInclusionAudits` "parallel table" rationale (RFC-0012 §9.3);
  `:490-514` `logInclusionAudits`; `:516-566` `logCosignatures` with `uniqueCosig` at `:556`
  over `(witnessId, logId, treeSize, rootHash)` — **no tenant** (**B7**); `:568-601` type
  exports.
- `drizzle/0014_*.sql` — added `context_events.key_fingerprint` (the Phase 15 fan-out join
  key). `drizzle/0015:40` — `PRIMARY KEY (tenant_id, ctx_id)` composite-PK precedent.
  `drizzle/0016_log_witness.sql:11-13` the same false claim (**historical record — do not
  edit**), `:35` `UNIQUE (log_id, tree_size, root_hash)`, `:66`
  `PRIMARY KEY (tenant_id, registry_authority)`, `:70-79` the parallel-table rationale.
  `drizzle/0017_log_cosignatures.sql:45-46` the "retain the first per tuple" comment (**B1**,
  in writing), `:47` `UNIQUE (witness_id, log_id, tree_size, root_hash)`.
  `drizzle/0018_witness_quorum.sql` adds `witnessed_count` / `meets_quorum` /
  `acknowledged_at` / `acknowledged_by`. **Next migration number is `0019`.**
- Migration conventions: filename `drizzle/00NN_<slug>.sql`; header `-- <filename>` /
  `-- ACDP <ver> — <theme> (RFC-ACDP-NNNN …)` / `--` / rationale prose. Every new table gets
  `tenant_id varchar(255) NOT NULL DEFAULT 'default'`. `CREATE TABLE IF NOT EXISTS` /
  `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (the runner `src/db/migrate.ts` is forward-only,
  transactional, tracked in `_migrations`, files sorted **lexically** — a partially applied
  file must be re-runnable). Index names `<2-4 letter abbrev>_<subject>_idx`. Status columns
  are `varchar(32) NOT NULL` preceded by a `-- a | b | c` value comment — **no PG enum, no
  CHECK**. Composite PKs lead with `tenant_id`.

*Tests*
- `src/audit/checkpoint-witness.service.spec.ts:660` —
  `it('re-cosigning the same head is idempotent (repo dedups; no crash)')` asserting
  `expect(record).toHaveBeenCalledTimes(1)`. **This test asserts the B1 bug and must FLIP in
  Phase 7.**
- `src/audit/cosign.spec.ts:41-56` — the `ACDP_SPEC_DIR` graceful-skip pattern for
  conformance fixtures.
- Unit-spec convention: hand-rolled `jest.fn()` object literals built in `beforeEach`,
  `let x: any` collaborators, `new ServiceClass(...)` constructed positionally — **never**
  `Test.createTestingModule`. `jest.mock` hoisted above imports. Ed25519 keys via
  `generateKeyPairSync('ed25519')` or a PKCS#8-DER-prefix seed builder.
- Integration convention: `test/integration/<area>.integration.spec.ts` via
  `createTestApp`/`TestClient`, Postgres on **5433**, `maxWorkers: 1`, `truncateAll()`
  between cases.
- `test/integration/tenancy-isolation.integration.spec.ts` — where the B7 two-tenant proof
  goes. `test/integration/trust-hardening.integration.spec.ts` — the receipt-audit e2e.

*Docs truth state (verified — corrects the research brief)*
- **Genuinely false, fix in Phase 5:** `CLAUDE.md:305-306`;
  `src/audit/checkpoint-witness.service.ts:8-10`; `src/db/schema.ts:403-406`.
- **Already accurate, do NOT "fix":** `docs/ARCHITECTURE.md:242-249`; `docs/API.md:519-556`;
  `docs/CONFIGURATION.md:156-199`.
- **Merely confusingly worded, reword only:** `docs/ARCHITECTURE.md:250-252` — conflates
  RFC-0009 §2.12 (witness cosigning, **implemented**) with RFC-0015 §6.1 registry-side
  aggregation (**not** implemented, correctly).
- `docs/API.md:532` names `0.7.0+` as the cosignature-surface floor — still true, but below
  the new pinned floor.

**PR strategy** (decided at `/implement` start, per the plan's own `Depends on` graph —
confirmed by reading every phase's `Depends on` line: all edges point backward in numeric
order, so implementing 1→15 in sequence satisfies every dependency with no reordering):

- **PR1 — Phases 1–4** (`SDK hardening, bump to 0.14.1, ctx_id binding`). Branch
  `rfc-0014/pr1-sdk-bump`.
- **PR2 — Phases 5–9** (`RFC-ACDP-0015 witness/cosign correctness fixes`). Branch
  `rfc-0014/pr2-witness-fixes`. No dependency on PR1 (confirmed: nothing in 5–9 names Phase
  1–4 in `Depends on`) — sequenced after PR1 anyway to keep one executor thread linear rather
  than running two branches against the same working tree concurrently.
- **PR3 — Phases 10–15** (`RFC-ACDP-0014 producer key-revocation`). Branch
  `rfc-0014/pr3-key-revocation`. **Genuinely depends on PR1**: Phase 11 depends on Phase 3
  (`authorityToDidWeb`), Phase 12 and Phase 14 depend on Phase 2 (the bumped SDK surface) —
  so this branch is cut from `main` only after PR1 merges, never from PR2's branch.

Why three PRs and not one: 15 phases as a single diff is not honestly reviewable, and the
plan's own three RFC/concern groupings (SDK currency, an audit-fix set, a new feature) are
independently meaningful units a reviewer can reason about separately. Why not more (e.g. one
per phase): most individual phases are small enough that a 15-PR chain would be pure process
overhead for no independent value — the three chosen boundaries are the only ones with a real
seam (a different RFC, or a real code dependency edge).

### /implement checkpoints — `rfc-0014/pr1-sdk-bump`

- **2026-09-23 — Phase 1 (SDK surface shims typecheck against the real binding): DONE, PASS
  round 1.** Verifier tier: Opus (not a one-way door — internal type-checking pattern, fully
  reversible). No gaps raised.
  - Replaced the `Acdp* as unknown as <hand-written interface>` pattern with
    `Pick<typeof AcdpVerifier, ...>`-derived types in `src/audit/{receipt-verify,cosign,
    log-verify}.ts` — the compiler now sees the binding's real shape, so Phase 2's arity change
    becomes a `tsc` error instead of a silent runtime failure. Verified both directions: a
    patched `.d.ts` simulating Phase 2's arity change fails `tsc` on this branch and was
    reproduced as silent on pre-phase `HEAD`.
    Added CI convention check 6 (`scripts/ci-conventions.sh`) forbidding the pattern from
    reappearing, confirmed non-vacuous against the 8 real pre-phase sites. New
    `src/ci-conventions.spec.ts` (8 cases) exercises the script directly.
  - `CLAUDE.md` (gitignored, on-disk only) updated to document 6 checks.
  - Gates: `check:conventions` 6✓ · `lint` 0 · `tsc --noEmit` 0 · `check:build` both builds
    135 files · unit 71/808 (+1 suite/+8 tests vs. 70/800 baseline, zero pre-existing tests
    changed) · integration 30/173.
  - **Environment note, not a code defect**: this repo's own `docker-compose.test.yml` postgres
    fails to bind port 5433 (held by an unrelated sibling project's `aitp-control-plane-postgres-
    test` container) — `test/setup/global-setup.ts` swallows the failure and the suite runs
    against a same-named `acdp_control_plane_test` database created inside the foreign
    container. Confirmed this repo's own migrations/schema (20 tables through `0018`) are what's
    actually being exercised, no cross-project contamination — but it's a pre-existing (commit
    `cee404d` already anticipated the name collision) local-environment hazard worth fixing
    (stop the foreign container, or repoint `DATABASE_URL`) outside this plan's scope.
  - Files touched: `src/audit/receipt-verify.ts`, `src/audit/cosign.ts`,
    `src/audit/log-verify.ts`, `scripts/ci-conventions.sh`, `src/audit/receipt-verify.spec.ts`,
    `src/ci-conventions.spec.ts` (new), `CLAUDE.md` (untracked), `plans/rfc-0014-0015-upgrade.md`
    (Phase 1 → DONE).
  - **Next:** Phase 2 — bump `^0.8.5` → `^0.14.1`.

- **2026-09-23 — Phase 2 (Bump acdp SDK `^0.8.5` → `^0.14.1`): DONE, GAPS round 1 → PASS round
  2.** Verifier tier: Opus (not a one-way door within this phase's scope — no public API/schema
  change, reversible; the SDK version itself is an external-dependency bump but the plan already
  fixed the version target during drafting review, nothing left to decide here).
  - Round 1 verdict: PASS with 3 gaps (dependabot comment still said "npm: alias" contra AC 7's
    literal text; the `verified`→`error` flip for non-canonical stored `ctx_id` rows had zero
    operator-visible signal — no distinguishing log, no distinguishing metric label, note text
    never reached any API; a "63 vs 64 char DNS label" host/SDK mirror gap was accurately safe but
    inaccurately described as "unreachable in practice") + 1 doc nit (stale "0.5.0 binding predates
    log surface" line in CLAUDE.md). All 4 closed in one gap-closing pass; round 2 re-verify
    confirmed each against the actual on-disk text (not the fixer's self-report) plus a clean gate
    re-run — **PASS**.
  - Bumped `package.json`/`package-lock.json` to `0.14.1`; confirmed via lockfile inspection (not
    assumed) that all four platform `optionalDependencies` resolved — this exact class of failure
    (a bot-regenerated lockfile silently dropping `acdp-linux-x64-gnu`) broke CI/Docker once
    before (PR #125). Threaded `bodyJson` into `verifyReceipt`; added `classifyReceiptFailure`
    (a named, individually-tested predicate distinguishing `malformed_body`/`ctx_id_rejected`/
    `receipt_dishonest`) so the three new stricter failure modes route to `unverified:` notes
    (not dishonesty flags) except the true `cross_check_body` mismatches, which correctly do flag.
  - A real bug surfaced and got fixed along the way, not anticipated by the plan: napi-thrown
    errors fail `instanceof Error` under ts-jest's VM realm (true there, false in production),
    which silently broke prefix-based classification in tests only — fixed via a `.message`
    duck-typed `rawMsg()` helper instead of an `instanceof` check, verified empirically in both
    realms by both the executor and the round-1 verifier independently.
  - Gates: `check:conventions` 6✓ · `lint` 0 · `tsc --noEmit` (both tsconfigs) 0 · `check:build`
    both builds 135 files · unit 71/831 (828 passed + 3 skipped; baseline going in was 71/808 from
    Phase 1) · integration 30/176 (then re-run 8/8 on the Gap 2 sanity check alone).
  - **Operational note for deploy** (not a code change, recorded here and in
    `docs/TROUBLESHOOTING.md`'s new Receipt audit section): any `context_events` row whose stored
    `ctx_id` isn't canonical per `CtxId::parse` moves from `verified` to `error` once this ships.
    Correct, but expected — the pre-deploy SQL check to find affected rows ahead of time is in
    `docs/TROUBLESHOOTING.md` and in the plan's own Phase 2 Edge-cases section, verbatim in both.
  - Files touched: `package.json`, `package-lock.json`, `src/audit/receipt-verify.ts`,
    `src/audit/receipt-audit.service.ts`, `src/audit/receipt-verify.spec.ts`,
    `src/audit/receipt-audit.service.spec.ts`, `src/audit/receipt-audit.service.crypto.spec.ts`,
    `test/integration/trust-hardening.integration.spec.ts`, `.github/dependabot.yml`,
    `docs/API.md`, `docs/TROUBLESHOOTING.md` (new section), `CLAUDE.md` (untracked),
    `plans/rfc-0014-0015-upgrade.md` (Phase 2 → DONE).
  - **Next:** Phase 3 — canonical `authority → did:web` + closed-proof re-serialization (B10, B12).

- **2026-09-23 — Phase 3 (Stop accusing conformant registries: canonical `authority → did:web`,
  closed-proof re-serialization — B10, B12): DONE, PASS round 1.** Verifier tier: Opus, briefed
  to scrutinize hardest and REPRODUCE (not just read) the two crux claims — no gaps raised.
  - **B10**: new `src/common/did-authority.ts` (`authorityToDidWeb`/`didWebToAuthority`/
    `nonCanonicalAuthorityReason`), transcribed from and verifier-confirmed against `acdp-rs`'s
    actual `web.rs` encoding (percent-encodes a port: `localhost:8443` → `did:web:
    localhost%3A8443`). Applied at all 4 DID-comparison sites (`receipt-audit.service.ts` ×2,
    `checkpoint-witness.service.ts`, `log-inclusion-audit.service.ts`) — a non-canonical stored
    authority is now an `unverified:`/`error` outcome, never a dishonesty flag. One naive-template
    site left intentionally (`checkpoint-witness.service.ts:646`, an SSE `agentId` field) —
    verifier traced it and confirmed it's display/telemetry-only, never a comparison input.
  - **B12**: the reference registry attaches an RFC-ACDP-0015 §6.1 `witness_signatures` sibling
    on `GET /log/proof` once a log has ≥1 witness cosignature (both inclusion and consistency
    modes) — and the SDK's `LogInclusion`/`LogConsistencyProof` are `deny_unknown_fields`, so
    *every* proof from a witnessed, fully-conformant registry was silently failing native
    verification and reading as `consistency_failed`/`invalid_proof`. Fixed by replacing a
    deny-list strip (`stripEmbeddedCheckpoint`, only handled `log_checkpoint`) with an allow-list
    projection (`toClosedInclusionProof`/`toClosedConsistencyProof` in `src/audit/log-verify.ts`)
    onto exactly the closed member set the SDK's types declare.
  - **Verifier reproduced both crux claims directly, not on the executor's word**: (a) reverted
    the B12 fix to the old deny-list and confirmed the target integration test flips from
    `witnessed` to a false `alert`/`consistency_failed` — then restored the fix and reconfirmed
    green, 3x repeated; (b) confirmed via a live probe against the installed 0.14.1 binding that
    the `deny_unknown_fields` failure is real (`"unknown field \`witness_signatures\`"`), and
    confirmed real tampering (a flipped inclusion-path hash; a consistency proof folding to a root
    that isn't an extension of the retained one) still alerts correctly even with the sibling
    attached — including a mutation test proving the allow-list can't be used to launder a
    missing required field (dropping `consistency_path` from the closed type fails loudly).
  - **Residual risk recorded, not fixed** (verifier-flagged, beyond this phase's acceptance
    criteria): the closed proof shapes are hand-maintained with no compile-time coupling to the
    SDK's Rust types (the Node binding exports no proof types to pin against) — a future SDK
    proof-shape change could silently reintroduce this defect class. Cheap future fix identified:
    classify a `/does not parse/` reason as an environmental error rather than a dishonesty
    verdict in `nativeVerdict`. Not part of this phase's plan-defined scope; worth its own small
    follow-up phase/ticket, not blocking PR1.
  - Gates: `check:conventions` 6✓ · `lint` 0 · `tsc --noEmit` (both tsconfigs) 0 · `check:build`
    both builds 136 files · unit 72/867 (864 passed + 3 skipped) · integration 30/178.
  - Files touched: `src/common/did-authority.ts` (new) + spec, `src/audit/log-verify.ts` +
    `log-verify.spec.ts`, `src/audit/receipt-audit.service.ts` + `.spec.ts` +
    `.crypto.spec.ts`, `src/audit/checkpoint-witness.service.ts` + `.spec.ts`,
    `src/audit/log-inclusion-audit.service.ts` + `.spec.ts`, `src/witness/witness-signing.service.ts`,
    `test/integration/log-witness.integration.spec.ts`, `plans/rfc-0014-0015-upgrade.md`
    (Phase 3 → DONE).
  - **Next:** Phase 4 — `verifyCtxIdBinding` on the federation proxy.

- **2026-09-23 — Phase 4 (Bind the served `ctx_id` on the federation proxy —
  `verifyCtxIdBinding`): DONE, PASS round 1.** Verifier tier: Opus, briefed to treat this as the
  plan's only hot-path (live request-serving, not background-sweep) change and scrutinize
  availability risk specifically — no gaps raised.
  - `GET /contexts/*ctxId` now refuses to relay a 2xx whose body's `ctx_id` doesn't match the one
    requested — closes a substitution gap `content_hash` and the producer signature structurally
    can't cover (`ctx_id` is registry-assigned, outside both). Two new error codes
    (`CONTEXT_ID_MISMATCH` / `CONTEXT_BINDING_UNVERIFIABLE`, both 502, body withheld in both) via a
    new `verifyCtxIdBinding` wrapper in `src/audit/receipt-verify.ts`.
  - Also tightened `parseAcdpCtxId` to the SDK's actual `CtxId::parse` grammar (plan-authorized,
    not a side effect) — verifier confirmed via a reconstructed old-parser diff that 6 new unit
    cases (uppercase authority, port-bearing authority, opaque non-uuid id, non-v4/bad-variant
    UUID nibbles) are genuine live-route behavior changes: accepted before this phase, 400 now,
    with zero outbound request in either case.
  - **Availability-risk scrutiny (the main verification focus)**: verified real, not theoretical —
    empirically drove the real controller through 6 injected native-binding failure modes (method
    absent, OOM-adjacent `RangeError`, unknown napi failure, non-`Error` throws, `null` throws) and
    confirmed every one degrades to a clean, classified 502 `CONTEXT_BINDING_UNVERIFIABLE`, never
    an uncaught exception or a wrong classification — and confirmed non-2xx relaying keeps working
    even when the binding is unreachable, so an outage is scoped to 2xx retrievals on this one
    route, not the whole proxy. Confirmed this "fail closed, don't degrade-and-relay" posture is
    explicit plan intent (unlike the audit-sweep `sdkHasLogSurface`-style wrappers, which *do*
    degrade — deliberately different because a sweep can re-check next cycle, a request can't).
  - Leak check: confirmed by reading the actual exception construction (not the test titles) that
    neither error message echoes the upstream body, the registry's raw error text, or the SDK's
    full failure reason — both are fixed templates naming only the authority and the *requested*
    ctx_id.
  - Mutation checks, all reproduced by the verifier and reverted byte-identical: removing the
    binding-check call fails 13 tests; neutering the 2xx gate fails 3; forcing the classifier to
    always return `mismatch` fails 9.
  - **Plan-text correction** (not a code defect): the plan's Edge-cases prose said an oversize body
    "fails to parse and falls into the fail-closed path" — actually throws
    `FederationFetchError('BODY_TOO_LARGE')` inside `SafeFederationClient`, caught as a
    `BadGatewayException` before the binding check runs. Same 502 outcome, different code path;
    corrected inline in the plan.
  - Gates: `check:conventions` 6✓ · `lint` 0 · `tsc --noEmit` (both tsconfigs) 0 · `check:build`
    both builds 136 files · unit 72/898 (895 passed + 3 pre-existing skipped) · integration
    30/186.
  - Files touched: `src/errors/error-codes.ts`, `src/audit/receipt-verify.ts` + `.spec.ts`,
    `src/contexts/contexts.controller.ts` + `.spec.ts`,
    `test/integration/federation-proxy.integration.spec.ts`, `docs/API.md`, `CLAUDE.md`
    (untracked), `plans/rfc-0014-0015-upgrade.md` (Phase 4 → DONE).
  - **PR1 (Phases 1-4) is now phase-complete.** Proceeding to the finalization pass before
    handing off to `/ship`. Release-notes callout still owed for two live behavior changes on
    `/contexts/*ctxId` (tightened ctx_id grammar; a mis-resolved native binding now 502s 2xx
    retrievals on this route) — fold into the PR description.

### /ship — rfc-0014/pr1-sdk-bump

- **Ship-gate (whole-diff Opus verifier, 4-phase diff a82c1d9..44d8584 vs main):** PASS.
  Confirmed local gates fresh-green (conventions 6✓, lint 0, both tsconfigs 0, check:build
  136 files both builds, unit 72/895+3skip, integration 30/186), cross-phase consistency
  (Phase 4 reuses Phase 1's `Pick` pattern + Phase 2's `isCanonicalCtxId`; `did-authority.ts`
  not duplicated), no blocking `ASSUMPTIONS.md`/`DECISIONS.md` entries, tracked-file
  consistency (all 4 plan phases DONE, `PROGRESS.md` matches `git diff --stat` per commit).
  Corrected one detail: branch has 5 commits (repo-map prep commit `8a885f0` precedes the 4
  phase commits), otherwise as recorded above.
  One item flagged "fix before merge": `docs/ARCHITECTURE.md:249` still carried the stale
  "until the binding exposes the 0.3.0 log surface" claim that CLAUDE.md's twin already had
  corrected during Phase 2's gap-closing round — no per-phase gate had checked
  ARCHITECTURE.md, only the whole-diff view surfaced it. Fixed directly (commit `107a917`),
  mirroring CLAUDE.md:363-371's corrected language (0.6.0 arrival, `^0.14.1` floor,
  `sdkHasLogSurface()` delegates in practice, `log-verify.ts` kept as fallback +
  parity-tested). Two other minor items noted by the verifier (illustrative non-canonical
  ctx_id in the API.md lineage example; `INVALID_LOG_PROOF` absent from the API.md HTTP
  error-code list) were reviewed and left as-is: the lineage example was always illustrative
  placeholder data, not a regression from Phase 4's tightened grammar, and
  `INVALID_LOG_PROOF` is a webhook/audit verdict code, never thrown as an HTTP `errorCode`,
  so adding it to that list would misrepresent it.
- pushed rfc-0014/pr1-sdk-bump 107a91790d19498c346801a54e32f661e48e7f80
- PR #165 opened: https://github.com/agentcontextdistributionprotocol/acdp-control-plane/pull/165
- CI green (docker build, jest integration/Postgres, lint+tsc+jest unit — all pass)
- merged #165 (squash) at e0c7e10 on main; branch rfc-0014/pr1-sdk-bump deleted (local + remote)
- Post-merge deploy: NOT triggered by this merge. `release.yml` deploys to Railway only on a
  pushed `v*` tag (last tag `v0.1.4`); merging to main does not auto-deploy. No tag was cut
  this session — deploy remains a deliberate separate step, not owed by this PR.
- **PR1 shipped end-to-end.** Next: PR2 (Phases 5-9, RFC-ACDP-0015 witness/cosign correctness
  fixes B1-B9) on a fresh branch `rfc-0014/pr2-witness-fixes` cut from updated main.

### /implement checkpoints — rfc-0014/pr2-witness-fixes

**Phase 5 — Correct the three false claims that cosigning is unimplemented.** PASS r1
(fresh Opus verifier, not critical — doc/comment-only, zero behavior change, no one-way
door). Fixed: `CLAUDE.md:332-333` (false "deliberately NOT implemented" claim, replaced +
new paragraph documenting `WitnessSigningService`/`WITNESS_COSIGNING_ENABLED`/
`WITNESS_QUORUM_ENABLED`/`/log/witness`/`log_cosignatures`, plus the "Key env vars" table
entry), `src/audit/checkpoint-witness.service.ts:8-10` (header now describes `cosignSafe`
+ `evaluateQuorum`), `src/db/schema.ts:405-406` (comment no longer claims cosigning
unimplemented), `docs/ARCHITECTURE.md:255-256` (precisely distinguishes implemented
witness-side cosign/quorum from correctly-still-unimplemented registry-side §6.1
aggregation). Verifier confirmed: grep acceptance criterion clean (one surviving hit is an
accurate, scoped test-fixture comment about the default-disabled test setup — exactly the
carve-out the plan's own criterion text allows), all 5 documented capabilities verified
true against code (not just prose), diff touches only comment/doc lines (`git diff -U0`
checked), unit suite pass count identical to pre-phase baseline (72/895/3/898),
`drizzle/0016_log_witness.sql` untouched. Files touched: `CLAUDE.md`,
`src/audit/checkpoint-witness.service.ts`, `src/db/schema.ts`, `docs/ARCHITECTURE.md`,
`plans/rfc-0014-0015-upgrade.md` (Phase 5 → DONE). No `ASSUMPTIONS.md` entries.
Next: Phase 6 (tenant isolation on witness evidence + self-cosignature guard, B7/B8).

**Phase 6 — Tenant isolation on witness evidence, and the self-cosignature guard (B7, B8).**
PASS r1 (fresh Opus verifier, routed to extra empirical rigor rather than a Fable pass —
this phase carries an irreversible DB schema migration with no down-migration path, which
the Autonomy ladder flags critical; the plan's own planning-time analysis already did the
one-way-door thinking in full detail — exact old constraint names, the "wrong DROP name is
a silent no-op and the ADD then succeeds anyway" failure mode, why a data backfill is
unnecessary — so rather than a redundant Fable re-derivation, both the executor and the
verifier independently reproduced the migration against the real test Postgres and queried
`pg_constraint` directly, which is the strongest possible verification for a claim that's
fundamentally about what a real database does).
- B7 fix: new `drizzle/0019_witness_tenant_scope.sql` drops the old
  `log_witness_checkpoints_log_id_tree_size_root_hash_key` /
  `log_cosignatures_witness_id_log_id_tree_size_root_hash_key` constraints (their exact
  Postgres-generated names, confirmed via the CREATE TABLE source) and adds
  tenant-id-leading replacements. `LogWitnessRepository.updateQuorum` and
  `.findByLogIdAndSize` now take `tenantId` as a required first parameter (2 call sites
  updated: `checkpoint-witness.service.ts`, `log-inclusion-audit.service.ts`); a 3rd call
  site in `test/integration/log-witness.integration.spec.ts` needed the same fix (caught by
  `tsc`, not by the phase's own new tests — a useful reminder that the compiler is part of
  the safety net here).
- B8 fix: `AppConfigService.validate()` now throws at boot if `WITNESS_ID` appears in
  `WITNESS_QUORUM_TRUSTED`, guarded so an empty `WITNESS_ID` (consume-only deployment)
  never trips it.
- Empirical DB verification (both executor and verifier, independently): applied migration
  0019 to the real test Postgres, confirmed via direct `pg_constraint` query that exactly
  one unique constraint remains per table with the correct new name and column list, then
  manually re-ran the raw SQL file a second time and reconfirmed no duplicate constraint
  was created — idempotency proven, not assumed.
- Gates: `check:conventions` 6✓ · `lint` 0 · `tsc --noEmit` (both tsconfigs) 0 ·
  `check:build` both builds 136 files · unit 72 suites/900 passed/3 skipped/903 total
  (+5 new) · integration 30 suites/189 passed (+3 new).
- Files touched: `drizzle/0019_witness_tenant_scope.sql` (new), `src/db/schema.ts`,
  `src/storage/log-witness.repository.ts`, `src/storage/log-cosignature.repository.ts`,
  `src/audit/checkpoint-witness.service.ts`, `src/audit/log-inclusion-audit.service.ts`,
  `src/config/app-config.service.ts`, `docs/CONFIGURATION.md`, `docs/TENANCY.md`,
  `src/config/app-config.service.spec.ts`, `src/audit/checkpoint-witness.service.spec.ts`,
  `src/audit/log-inclusion-audit.service.spec.ts`,
  `test/integration/tenancy-isolation.integration.spec.ts`,
  `test/integration/log-witness.integration.spec.ts`,
  `plans/rfc-0014-0015-upgrade.md` (Phase 6 → DONE). No `ASSUMPTIONS.md` entries.
Next: Phase 7 (cosignature freshness — re-mint on every observation, §8.1 split; B1, B6, B11).
