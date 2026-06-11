# ACDP Control Plane — Documentation

NestJS v11 control plane for the **Agent Context Distribution Protocol (ACDP)**.
It ingests registry webhook events, correlates them into *runs* by `X-Run-Id`,
persists raw events + run records + lineage edges, and broadcasts the firehose
via SSE — with auth/issuance, multi-tenancy, policy, quota, capability discovery,
and registry federation layered on top.

## Start here

| If you want to…                                   | Read |
|---------------------------------------------------|------|
| Understand the system shape and the request path  | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Call the HTTP API                                 | [API.md](./API.md) |
| Send events from a registry (the ingest contract) | [INGEST.md](./INGEST.md) |
| Issue/verify tokens, federate, revoke             | [AUTH.md](./AUTH.md) |
| Isolate data per tenant                           | [TENANCY.md](./TENANCY.md) |
| Gate actions with policy + quota                  | [POLICY.md](./POLICY.md) |
| Configure every environment variable              | [CONFIGURATION.md](./CONFIGURATION.md) |
| Run the test suites                               | [TESTING.md](./TESTING.md) |
| Debug a failing path                              | [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) |

## The 30-second model

```
ACDP Registries ──POST /ingest/acdp (HMAC, X-Run-Id)──► Control Plane ──► Postgres
                                                              │
                                                              ├─► SSE (per-run + global firehose)
                                                              ├─► outbound webhooks (outbox-tracked)
                                                              └─► REST: /runs /events /contexts /agents
                                                                       /capabilities /registries /dashboard
                                                                       /auth/* /domain-packs /routing
```

Every request crosses four guards in order — **Auth → Throttle → Policy → Quota**
(see [POLICY.md](./POLICY.md)) — and resolves to a **tenant** that scopes all
reads and writes (see [TENANCY.md](./TENANCY.md)).

## Subsystem map

- **Ingest pipeline** — `src/ingest/`, `src/processor/`. The six-step core. See [INGEST.md](./INGEST.md).
- **Auth & issuance** — `src/auth/`. API keys + JWT challenge/response, did:web,
  cross-issuer federation, bidirectional revocation. See [AUTH.md](./AUTH.md).
- **Tenancy** — `src/tenant/`. The unit of data isolation. See [TENANCY.md](./TENANCY.md).
- **Policy & quota** — `src/policy/`, `src/quota/`. Decorator-gated authorization and rate limiting. See [POLICY.md](./POLICY.md).
- **Capabilities & routing** — `src/agents/capability.*`, `src/routing/`. Signed self-declaration + bandit selection.
- **Domain packs** — `src/domain-packs/`. Vertical `context_type` gating.
- **Federation proxy** — `src/contexts/`. SSRF-gated context retrieval from owning registries.
- **Streaming** — `src/events/`. SSE fan-out (`memory` or `redis` strategy).
- **Storage** — `src/storage/`, `src/db/`. Drizzle repositories + programmatic migrations.

## Conventions (enforced)

- Business errors → `AppException(ErrorCode.X, msg, httpStatus)`, normalized by `GlobalExceptionFilter`. Never `throw new Error()` on request paths.
- Logging via `nestjs-pino` (`new Logger(ClassName.name)`); never `console.*`.
- All `process.env` reads live in `AppConfigService` (a few documented exemptions).
- All prom-client metrics constructed in `InstrumentationService`.
- Protocol crypto/SSRF/DID come from the `acdp` SDK (Rust `acdp-rs` via NAPI), never hand-rolled.

See `CLAUDE.md` at the repo root for the full convention list and CI grep rules.
</content>
</invoke>
