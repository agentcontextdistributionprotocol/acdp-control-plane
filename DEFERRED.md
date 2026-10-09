# Deferred

Code observations surfaced while refreshing the docs against the code (docs-refresh, 2026-10).
None is fixed by that docs-only change; the docs describe current behaviour. One line each:
category, then `file:line` evidence. File an issue only once an item has a reproducible repro.

## Ingest

- **bug** — `/ingest/acdp` `@CheckQuota('publish')` runs before HMAC and, the route being `@Public()`, always counts against `default`, so unsigned requests burn the quota (`src/ingest/ingest.controller.ts:25`, `src/quota/quota.guard.ts:62-65`).
- **bug** — `INGEST_MAX_JSON_DEPTH` doesn't protect the first parse: Express's JSON body parser has already parsed the body (`src/bootstrap.ts:88`) before the depth pre-scan runs (`src/ingest/ingest.service.ts:48`).
- **security** — `X-ACDP-Event-Id` is outside the HMAC (body-only, `src/ingest/ingest.service.ts:114`) yet takes precedence as the dedup key (`:191`, `src/processor/event-processor.service.ts:216`), so replaying a signed body with a fresh header bypasses dedup.
- **security** — unsigned `Origin` overrides the enrolled base URL (`src/ingest/ingest.service.ts:187`) and, when the payload has no `registry_base_url`, is upserted as `registries.base_url` (`src/processor/event-processor.service.ts:159-163`), which the federation proxy fetches from (`src/contexts/contexts.controller.ts:63-74`).
- **comment** — the base-URL precedence comment (`src/ingest/ingest.service.ts:184-186`: Origin, then enrolled, then payload) contradicts the processor, which takes `payload.registry_base_url` first (`src/processor/event-processor.service.ts:159-162`).

## Auth, tenancy, policy

- **bug** — `docs/policies/example.rego` has no allow rule for an authenticated `context.retrieve` with `resource_visibility: null`, which is what `PolicyGuard` always sends (no `resourceVisibility` set, `src/policy/policy.guard.ts:86-96` → `src/policy/opa-policy.decider.ts:153`), so it is a 403 under `POLICY_BACKEND=opa`.
- **unverified** — the OPA decider builds `/v1/data/<dotted.package>/decision` (`src/policy/opa-policy.decider.ts:88-91`); OPA's Data API expects slash-separated package paths. Not checked against a live OPA.
- **bug** — a malformed `TENANT_API_KEYS` entry is parsed lazily on the first API-key request and throws a plain `Error` → 500 on every API-key request (`src/auth/auth.guard.ts:261`, `src/tenant/tenant-context.ts:48` empty side, `:66` duplicate key).
- **bug** — `TENANT_AGENTS` is also parsed lazily, inside `mintJwt` (`src/auth/token-issuer.service.ts:449-452`), after the challenge nonce has been consumed (`:163`), so a malformed value fails `/auth/token` and burns the nonce.
- **bug** — an `http://` `TRUSTED_ISSUERS` EdDSA JWKS URL passes startup (`src/auth/trusted-issuers.ts:166`) but every fetch rejects it (`src/auth/jwks-client.ts:112`).
- **design** — run-notify endpoints let any HMAC holder pick any non-`default` tenant via `X-Tenant-Id` (`src/runs/runs.controller.ts:252-257`).
- **gap** — no unenroll/transfer route exists, so an enrollment's (now immutable) tenant binding cannot be moved; an admin `DELETE /registries/enrollments/:authority` would also have to handle the old tenant's `log_witness_cursors` (PK `(tenant_id, registry_authority)`, `src/db/schema.ts:549`) (`src/storage/registry-enrollment.repository.ts` has no delete).
- **design** — per-tenant admin scoping is deferred: admin keys are global operator keys (`AUTH_ADMIN_API_KEYS`, `src/auth/auth.guard.ts:218`), so any admin may create an enrollment for any tenant via `body.tenantId` (`src/registries/registries.controller.ts`); separating operator vs tenant-admin keys is an auth-model change.
- **security** — failed authentication is never rate-limited: `AuthGuard` is registered before `ThrottleByUserGuard` (`src/app.module.ts:130-131`) and throws 401 before the throttle runs (`src/auth/auth.guard.ts:62-89`).
- **comment** — `src/auth/revoke.controller.ts:25-27` says revoke is "throttled separately"; the controller has no throttle override.

## Audit trail and retention

- **gap** — `IssuanceLedgerService.verifyChain()` (`src/auth/issuance-ledger.service.ts:136`) is never called outside specs, although the header (`:30`) points operators at a "`verifyChain()` job".
- **gap** — the issuance ledger's in-process `memoryChain` grows without bound in every persistence mode (`src/auth/issuance-ledger.service.ts:97`, `:229`).
- **gap** — `AuthSweeperService` evicts only challenges and revocations (`src/auth/auth-sweeper.service.ts:66-70`), and nothing purges `issuance_ledger` (`src/db/schema.ts:353`).
- **gap** — `DataRetentionService` purges runs, deliveries, events and cosignatures (`src/retention/data-retention.service.ts:89-98`) but never `receipt_audits` or `log_inclusion_audits`; `ReceiptAuditRepository.deleteBefore` (`src/storage/receipt-audit.repository.ts:152`) has no caller.

## API surface

- **bug** — `PATCH /webhooks/:id` with an unknown id returns 200 with an empty body instead of 404 (`src/webhooks/webhook.repository.ts:84` returns null → `src/webhooks/webhook.controller.ts:85`).
- **security** — `/metrics` is `@Public()`, so it's served without authentication (`src/metrics/metrics.controller.ts:9`).

## Config and telemetry

- **wording** — the boot warning says traces "will be discarded" when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset (`src/config/app-config.service.ts:790`), but the OTLP exporter defaults to `http://localhost:4318` (`node_modules/@opentelemetry/otlp-exporter-base/build/src/configuration/otlp-http-configuration.js:60`).

## Swagger metadata

- **swagger** — `/events` `limit` is advertised as `default: 200` (`src/dto/list-events-query.dto.ts:36`); the controller defaults it to 500 (`src/events/events.controller.ts:39`).
- **swagger** — capability search and by-agent are declared `isArray: true` (`src/agents/capability.controller.ts:128,142`) but return `{ data, total }` (`:137`, `:149`).
- **swagger** — `/auth/token` says it "issues an HS256 JWT" (`src/auth/auth.controller.ts:103`); `JWT_SIGNING_ALG` also allows `EdDSA`.
- **swagger** — only 5 tags get descriptions (`src/bootstrap.ts:111-115`; `contexts` is described as "lineage browsing" though it is the federation proxy), while controllers declare 14 `@ApiTags`.
