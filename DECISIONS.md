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
