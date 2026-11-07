#!/usr/bin/env bash
#
# End-to-end smoke test against the FULL stack:
#
#   agent → registry → playground (forwards webhook) → control-plane
#                       (HMAC-SHA256)               (HMAC-SHA256)
#
#   1. Bring up the stack (postgres-cp + control-plane + 2 registries + playground)
#   2. Trigger a real s4_chain scenario (3 agents call gpt-4o-mini via OpenAI)
#   3. Poll the playground until the run completes
#   4. Poll the control-plane until it has received the registry-driven webhooks
#      for every published context (no bridge — the registry actually POSTs)
#   5. Assert the control plane's lineage DAG matches the playground's
#   6. Tear down (unless KEEP_STACK=1)
#
# Why the registry-permissive Dockerfile?
#   The upstream registry's startup config validation rejects http:// webhook
#   URLs (SsrfPolicy::default() — production policy is HTTPS-only). The
#   E2E build at e2e/registry-permissive/Dockerfile seds the two call sites
#   to allow http:// so the registry → http://playground:8000/webhooks/acdp
#   hop is permitted. See e2e/README.md.
#
# Usage:
#   ./run-e2e.sh                # full run + teardown
#   KEEP_STACK=1 ./run-e2e.sh   # leave the stack running
#   SCENARIO=s1_single_publish ./run-e2e.sh
#   LLM_PROVIDER=mock ./run-e2e.sh   # same webhook path, zero LLM calls / no key

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

# The .env lives at the repo root so a single secrets file serves both
# `npm run start:dev` and this E2E. The template (.env.example) stays in
# e2e/ since its variables are E2E-specific.
ENV_FILE="$REPO_ROOT/.env"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.e2e.yml"

if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found." >&2
  echo "       Create it from the template:" >&2
  echo "         cp $SCRIPT_DIR/.env.example $ENV_FILE" >&2
  echo "         \$EDITOR $ENV_FILE   # fill in OPENAI_API_KEY" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

LLM_PROVIDER="${LLM_PROVIDER:-openai}"
case "$LLM_PROVIDER" in
  openai)
    [ -n "${OPENAI_API_KEY:-}" ] || { echo "error: OPENAI_API_KEY is empty in $ENV_FILE." >&2; exit 1; } ;;
  anthropic)
    [ -n "${ANTHROPIC_API_KEY:-}" ] || { echo "error: ANTHROPIC_API_KEY is empty in $ENV_FILE." >&2; exit 1; }
    # The playground's LLM_MODEL default is an OpenAI model name.
    [ -n "${LLM_MODEL:-}" ] || { echo "error: LLM_PROVIDER=anthropic needs LLM_MODEL (e.g. a Claude Haiku model id)." >&2; exit 1; } ;;
  mock) ;;  # playground's deterministic agents: zero LLM calls, no key needed
  *) echo "error: LLM_PROVIDER must be openai, anthropic or mock (got '$LLM_PROVIDER')." >&2; exit 1 ;;
esac
export LLM_PROVIDER

for bin in docker curl jq; do
  command -v "$bin" >/dev/null || { echo "error: '$bin' not on PATH" >&2; exit 1; }
done

SCENARIO="${SCENARIO:-s4_chain}"
PLAYGROUND_URL="http://localhost:8000"
CP_URL="http://localhost:3001"
CP_API_KEY="${CP_API_KEY:-e2e-cp-key}"
CP_POLL_TIMEOUT_SECS="${CP_POLL_TIMEOUT_SECS:-30}"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
dim()   { printf "\033[2m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }

teardown() {
  if [ "${KEEP_STACK:-0}" = "1" ]; then
    dim "KEEP_STACK=1 — leaving the stack running. Tear it down with:"
    dim "  docker compose -f $COMPOSE_FILE --env-file $ENV_FILE down -v"
    return
  fi
  bold "[teardown] docker compose down"
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" down -v >/dev/null 2>&1 || true
}
trap teardown EXIT

# ── 1. Up ────────────────────────────────────────────────────────────
bold "[1/5] docker compose up --build --wait  (first build ~5–10 min)"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build --wait

# ── 2. Trigger run ───────────────────────────────────────────────────
bold "[2/5] POST $PLAYGROUND_URL/runs  scenario=$SCENARIO"
RUN_RESPONSE=$(curl -sS -X POST "$PLAYGROUND_URL/runs" \
  -H "Content-Type: application/json" \
  -d "{\"scenario_id\":\"$SCENARIO\",\"inputs\":{}}")
RUN_ID=$(echo "$RUN_RESPONSE" | jq -r .run_id)
if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
  red "[FAIL] could not extract run_id"; echo "$RUN_RESPONSE"; exit 1
fi
echo "      run_id = $RUN_ID"

# ── 3. Poll for completion ───────────────────────────────────────────
bold "[3/5] polling playground for run completion (LLM runs here — ~30-90s)"
RESULT_JSON=""
is_terminal() {
  case "$1" in
    complete|completed|failed|error) return 0 ;;
    *) return 1 ;;
  esac
}
is_success() {
  case "$1" in
    complete|completed) return 0 ;;
    *) return 1 ;;
  esac
}

