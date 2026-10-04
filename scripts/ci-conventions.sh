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
# 6. No `Acdp<Something> as unknown as <local type>` — the SDK-surface shim hole;
#    full rationale in the comment block immediately above the check itself.
# 7. No `new NotFoundException(` / `new ForbiddenException(` — every 403/404 is
#    an explicit AppException with a specific ErrorCode (issue #182), so a
#    client can tell "admin required" from "tenant mismatch" from "policy".
#    No file exemptions: a ratchet that starts at zero.
# 8. No `new BadGatewayException(` / `new ServiceUnavailableException(` /
#    `new GatewayTimeoutException(`, and no `new HttpException(<x>, 502|503|504)`
#    or `new HttpException(<x>, HttpStatus.BAD_GATEWAY|SERVICE_UNAVAILABLE|
#    GATEWAY_TIMEOUT)` — an unlabelled 502/503/504 falls back to
#    INTERNAL_ERROR, blaming the control plane for an upstream fault (#200).
#    Throw AppException with a specific ErrorCode. Ratchet at zero.
# 9. No template literal with `${…}` as a log MESSAGE — `logger.warn(`x ${y}`)`.
#    Same reason as rule 5: interpolated values are buried in `msg` instead of
#    landing as top-level pino fields. Pass `{ msg: 'static summary', y }`.
#    Interpolation-free template literals and `msg: `…${y}`` inside an object
#    are allowed.
#
# Usage: ci-conventions.sh [SOURCE_DIR]   (SOURCE_DIR defaults to ./src; the
# argument exists so the unit spec can point the script at a scratch tree and
# assert the checks actually fire, rather than writing a violating file into
# src/ mid-test.)
set -u

src_dir="${1:-src}"
# A missing tree would make every grep/perl check "pass" on zero files.
if [ ! -d "$src_dir" ]; then
  echo "✗ source directory '$src_dir' does not exist"
  exit 1
fi

fail=0

