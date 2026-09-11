#!/usr/bin/env bash
# Emit-shape regression guard for `npm run build` (RFC: issue #137 Phase 8).
#
# Two failure modes that leave dist/ unusable. Both were REAL regressions
# introduced by Phase 8's tsconfig changes; no other CI step runs
# `npm run build` outside Docker, so nothing else can catch either one.
#
#   1. WRONG LAYOUT. Without `rootDir: "./src"` in tsconfig.build.json, the
#      common source directory becomes the repo root, emit relocates to
#      dist/src/, and dist/main.js -- what `start:prod` and the Dockerfile's
#      CMD execute -- simply is not there. This one FAILS LOUDLY today
#      (TS5011, `nest build` exits 1), so the layout assertions below are
#      defence in depth rather than the primary catch: they also fire if a
#      future config change makes the relocation quiet, or relocates emit
#      for some other reason.
#   2. NO EMIT AT ALL on the second build -- and this one EXITS 0. `rootDir`
#      moves the default .tsbuildinfo out of outDir; nest-cli.json's
#      `deleteOutDir` then wipes dist/ while the build state survives, so tsc
#      concludes it is up to date and emits nothing while reporting success.
#      The FIRST build always looks fine, which is why this script builds
#      TWICE -- a single build structurally cannot catch it. This is the mode
#      the script exists for.
#
# Run from the repo root.
set -euo pipefail

# This script runs `rm -rf dist`; refuse to do that anywhere but the repo root.
cd "$(dirname "$0")/.."
[ -f package.json ] && [ -f tsconfig.build.json ] || {
  echo "refusing to run: not at the repo root" >&2; exit 2; }

fail=0
emitted_count=0
note() { printf '  %s\n' "$1"; }
check() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf 'ok   %s\n' "$desc"
  else
    printf 'FAIL %s\n' "$desc"
    fail=1
  fi
}

# Entrypoints that must exist for `npm run start:prod` and `npm run migrate:prod`.
ENTRYPOINTS=(dist/main.js dist/db/migrate.js)

verify_emit() {
  local label="$1"
  printf '\n--- %s ---\n' "$label"
  for f in "${ENTRYPOINTS[@]}"; do
    check "$label: $f exists" test -f "$f"
  done
  # dist/src/ means rootDir was lost and every runtime path shifted one level.
  if [ -d dist/src ]; then
    printf 'FAIL %s: dist/src/ exists -- rootDir lost, emit relocated\n' "$label"
    note "$(find dist/src -name '*.js' | head -3)"
    fail=1
  else
    printf 'ok   %s: no dist/src/\n' "$label"
  fi
  # `|| true` is load-bearing: when dist/ is absent -- which is EXACTLY the
  # no-emit regression this script exists to catch -- `find` exits 1, pipefail
  # propagates it, and because this is an assignment `set -e` would abort the
  # script here. That would silently skip the remaining checks, including the
  # stray-.tsbuildinfo check that names the root cause, and the final summary.
  local n
  n=$(find dist -name '*.js' 2>/dev/null | wc -l | tr -d ' ' || true)
  n=${n:-0}
  if [ "$n" -lt 100 ]; then
    printf 'FAIL %s: only %s .js files emitted (expected >=100)\n' "$label" "$n"
    fail=1
  else
    printf 'ok   %s: %s .js files emitted\n' "$label" "$n"
  fi
  emitted_count="$n"
}

# A stray root-level .tsbuildinfo survives `rm -rf dist` and would make even
# build 1 emit nothing -- the right verdict for the wrong reason. Clear both.
rm -rf dist
rm -f ./*.tsbuildinfo
npm run build
verify_emit "build 1 (cold)"
cold_count="$emitted_count"

# The load-bearing half: a no-op rebuild must still produce a complete dist/.
npm run build
verify_emit "build 2 (incremental, nothing changed)"
if [ "$emitted_count" -ne "$cold_count" ]; then
  printf 'FAIL build 2 emitted %s .js files, build 1 emitted %s -- must match\n' \
    "$emitted_count" "$cold_count"
  fail=1
else
  printf 'ok   build 1 and build 2 agree (%s .js files)\n' "$cold_count"
fi

# The build state must live inside outDir so it shares dist/'s lifecycle.
stray=$(find . -maxdepth 1 -name '*.tsbuildinfo' 2>/dev/null)
if [ -n "$stray" ]; then
  printf 'FAIL stray .tsbuildinfo at repo root: %s\n' "$stray"
  note 'Set compilerOptions.tsBuildInfoFile inside outDir (see tsconfig.build.json).'
  fail=1
else
  printf 'ok   no stray .tsbuildinfo at repo root\n'
fi

# dist/main.js must actually load -- catches a broken module graph that a
# file-existence check would pass. Nest reaches bootstrap and fails on the
# absent DB; that is success for this check. A missing//corrupt module graph
# raises MODULE_NOT_FOUND or a syntax error instead.
# Bounded in the background rather than run to completion: if a database
# happens to be reachable the process boots and stays up forever.
log=$(mktemp)
node dist/main.js >"$log" 2>&1 &
boot_pid=$!
sleep 12
kill "$boot_pid" 2>/dev/null || true
wait "$boot_pid" 2>/dev/null || true
out=$(cat "$log"); rm -f "$log"
if grep -qE "MODULE_NOT_FOUND|SyntaxError|Cannot find module" <<<"$out"; then
  printf 'FAIL dist/main.js does not load\n'
  note "$(head -5 <<<"$out")"
  fail=1
else
  printf 'ok   dist/main.js loads (module graph intact)\n'
fi

printf '\n'
if [ "$fail" -ne 0 ]; then
  printf 'build emit check: FAILED\n'
  exit 1
fi
printf 'build emit check: passed\n'
