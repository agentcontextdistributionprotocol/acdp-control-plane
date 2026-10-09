# ACDP Control Plane — Documentation

NestJS v12 control plane for the **Agent Context Distribution Protocol (ACDP)**.
It ingests registry webhook events, correlates them into *runs* by `X-Run-Id`,
persists raw events + run records + lineage edges, and broadcasts the firehose
via SSE — with auth/issuance, multi-tenancy, policy, quota, capability discovery,
and registry federation layered on top.

## Ecosystem & sources of truth

The control plane is one repo in the ACDP ecosystem. These docs are **additive**:
they cover what is *specific to this service* and deliberately **do not restate**
protocol wire formats, crypto, or semantics that another repo owns — they link
out instead. When this doc and an authoritative source disagree, the source wins.

| Repo | Owns (the authority for…) | Docs |
|------|---------------------------|------|
| [`agentcontextdistributionprotocol`](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/README.md) (spec) | Normative protocol: the [RFCs](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/README.md) and the IANA-style [registries](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/registries/README.md) (context-types, signature-algorithms, error-codes, auth-methods, lifecycle-event-types). The audit/witness surfaces this CP implements are normative here — [receipts (0010)](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0010-registry-receipts.md), [transparency log (0012)](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0012-transparency-log.md), [lifecycle events (0013)](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0013-lifecycle-events.md), [producer key-revocation (0014)](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0014-key-revocation.md), [witness cosigning (0015)](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0015-witness-cosigning.md). Links are pinned to the spec commit CI conformance-tests against. | RFC-ACDP-0001…0016 |
| [`acdp-rs`](https://github.com/agentcontextdistributionprotocol/acdp-rs/blob/main/README.md) (crate `acdp`) | The reference implementation this CP consumes via its [Node binding](https://github.com/agentcontextdistributionprotocol/acdp-rs/blob/main/docs/bindings.md) (npm `@agentcontextdistributionprotocol/acdp`, pinned `^0.14.4`): Ed25519/ECDSA-P256 verification, did:web resolution, JCS, receipt + transparency-log verification, the [SSRF model](https://github.com/agentcontextdistributionprotocol/acdp-rs/blob/main/docs/security.md). | [acdp-rs/docs](https://github.com/agentcontextdistributionprotocol/acdp-rs/blob/main/docs/README.md) |
| [`acdp-registry-rs`](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/README.md) (registry) | The upstream emitter whose semantics this CP **mirrors and witnesses**: [auth challenge/response + revocation](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/AUTHENTICATION.md), [multi-tenancy](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/MULTI-TENANCY.md), [webhook event shapes](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/WEBHOOKS.md), [registry receipts (runbook)](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/RECEIPTS.md), and the transparency-log / checkpoint endpoints it serves ([HTTP-API](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/HTTP-API.md)). | [acdp-registry-rs/docs](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/README.md) |
| **`acdp-control-plane`** (this repo) | This service: the ingest pipeline, run correlation, SSE fan-out, the REST surface, the four-guard chain, outbox webhooks, and the **observer-side** audit/witness sweeps (receipt audit, checkpoint witness, inclusion audit, cosigning) — *what this CP does with* the protocol above, never a restatement of it. | this `docs/` |

> **Why the CP mirrors the registry.** The CP must accept exactly what the
> registry produces — the same challenge signing input, the same tenancy
> resolution, the same revocation feed format — so its crypto/SSRF/DID logic is a
> thin wrapper over the `acdp` SDK, and its auth/tenancy rules track the
> registry's. Where a section restates such a rule, it cites the owning doc.

## Sibling docs

The single link index for normative and upstream material. Other docs in this
folder link here (or straight to the files below) rather than restating them.

**Spec** — pinned to commit `34f14ab` (the `ACDP_SPEC_DIR` checkout in
`.github/workflows/ci.yml`), so a link always shows the text this CP was
tested against. RFCs whose behaviour the CP implements or consumes:

| RFC | What the CP does with it |
|-----|--------------------------|
| [RFC-ACDP-0001 core](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0001-core.md) | Signature algorithms (§5.10, strict Ed25519) and key resolution incl. `did:key` (§5.11) — via the SDK |
| [RFC-ACDP-0004 retrieval](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0004-retrieval.md) | The federation proxy `GET /contexts/*ctxId` fetches from the owning registry |
| [RFC-ACDP-0007 capabilities](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0007-capabilities.md) | Error envelope (§4) and wire error-code vocabulary (§5) that the CP's own codes sit beside |
| [RFC-ACDP-0008 security](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0008-security.md) | Read authentication (§6.2, `bearer_jwt`) mirrored by `/auth/challenge` + `/auth/token`; producer DID resolution SSRF rules (§4.8) |
| [RFC-ACDP-0010 registry receipts](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0010-registry-receipts.md) | Receipt audit sweep |
| [RFC-ACDP-0012 transparency log](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0012-transparency-log.md) | Checkpoint witness + log-inclusion audit |
| [RFC-ACDP-0013 lifecycle events](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0013-lifecycle-events.md) | Lifecycle webhook events accepted on ingest |
| [RFC-ACDP-0014 key revocation](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0014-key-revocation.md) | Producer key-revocation verification + §7 classification |
| [RFC-ACDP-0015 witness cosigning](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/RFC-ACDP-0015-witness-cosigning.md) | Cosignature minting (`/log/witness`) and N-witnessed quorum consumption |

The full RFC list (0001…0016) is in the [RFC index](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/rfcs/README.md).
Registries: [context types](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/registries/context-types.md) ·
[signature algorithms](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/registries/signature-algorithms.md) ·
[auth methods](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/registries/auth-methods.md) ·
[error codes](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/registries/error-codes.md) ·
[lifecycle event types](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/registries/lifecycle-event-types.md) ·
[profiles](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/registries/profiles.md) (`acdp-registry-receipts`, `acdp-registry-transparency-log`).
JSON schemas: [registry receipt](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/schemas/json/acdp-registry-receipt.schema.json) ·
[log checkpoint](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/schemas/json/acdp-log-checkpoint.schema.json) ·
[log inclusion](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/schemas/json/acdp-log-inclusion.schema.json) ·
[log leaf](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/schemas/json/acdp-log-leaf.schema.json) ·
[log cosignature](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/34f14ab2ab454308e94fd6f137ef940db45c72c8/schemas/json/acdp-log-cosignature.schema.json).
Which spec version each implementation claims: the
[version matrix](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/blob/main/docs/version-matrix.md)
(on `main` — it is a living table).

**SDK (`acdp-rs`, on `main`)** —
[bindings](https://github.com/agentcontextdistributionprotocol/acdp-rs/blob/main/docs/bindings.md) (the Node binding this CP loads) ·
[security](https://github.com/agentcontextdistributionprotocol/acdp-rs/blob/main/docs/security.md) (SSRF model, strict verification) ·
[errors](https://github.com/agentcontextdistributionprotocol/acdp-rs/blob/main/docs/errors.md) ·
[consuming](https://github.com/agentcontextdistributionprotocol/acdp-rs/blob/main/docs/consuming.md) (verifying contexts) ·
[architecture](https://github.com/agentcontextdistributionprotocol/acdp-rs/blob/main/docs/architecture.md) ·
[conformance](https://github.com/agentcontextdistributionprotocol/acdp-rs/blob/main/docs/conformance.md).

**Registry (`acdp-registry-rs`, on `main`)** —
[WEBHOOKS](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/WEBHOOKS.md) (what `/ingest/acdp` receives) ·
[RECEIPTS](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/RECEIPTS.md) ·
[AUTHENTICATION](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/AUTHENTICATION.md) ·
[MULTI-TENANCY](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/MULTI-TENANCY.md) ·
[HTTP-API](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/HTTP-API.md) ·
[CONFIGURATION](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/CONFIGURATION.md) ·
[OPERATIONS](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/OPERATIONS.md) ·
[UPGRADING](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/UPGRADING.md).

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

- **Ingest pipeline** — `src/ingest/`, `src/processor/`. The seven-step core. See [INGEST.md](./INGEST.md).
- **Auth & issuance** — `src/auth/`. API keys + JWT challenge/response, did:web,
  cross-issuer federation, bidirectional revocation. See [AUTH.md](./AUTH.md).
- **Tenancy** — `src/tenant/`. The unit of data isolation. See [TENANCY.md](./TENANCY.md).
- **Policy & quota** — `src/policy/`, `src/quota/`. Decorator-gated authorization and rate limiting. See [POLICY.md](./POLICY.md).
- **Capabilities & routing** — `src/agents/capability.*`, `src/routing/`. Signed self-declaration + bandit selection.
- **Domain packs** — `src/domain-packs/`. Vertical `context_type` gating.
- **Federation proxy** — `src/contexts/`. SSRF-gated context retrieval from owning registries.
- **Streaming** — `src/events/`. SSE fan-out (`memory` or `redis` strategy).
- **Audit & witness** — `src/audit/`. Receipt audit (RFC-ACDP-0010), transparency-log
  checkpoint witness + inclusion audit (RFC-ACDP-0012), producer key-revocation
  verification + classification (RFC-ACDP-0014). See [ARCHITECTURE.md](./ARCHITECTURE.md#transparency-audit--witness-rfc-acdp-0010--0012--0014--0015).
- **Witness cosigning** — `src/witness/`. RFC-ACDP-0015 cosignature mint/serve
  (`/log/witness`, `/.well-known/acdp-witness.json`, `/.well-known/did.json`).
- **Storage** — `src/storage/`, `src/db/`. Drizzle repositories + programmatic migrations.

## Conventions (enforced)

- Business errors → `AppException(ErrorCode.X, msg, httpStatus)`, normalized by `GlobalExceptionFilter`. Never `throw new Error()` on request paths.
- Logging via a `pino`-backed `LoggerService` (`src/common/pino-logger.ts`), passed to
  `NestFactory.create` in `src/bootstrap.ts`; use `new Logger(ClassName.name)`, never `console.*`.
- All `process.env` reads live in `AppConfigService` (a few documented exemptions).
- All prom-client metrics constructed in `InstrumentationService`.
- Protocol crypto/SSRF/DID come from the `acdp` SDK (Rust `acdp-rs` via NAPI), never hand-rolled.

The full rule set is enforced by `scripts/ci-conventions.sh` (`npm run check:conventions`,
see [TESTING.md](./TESTING.md)); module layout and the pipeline are in
[ARCHITECTURE.md](./ARCHITECTURE.md).
