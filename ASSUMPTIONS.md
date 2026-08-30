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
