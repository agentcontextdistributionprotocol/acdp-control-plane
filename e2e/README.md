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
`docker/Dockerfile` build flow and inserts two `sed` patches:

| File | Site | Patch |
|---|---|---|
| `crates/acdp-registry-server/src/main.rs` | startup `webhook.url` validation | `SsrfPolicy::default()` → `allow_http: true` |
| `crates/acdp-registry-webhook/src/lib.rs` | `WebhookEmitter::try_spawn` URL check | `SsrfPolicy::default()` → `allow_http: true` |
| `crates/acdp-registry-webhook/src/lib.rs` | `worker()` delivery client | `safe_http::safe_client(&policy, …)` → plain `reqwest` client |

The third patch is needed because the URL check passing is not enough: the
delivery client is built with the strict default policy, which refuses
`http://` and filters every resolved IP — and the address `playground`
resolves to on the Docker network (RFC 1918) is refused under every
`SsrfPolicy` setting. Without it the registry boots, accepts the config,
and silently fails every delivery. Each patch is checked with `grep -q`
after the `sed`, so an upstream move fails the image build loudly. The
registry's other outbound clients (DID resolution, federation) keep the
strict guard.

The patched image stays in your local Docker cache; the upstream registry
source is untouched. When upstream adds a loopback/private-host exemption,
delete `e2e/registry-permissive/` and switch the compose build context back
to `acdp-registry-rs/docker/Dockerfile`.

## Prereqs

- Docker + `docker compose`
- `curl` + `jq` on PATH
- An OpenAI API key with `gpt-4o-mini` access (or an Anthropic key, or
  `LLM_PROVIDER=mock` for no key at all)
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
variables are E2E-specific. Only the LLM key is required; every other value
has a default in `docker-compose.e2e.yml`.

```bash
# from acdp-control-plane/
cp e2e/.env.example .env            # one-time, if there is no .env yet
# cat e2e/.env.example >> .env      # ...or append, if .env already exists
$EDITOR .env                        # paste OPENAI_API_KEY

cd e2e
./run-e2e.sh
```

First run: ~5–10 min (the patched registry rebuilds from source without
cargo-chef — see the Dockerfile — and the playground builds its Python image). Subsequent runs:
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

Check the plumbing without spending tokens — the playground's deterministic
`mock` agents publish the same lineage through the same registry → playground
→ control-plane webhook path, with zero LLM calls and no key required:

```bash
LLM_PROVIDER=mock ./run-e2e.sh
```

Use Anthropic instead of OpenAI (`LLM_MODEL` is required — the playground's
default is an OpenAI model name):

```bash
LLM_PROVIDER=anthropic LLM_MODEL=<claude-haiku-model-id> ./run-e2e.sh
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
| `webhook delivery failed` in `registry-a` logs, CP never converges | The delivery-client half of the SSRF patch didn't apply (the URL check passing is not enough — the strict delivery client refuses `http://` and Docker's RFC 1918 addresses). |
| `[FAIL] timeout — control-plane never converged` | The webhook chain broke somewhere. Look at `docker compose logs playground` (did `/webhooks/acdp` 401? signature mismatch usually) and `docker compose logs control-plane` (did `/ingest/acdp` 400 on missing fields?). |
| `Cannot connect to the Docker daemon` | Start Docker Desktop / the daemon. |
| `compose ... bind: address already in use` (port 8000/8100/8200/3001/5434) | Stop whatever else is listening (often the regular playground compose). |
| `status = failed` after the LLM step | `docker compose logs playground` — usually a bad API key or model unavailable for your account. |
| `agent_id method 'did:key' is not in this registry's supported_did_methods` | `e2e/config/registry-*.toml` lost `"did:key"` from `[auth] did_methods` — the playground's agents publish as did:key. |
| `e2e SSRF patch no longer matches acdp-registry-rs` during the registry build | Upstream moved a webhook SSRF call site. Update the `sed` lines in `e2e/registry-permissive/Dockerfile` (both the URL check and the delivery client). |
| `control-plane` is `unhealthy` but its logs look fine | The healthcheck must use `node` — the runtime image ships neither `wget` nor `curl`. |
| First build hangs for ages | First-time Rust+Python+sed image builds are slow. `docker compose -f docker-compose.e2e.yml --env-file .env build --progress=plain` shows what's happening. |

## What this is *not*

- Not part of the automated test suite. `npm test` and `npm run test:integration`
  remain the gate for unit + integration coverage of the control plane in
  isolation. The E2E runs on demand, costs LLM tokens, and pulls in three
  external repos.
- Not deterministic on content. The LLM produces different text every run,
  so the runner asserts on the **structure** of the lineage DAG, not on
  prompt outputs.
