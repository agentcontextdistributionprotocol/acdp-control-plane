# Progress — docs-refresh

Plan: `plans/docs-refresh.md` (plans/ is gitignored; PROGRESS.md is tracked)

## Phase log
PR strategy: ONE PR (docs-only, reversible, disjoint files; no natural seam needing separate PRs). All phases Risk: simple (docs-only) — verified in batches of ≤2 by fresh Opus; P2–P5 executed in parallel by Opus subagents on disjoint files after P1 commit.
- P1 DONE (b72707c) · P2 DONE (a8a20b4) · P3 DONE (934c701) · P4 DONE (4f341ca) · P5 DONE (2c5871d) · P6 DONE (this commit)
- Gates (fresh Opus): P1+P2 PASS (2 wording gaps fixed: API.md tenant-reserved dev-bypass qualifier, FORBIDDEN kind); P3+P4 PASS (1 gap fixed: INGEST base-URL `??` chain wording); P5+P6 + cumulative final verify below. 1 round each.
- P3 checklist: all 16 plan items confirmed in code and changed (AUTH/TENANCY/POLICY); example.rego comment-only edit.
- P4 evidence: mermaid 3 blocks rendered (mermaid-cli 12.0.0); 21 tables / 26 migrations / 7 steps diffs empty.
- P5 evidence: 94/94 env vars; 36 integration specs named; 21 ErrorCodes exist; OTEL default verified in node_modules/@opentelemetry/sdk-node (sdk.js:213-214, utils.js:55-59,88-90).
- P6 evidence: 151 intra-repo links dead=0; 64 external URLs 200; 7 mermaid blocks render; npm test 97/97 suites; lint + check:conventions clean; `git diff main -- src test` empty.

## Repo map (discovery notes for `/implement` — don't re-scan)

Docs (all under this repo): `README.md` (150), `docs/README.md` (85, index), `docs/API.md` (925),
`docs/ARCHITECTURE.md` (616, ASCII diagram only), `docs/AUTH.md` (300), `docs/TENANCY.md` (179),
`docs/POLICY.md` (220), `docs/policies/{example.rego,example_test.rego}`, `docs/INGEST.md` (258),
`docs/CONFIGURATION.md` (461), `docs/TESTING.md` (256), `docs/TROUBLESHOOTING.md` (686), `.env.example`.
Local-only (gitignored): `plans/`.

Code ground truth:
- `src/config/app-config.service.ts` — all env vars; dev early-return at :766; validate() checks.
- `src/app.module.ts:130-138` — guard order Auth, Throttle, Policy, Quota.
- `src/bootstrap.ts` — body limit :87-88 (413), swagger tags :110-114, trust proxy.
- `src/ingest/{ingest.controller,ingest.service}.ts` — HMAC, enrollment, tenant, authority derivation.
- `src/processor/event-processor.service.ts` — 7-step pipeline, fingerprint :216/225, scenario_id :230.
- `src/events/`, `src/runs/runs.controller.ts` — routes, run-notify :252-257.
- `src/auth/{auth.guard,auth.module,revoke.controller,trusted-issuers,jwks-client,issuance-ledger.service}.ts`.
- `src/policy/{policy.module,policy.guard,opa-policy.decider,static-rules-policy.decider}.ts`; `src/quota/quota.guard.ts`.
- `src/tenant/{tenant-context,request-tenant}.ts`; `src/middleware/`; `src/common/trust-proxy.ts`.
- `src/errors/{error-codes,exception.filter}.ts` (+ spec pins table in API.md).
- `src/telemetry/instrumentation.service.ts:137-241` — all metrics.
- `src/db/schema.ts` (21 tables), `drizzle/0000..0025*.sql` (26 files).
- `src/audit/`, `src/witness/`, `src/retention/data-retention.service.ts:89-97`, `src/webhooks/webhook.service.ts:134`.
- `src/registries/registries.controller.ts` (alerts :51, ack :83), `src/domain-packs/` (GET only), `src/routing/bandit-router.service.ts:57`.
- `test/integration/*.integration.spec.ts` (11 unlisted in TESTING.md), `.github/workflows/ci.yml` (spec pin :40, redis svc).

Siblings (read-only; link, never copy): spec repo local dir `../agentcontextdistributionprotocol`
(rfcs/, registries/, schemas/json/, docs/version-matrix.md) pinned permalink commit
`34f14ab2ab454308e94fd6f137ef940db45c72c8`; `../acdp-rs/docs/`; `../acdp-registry-rs/docs/`
(WEBHOOKS, RECEIPTS, AUTHENTICATION, MULTI-TENANCY, HTTP-API, OPERATIONS, UPGRADING);
`../acdp-docs/kb/ecosystem-map.md`. URL form:
`https://github.com/agentcontextdistributionprotocol/<repo>/blob/main/<path>` (spec repo: use commit hash).

Audit findings are summarized in the plan phases (item numbers refer to the audit reports; re-derive any
item from the cited `file:line` in the plan — all are code-grounded).
pushed docs/refresh-against-code df8fe56
