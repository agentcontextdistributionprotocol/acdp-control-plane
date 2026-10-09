# Progress — tenant-enroll-quota-fix

Plan: `plans/tenant-enroll-quota-fix.md` (plans/ is gitignored; this file is tracked)

## Phase log
PR strategy (planned): PR-A = P1+P2 (enrollment), PR-B = P3+P4 (quota).
- P1 DONE (Opus solo gate PASS, 1 round; gap: log read could mask 409 → fixed) — files: registry-enrollment.repository(+spec), registries.controller(+spec), error-codes(+spec), enroll-registry.dto, ingest-trust.integration.spec, docs API/INGEST/TENANCY/ARCHITECTURE, DEFERRED.md
- P2 DONE (Opus gate GAPS→PASS after fixes, 2 rounds incl. fixes) — repo set-builder, DTO nullable, controller pass-through, registry-enroll-partial integration spec, docs
- P3 TODO
- P4 TODO

## Repo map (discovery notes for `/implement` — don't re-scan)

Enrollment:
- `src/storage/registry-enrollment.repository.ts` — upsert (`:21-49`, conflict target authority `:37`, `set` incl. tenantId `:39`), findByAuthority `:52` (global), list(tenant) `:61`, listAllEnabled `:73`, count `:82`; no delete.
- `src/db/schema.ts:203-222` — `registry_enrollments`, PK authority; `drizzle/0010_registry_enrollments.sql`; next migration number 0026 (not needed).
- `src/registries/registries.controller.ts:154-182` — enroll handler (assertAdmin, assertNotReservedTenant, `tenantId: body.tenantId ?? tenantOf(req)`); `src/dto/enroll-registry.dto.ts` (Swagger default text `:17` wrong).
- `src/auth/auth.guard.ts:218` — global admin list; `src/auth/admin.ts` assertAdmin.
- `src/ingest/ingest.service.ts:72-112` — enrollment → tenant/secret/baseUrl; HMAC `:114`.
- `src/audit/checkpoint-witness.service.ts:213,240` — listAllEnabled, per-row tenant; `log_witness_cursors` PK (tenant, authority) `schema.ts:549`.
- `src/errors/error-codes.ts` (~`:142` insert point), `src/errors/error-codes.spec.ts` (`SHIPPED` set equality + API.md row).
- `src/storage/context-lifecycle.repository.ts:68` — existing `setWhere` upsert pattern.
- Tests: `src/registries/registries.controller.spec.ts:38-68`; `test/integration/ingest-trust.integration.spec.ts:143-164`; `log-witness.integration.spec.ts:337,454`.

Quota:
- `src/quota/quota.guard.ts:62-110` (tenant fallback `:62-65`, key `:70`, 429 shape `:86-110`), `quota-config.ts:139-147` resolveLimit, `quota-store.ts:78-90`, `quota.module.ts`; decorator `@CheckQuota`.
- `src/ingest/ingest.controller.ts:24-25,42-43`; `src/ingest/ingest.service.ts:42-192`; `src/processor/event-processor.service.ts:72-93` dedup after insert.
- `src/agents/capability.controller.ts:95` — only other `@CheckQuota` user (authenticated).
- `src/app.module.ts:130-138` — guard order Auth, Throttle, Policy, Quota.
- `src/telemetry/instrumentation.service.ts:128` — ingest rejected counter.
- Tests: `src/quota/quota.guard.spec.ts:59-135`, `src/ingest/ingest.service.spec.ts` (`new IngestService(` at :47,:73,:103,:276,:292), `test/integration/quota.integration.spec.ts` (:1-5,:38-39 stale), `test/helpers/test-client.ts:46` signatureOverride.
- Registry retry on 429: `../acdp-registry-rs/docs/WEBHOOKS.md:258-263`.

Docs to update: docs/{API,INGEST,POLICY,TENANCY,TROUBLESHOOTING,ARCHITECTURE,CONFIGURATION}.md (line refs in the plan phases), `DEFERRED.md`, local CLAUDE.md:317-318.
pushed fix/enrollment-tenant-immutable 80699bd