check() {
  local name="$1" pattern="$2" exempt="$3"
  local hits
  hits=$(grep -rn "$pattern" "$src_dir" --include='*.ts' | grep -vE "$exempt" || true)
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
# bootstrap.ts and shutdown.ts both explain at length why this call must not come back
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
  find "$src_dir" -name '*.ts' ! -name '*.spec.ts' -print0 |
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

# 6. No `Acdp<Something> as unknown as <local interface>` — the SDK-surface shim
#    hole. `src/audit/{receipt-verify,cosign,log-verify}.ts` each used to declare
#    a hand-written interface describing an `acdp` binding surface and then
#    launder the real `AcdpVerifier` through `as unknown as` to satisfy it. The
#    double cast erases the compiler's knowledge of the binding's ACTUAL
#    signatures, so an SDK API change — `verifyReceipt` gaining a `bodyJson`
#    parameter is the real one — typechecks perfectly and then fails every
#    receipt audit at runtime, indistinguishably from registry misbehaviour.
#    The fix is `Pick<typeof AcdpVerifier, …>`, a widening of the class type
#    that needs no `unknown` and keeps every call site arity-checked against
#    what is installed. Note the DIRECTION: in every violation the SDK type is
#    the LEFT operand and the right-hand side names a local type, so the rule
#    matches on the left. Specs are exempt — they legitimately fabricate
#    binding shapes to exercise the degradation paths.
check "no Acdp* laundered through 'as unknown as' (SDK surface shims)" \
  'Acdp[A-Za-z]* as unknown as' \
  '(\.spec\.ts)'

# 7. Unlabelled 403/404s (#182). The pattern is a BRE (check() runs plain grep,
#    no -E): `\(…\|…\)` groups/alternates and the trailing `(` is literal. The
#    ERE spelling `(NotFound|Forbidden)Exception\(` is a MALFORMED BRE here —
#    grep exits 2, `|| true` swallows it, and the rule would pass forever.
#    src/ci-conventions.spec.ts proves it fires for each class name.
#    Unauthorized/BadRequest stay allowed: their generic fallbacks
#    (UNAUTHORIZED, INVALID_PAYLOAD) are accurate. Comment lines are exempt.
check "no unlabelled NotFound/Forbidden exceptions (see #182)" \
  'new \(NotFound\|Forbidden\)Exception(' \
  '(\.spec\.ts|:[0-9]+: *(//|\*))'

# 8. Unlabelled gateway-family 5xx (#200). Same BRE caveat as rule 7 — the ERE
#    spelling would be a malformed BRE that grep rejects with exit 2 and the
#    rule would pass forever; src/ci-conventions.spec.ts proves it fires for
#    each class name. Comment lines are exempt.
check "no unlabelled BadGateway/ServiceUnavailable/GatewayTimeout exceptions (see #200)" \
  'new \(BadGateway\|ServiceUnavailable\|GatewayTimeout\)Exception(' \
  '(\.spec\.ts|:[0-9]+: *(//|\*))'

# 8b. The same unlabelled 5xx spelled through the generic class:
#    `new HttpException(<body>, 502|503|504)` or `…, HttpStatus.BAD_GATEWAY |
#    SERVICE_UNAVAILABLE | GATEWAY_TIMEOUT)`. Perl, not grep: every
#    HttpException in src/ is prettier-wrapped, so the status sits lines below
#    the `new`; the balanced-paren recursion `(?1)` captures the whole argument
#    list however it is wrapped or nested. `new AppException(…, HttpStatus.
#    BAD_GATEWAY)` is NOT matched (it carries a specific ErrorCode), nor are
#    non-gateway statuses (429, 403) or `5020`. A match whose line starts with
#    `//` or ` *` is a comment and skipped; *.spec.ts is excluded.
#    Unlike grep-with-`|| true`, a perl compile/runtime error FAILS the rule
#    (xargs exits non-zero) instead of passing it silently.
#    Known limits (ASSUMPTIONS.md): a status in a variable, `super(x, 502)` in
#    an HttpException subclass, unbalanced parens inside a string argument.
gateway_hits=$(
  find "$src_dir" -name '*.ts' ! -name '*.spec.ts' -print0 |
    xargs -0 perl -0777 -ne '
      while (/new\s+HttpException\s*(\((?:[^()]++|(?1))*\))/g) {
        my ($start, $args) = ($-[0], $1);
        next unless $args =~ /(?<![\w.])50[234](?![\w.])|HttpStatus\.(?:BAD_GATEWAY|SERVICE_UNAVAILABLE|GATEWAY_TIMEOUT)\b/;
        my $bol = rindex($_, "\n", $start - 1) + 1;
        next if substr($_, $bol, $start - $bol) =~ m{^\s*(?://|\*)};
        my $line = (substr($_, 0, $start) =~ tr/\n//) + 1;
        print "$ARGV:$line: new HttpException(…, 502|503|504)\n";
      }
    '
)
gateway_status=$?
if [ "$gateway_status" -ne 0 ]; then
  echo "✗ no unlabelled HttpException(…, 502|503|504) (see #200) — scanner failed (exit $gateway_status)"
  fail=1
elif [ -n "$gateway_hits" ]; then
  echo "✗ no unlabelled HttpException(…, 502|503|504) (see #200) — forbidden occurrences:"
  echo "$gateway_hits"
  fail=1
else
  echo "✓ no unlabelled HttpException(…, 502|503|504) (see #200)"
fi

# 9. Template-literal log messages. Perl (multi-line, like rule 5): the
#    wrapped form `this.logger.warn(\n  `…${x}…`,\n)` is the common one.
#    Receivers: anything ending in `logger`/`Logger` (`this.logger`,
#    `deps.logger`, `logger`), a bare `log` identifier (`log.warn`,
#    `this.log.warn`), and an inline `new Logger('X')` — each also through
#    `?.` / `!.` (`this.logger?.warn` is the form that slipped through once). Only a FIRST
#    argument that is a template literal containing `${` fires; comment lines
#    and *.spec.ts are exempt; a perl failure fails the rule.
#    Known limits (ASSUMPTIONS.md): string concatenation (`'a ' + x`), a
#    pre-built message variable, `String.raw` tags, a comment between `(` and
#    the literal, and other receiver names are not detected.
tpl_hits=$(
  find "$src_dir" -name '*.ts' ! -name '*.spec.ts' -print0 |
    xargs -0 perl -0777 -ne '
      while (/(?:[lL]ogger|(?<![\w\$])log|\bLogger\([^()]*\))[?!]?\.(?:log|warn|error|debug|verbose|fatal)\(\s*`([^`]*)`/g) {
        my ($start, $body) = ($-[0], $1);
        next unless $body =~ /\$\{/;
        my $bol = rindex($_, "\n", $start - 1) + 1;
        next if substr($_, $bol, $start - $bol) =~ m{^\s*(?://|\*)};
        my $line = (substr($_, 0, $start) =~ tr/\n//) + 1;
        print "$ARGV:$line: logger.<level>(`…\${…}…`)\n";
      }
    '
)
tpl_status=$?
if [ "$tpl_status" -ne 0 ]; then
  echo "✗ no template-literal log messages (structured fields instead) — scanner failed (exit $tpl_status)"
  fail=1
elif [ -n "$tpl_hits" ]; then
  echo "✗ no template-literal log messages (structured fields instead) — forbidden occurrences:"
  echo "$tpl_hits"
  fail=1
else
  echo "✓ no template-literal log messages (structured fields instead)"
fi

exit $fail
