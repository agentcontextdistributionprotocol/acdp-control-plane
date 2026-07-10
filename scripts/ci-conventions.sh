#!/usr/bin/env bash
# Convention greps (CLAUDE.md "CI grep rules") — every check must be empty.
#
# 1. No `throw new Error` in request-handler paths: business errors go through
#    AppException + GlobalExceptionFilter. Exempted files throw at BOOT or in
#    internal parsers whose callers catch-and-translate (jwt-codec, acdp-verify,
#    jwks-client, revocation-poller, pinned-keys loader, tenant/domain-pack
#    config parsing). This list is a RATCHET — do not add to it for new code;
#    throw AppException instead.
# 2. No `console.*` — runtime logging is nestjs-pino via the Nest Logger.
# 3. No `process.env` outside AppConfigService + the documented exemptions.
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

exit $fail
