#!/usr/bin/env bash
# Convention greps (CLAUDE.md "CI grep rules") — every check must be empty.
#
# 1. No `throw new Error` in request-handler paths: business errors go through
#    AppException + GlobalExceptionFilter. Exempted files throw at BOOT or in
#    internal parsers whose callers catch-and-translate (jwt-codec, acdp-verify,
#    jwks-client, revocation-poller, pinned-keys loader, tenant/domain-pack
#    config parsing). This list is a RATCHET — do not add to it for new code;
#    throw AppException instead.
# 2. No `console.*` — runtime logging is a pino-backed LoggerService via the Nest Logger.
# 3. No `process.env` outside AppConfigService + the documented exemptions.
# 4. No `app.enableShutdownHooks()` — it registers Nest's OWN signal listeners in
#    ADDITION to the handler in src/shutdown.ts, so a single SIGTERM runs every
#    OnModuleDestroy twice; pool.end() then throws "Called end on pool more than
#    once" and the process exits 1 with telemetry unflushed (issue #158). This is
#    a one-line regression that only manifests in production, which is exactly
#    what a grep rule is for. app.close() already runs the destroy AND shutdown
#    hooks on its own.
# 5. No `logger.<level>(JSON.stringify(...))` — PinoLogger takes an OBJECT as the
#    message and lifts its keys to top-level pino fields. Stringifying a payload
#    into the message slot buries every field inside `msg` as an escaped string,
#    so an aggregator cannot index or filter on it without re-parsing each line
#    (issue #159). It looks correct, emits a line, and passes every other check —
#    exactly the class of regression a grep rule catches and review does not.
set -u

fail=0

check() {
  local name="$1" pattern="$2" exempt="$3"
  local hits
  hits=$(grep -rn "$pattern" src --include='*.ts' | grep -vE "$exempt" || true)
  if [ -n "$hits" ]; then
    echo "✗ $name — forbidden occurrences:"
    echo "$hits"
    fail=1
  else
    echo "✓ $name"
  fi
}

check "no throw new Error in handler paths" \
  "throw new Error" \
  '(app-config|migrate|telemetry/telemetry|\.spec\.ts|tenant/tenant-context|auth/jwks-client|auth/pinned-keys\.service|auth/cross-issuer-validator\.service|auth/acdp-verify|auth/jwt-codec|auth/revocation-poller\.service|domain-packs/domain-pack|domain-packs/domain-packs\.module)'

check "no console.* (use Nest Logger)" \
  'console\.' \
  '(migrate|\.spec\.ts)'

check "no process.env outside AppConfigService" \
  'process\.env' \
  '(app-config|main\.ts|telemetry/telemetry\.ts|db/migrate\.ts|\.spec\.ts|auth/pinned-keys\.service|auth/pinned-keys-admin\.controller|auth/auth\.module|domain-packs/domain-packs\.module)'

# The exemption skips COMMENT lines (`// ...` and ` * ...` in a docblock), because
# main.ts and shutdown.ts both explain at length why this call must not come back
# — naming it is the point. An actual statement is never a comment line, so a real
# re-introduction still trips the check.
check "no enableShutdownHooks (see #158)" \
  'enableShutdownHooks' \
  '(\.spec\.ts|:[0-9]+: *(//|\*))'

# Needs to span lines — the form this actually regressed as was
#   this.logger.log(
#     JSON.stringify({ ... }),
#   );
# so a line-based grep would miss it. BSD grep (macOS) has no -P and no
# multiline mode, so this uses perl, which is present on macOS and on the CI
# runners alike. Reports file:line like the greps above.
stringify_hits=$(
  find src -name '*.ts' ! -name '*.spec.ts' -print0 |
    xargs -0 perl -0777 -ne '
      while (/logger\.(?:log|warn|error|debug|verbose)\(\s*JSON\.stringify/gs) {
        my $line = (substr($_, 0, pos($_)) =~ tr/\n//) + 1;
        print "$ARGV:$line: logger.<level>(JSON.stringify(...))\n";
      }
    '
)
if [ -n "$stringify_hits" ]; then
  echo "✗ no JSON.stringify into a log message (see #159) — forbidden occurrences:"
  echo "$stringify_hits"
  fail=1
else
  echo "✓ no JSON.stringify into a log message (see #159)"
fi

exit $fail