for i in $(seq 1 120); do
  RESULT_JSON=$(curl -sS "$PLAYGROUND_URL/runs/$RUN_ID")
  STATUS=$(echo "$RESULT_JSON" | jq -r '.status // "running"')
  if is_terminal "$STATUS"; then
    echo "      status = $STATUS  (after ~$((i * 2))s)"
    break
  fi
  printf "."
  sleep 2
done
echo
if ! is_success "$STATUS"; then
  red "[FAIL] run did not complete; status=$STATUS"
  echo "$RESULT_JSON" | jq . || echo "$RESULT_JSON"
  exit 1
fi

EXPECTED_NODES=$(echo "$RESULT_JSON" | jq '.result.lineage_graph.nodes | length')
EXPECTED_EDGES=$(echo "$RESULT_JSON" | jq '.result.lineage_graph.edges | length')
EXPECTED_EDGES_NORM=$(echo "$RESULT_JSON" \
  | jq -c '[.result.lineage_graph.edges[] | {from:.src, to:.dst}] | sort_by(.from + .to)')

echo "      playground produced $EXPECTED_NODES nodes / $EXPECTED_EDGES edges"

# ── 4. Wait for the control plane to receive the webhook-driven events ─
bold "[4/5] waiting up to ${CP_POLL_TIMEOUT_SECS}s for control-plane to see all events"
LINEAGE=""
for i in $(seq 1 "$CP_POLL_TIMEOUT_SECS"); do
  LINEAGE=$(curl -sS -H "Authorization: Bearer $CP_API_KEY" "$CP_URL/runs/$RUN_ID/lineage" || true)
  CP_NODES=$(echo "$LINEAGE" | jq -r '.nodes | length // 0' 2>/dev/null || echo 0)
  CP_EDGES=$(echo "$LINEAGE" | jq -r '.edges | length // 0' 2>/dev/null || echo 0)
  if [ "$CP_NODES" = "$EXPECTED_NODES" ] && [ "$CP_EDGES" = "$EXPECTED_EDGES" ]; then
    echo "      ✓ control-plane saw $CP_NODES nodes / $CP_EDGES edges after ${i}s"
    break
  fi
  printf "."
  sleep 1
done
echo
if [ "$CP_NODES" != "$EXPECTED_NODES" ] || [ "$CP_EDGES" != "$EXPECTED_EDGES" ]; then
  red "[FAIL] timeout — control-plane never converged"
  red "       expected: $EXPECTED_NODES nodes / $EXPECTED_EDGES edges"
  red "       got:      $CP_NODES nodes / $CP_EDGES edges"
  echo "$LINEAGE" | jq . || echo "$LINEAGE"
  dim "Hint: check 'docker compose -f $COMPOSE_FILE logs control-plane' and"
  dim "     'docker compose -f $COMPOSE_FILE logs registry-a' for webhook failures."
  exit 1
fi

# ── 5. Verify ────────────────────────────────────────────────────────
bold "[5/5] verifying control-plane state"

RUN_FROM_CP=$(curl -sS -H "Authorization: Bearer $CP_API_KEY" "$CP_URL/runs/$RUN_ID")
CP_RUN_ID=$(echo "$RUN_FROM_CP" | jq -r '.runId // empty')
CP_RUN_COUNT=$(echo "$RUN_FROM_CP" | jq -r '.contextsCount // 0')
if [ "$CP_RUN_ID" != "$RUN_ID" ]; then
  red "[FAIL] GET /runs/$RUN_ID returned: $RUN_FROM_CP"
  exit 1
fi
echo "      ✓ run row exists  contextsCount=$CP_RUN_COUNT"

CP_EDGES_NORM=$(echo "$LINEAGE" | jq -c '[.edges[]] | sort_by(.from + .to)')
if [ "$EXPECTED_EDGES_NORM" != "$CP_EDGES_NORM" ]; then
  red "[FAIL] edge set mismatch"
  echo "      playground: $EXPECTED_EDGES_NORM"
  echo "      cp:         $CP_EDGES_NORM"
  exit 1
fi
echo "      ✓ edge set identical"

green ""
green "============================================================"
green "  E2E PASSED — full webhook path exercised:"
green "    LLM ($LLM_PROVIDER) → agents → registry-a → playground"
green "    → /webhooks/acdp → forward_webhook → control-plane"
green "    → /ingest/acdp → context_events + lineage_edges + SSE."
green "  Control plane reconstructed $CP_NODES nodes / $CP_EDGES edges."
green "============================================================"
