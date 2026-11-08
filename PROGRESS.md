# Progress — cp-wave-2026-11-07b

Plan: `plans/cp-wave-2026-11-07b.md` (plans/ is gitignored; this file is tracked)

## Phase log
PR strategy: ONE PR (P1 + P2 commits; shared files), then P3 ops (Doppler + v0.1.7).
- Plan review: round 1 REVISE → applied (see plan § Plan review).
- P1 DONE — config parser + branded TrustedFetchBase, SafeFederationClient.getTrusted, controller wiring, unit + integration (real loopback egress), docs CONFIGURATION/API/TROUBLESHOOTING/CLAUDE.md/.env.example/doppler-keys, DEFERRED line.

## Findings (ops, no values)
- Task 3: the old CP callback (removed in #325) caused the playground 401s from 10.139.199.179. The last one was at 2026-11-08T02:59:19Z, and there have been none since. CP 0.1.6 has been live since 03:14Z.
- Read key on 0.1.6: /metrics 403, /auth/revocations 403, /routing/stats 403; /registries/enrollments 200 (bug); GET /webhooks 200, POST /webhooks reaches validation (bug).
- Railway acdp-runner/production holds CP, registry-a, registry-b and the playground (same private network).

## Repo map
- `src/contexts/contexts.controller.ts:63-109` — registry lookup, upstream URL, fetch, 502 mapping; binding check `:134+`.
- `src/contexts/safe-federation-client.ts:63-170` — hop loop (checkUrl, checkResolvedHost, redirect, 429, readCapped).
- `src/config/app-config.service.ts` — readStringList `:65`, parseTrustProxy `:104` (construction-time pattern), authAdminApiKeys `:243`, validate() dev early-return (~:766).
- `src/auth/auth.guard.ts:173-190` issuer read_only gate; `:195-217` api-key path; `isSafeForReadOnlyIssuer` `:281`.
- `src/auth/admin.ts` assertAdmin; `src/registries/registries.controller.ts:45-52` enrollments.
- `src/errors/error-codes.ts:140` ISSUER_READ_ONLY (insert the new code nearby); `error-codes.spec.ts` SHIPPED set + API.md table.
- `test/helpers/test-app.ts:179-187` admin key, `adminClient` `:280`.
- No integration spec calls GET /registries/enrollments (the earlier note was wrong).
- Console contract: `../acdp-ui-console/lib/server/proxy-allowlist.ts` (enrollments/webhooks/metrics = admin).
