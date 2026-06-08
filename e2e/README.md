# End-to-end smoke test (real webhook path)

Boots the full ACDP stack and exercises the **real** webhook flow:

```
       ┌──────────────┐
       │  playground  │   3 agents, each calling gpt-4o-mini via OpenAI
       │   (Python)   │   ─── derived_from chain: A → B,  A,B → C
       └──────┬───────┘
              │ publish ctx_id (X-Run-Id header)
              ▼
       ┌──────────────┐
       │  registry-a  │   (Rust, sqlite, tmpfs)
       └──────┬───────┘
              │ POST /webhooks/acdp  (HMAC-SHA256)
              ▼
       ┌──────────────┐
       │  playground  │   /webhooks/acdp router → fan into SSE → forward
       └──────┬───────┘
              │ POST /ingest/acdp  (HMAC-SHA256; same secret)
              ▼
       ┌──────────────────────────────┐
       │   control-plane (this repo)  │   persists context_events, runs,
       │      (NestJS)                │   lineage_edges; serves SSE + /lineage
       └──────┬───────────────────────┘
              ▼
       ┌──────────────┐
       │  postgres-cp │   Postgres 16, tmpfs, ephemeral
       └──────────────┘
```

End state for `s4_chain`: **3 nodes / 3 edges** in the control plane's lineage
DAG, identical to what the playground produced.

## The SSRF patch

The upstream registry validates webhook URLs against
`acdp::safe_http::SsrfPolicy::default()`, which is HTTPS-only and rejects IP
literals — the right production posture. For local Docker networking we need
the registry to POST to `http://playground:8000/webhooks/acdp`.

`e2e/registry-permissive/Dockerfile` wraps the registry's standard
`docker/Dockerfile` build flow and inserts a `sed` step that swaps the two
`SsrfPolicy::default()` call sites for a struct literal with
`allow_http: true` (the other fields stay strict — IP literals still rejected,
loopback IPs still rejected at the resolver level):

| File | Site |
|---|---|
| `crates/acdp-registry-server/src/main.rs:82` | startup config validation |
| `crates/acdp-registry-webhook/src/lib.rs:53`  | emitter spawn validation |

The patched image stays in your local Docker cache; the upstream registry
source is untouched. When upstream adds a loopback/private-host exemption,
delete `e2e/registry-permissive/` and switch the compose build context back
to `acdp-registry-rs/docker/Dockerfile`.

## Prereqs

- Docker + `docker compose`
- `curl` + `jq` on PATH
- An OpenAI API key with `gpt-4o-mini` access
- This sibling checkout layout (the compose builds from neighbour repos):

```
agentcontextdistributionprotocol/
├── acdp-control-plane/        (this repo)
│   └── e2e/                   (this directory)
├── acdp-playground/
├── acdp-registry-rs/
└── acdp-rs/
```

## Running it

The `.env` file lives at the **repo root** (`acdp-control-plane/.env`), not
inside `e2e/`. That way one secrets file serves both `npm run start:dev` and
this E2E. The template (`e2e/.env.example`) stays in `e2e/` because its
variables are E2E-specific.

```bash
# from acdp-control-plane/
cp e2e/.env.example .env            # one-time
$EDITOR .env                        # paste OPENAI_API_KEY

cd e2e
./run-e2e.sh
```

First run: ~5–10 min (the patched registry rebuilds from source + cargo-chef
caches the dep tree + playground builds a Python+Rust image). Subsequent runs:
~30–90 s, dominated by the LLM calls.

Keep the stack running afterwards to poke around:

```bash
KEEP_STACK=1 ./run-e2e.sh
# control plane:   http://localhost:3001/docs
# playground:      http://localhost:8000/runs
# registry-a:      http://localhost:8100/healthz
# postgres-cp:     psql postgres://acdp:acdp@localhost:5434/acdp_control_plane
docker compose -f docker-compose.e2e.yml --env-file ../.env down -v
```

Run a different scenario:

```bash
SCENARIO=s1_single_publish ./run-e2e.sh   # 1 node / 0 edges
SCENARIO=s2_producer_consumer ./run-e2e.sh # 2 nodes / 1 edge
SCENARIO=s4_chain ./run-e2e.sh             # 3 nodes / 3 edges (default)
SCENARIO=s5_cross_registry ./run-e2e.sh    # exercises both registries
```

## What the runner verifies

1. The full Docker stack comes up green (all healthchecks pass).
2. `POST /runs` on the playground asynchronously runs the scenario.
3. The playground completes the scenario — meaning every LLM call returned
   and every agent's content was published to the registry.
4. After completion, the runner polls
   `GET /runs/:runId/lineage` on the control plane until the node + edge
   counts equal what the playground produced. **No bridge** — the events
   arrive via the real registry → playground → control plane path.
5. Asserts strict equality on the edge set (order-independent).

## How run-correlation works end-to-end

| Hop | Carrier of `run_id` |
|-----|---------------------|
| agent → registry publish     | `X-Run-Id` header on `POST /contexts` |
| registry → playground webhook | `run_id` field in the `WebhookEvent` JSON body |
| playground → control plane    | same `WebhookEvent` JSON body forwarded verbatim; control plane reads `payload.run_id` (header `X-Run-Id` would also work) |

A side effect: `payload.registry_authority` is *not* present in the registry's
WebhookEvent (the upstream type only carries it implicitly via `ctx_id`). The
control plane recovers it from the `acdp://<authority>/<id>` prefix of
`ctx_id` — see `extractAuthorityFromCtxId` in
`src/ingest/ingest.service.ts`. Unit-tested in `ingest.service.spec.ts` and
integration-tested in `test/integration/ingest.integration.spec.ts`.

## Troubleshooting

| Symptom | Usually means |
|---|---|
| `error: OPENAI_API_KEY is empty in .env` | Set it. The runner refuses to start otherwise. |
| `webhook.url rejected by SSRF policy` in `registry-a` logs | The SSRF patch didn't apply — check the `sed` step output during `docker compose build registry-a`. |
| `[FAIL] timeout — control-plane never converged` | The webhook chain broke somewhere. Look at `docker compose logs playground` (did `/webhooks/acdp` 401? signature mismatch usually) and `docker compose logs control-plane` (did `/ingest/acdp` 400 on missing fields?). |
| `Cannot connect to the Docker daemon` | Start Docker Desktop / the daemon. |
| `compose ... bind: address already in use` (port 8000/8100/8200/3001/5434) | Stop whatever else is listening (often the regular playground compose). |
| `status = failed` after the LLM step | `docker compose logs playground` — usually a bad API key or model unavailable for your account. |
| First build hangs for ages | First-time Rust+Python+sed image builds are slow. `docker compose -f docker-compose.e2e.yml --env-file .env build --progress=plain` shows what's happening. |

## What this is *not*

- Not part of the automated test suite. `npm test` and `npm run test:integration`
  remain the gate for unit + integration coverage of the control plane in
  isolation. The E2E runs on demand, costs LLM tokens, and pulls in three
  external repos.
- Not deterministic on content. The LLM produces different text every run,
  so the runner asserts on the **structure** of the lineage DAG, not on
  prompt outputs.
