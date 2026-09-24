# Decisions

## 2026-08-28 — Removing the unused `@nestjs/config` dependency (Phase 4, CP-5)
- **Plan:** `plans/wave1-cp-1-4-5-6-7.md`
- **Original assumption:** removing `@nestjs/config@^4.0.0` (declared but zero
  imports anywhere in `src/`) and replacing the broken env-loading with a bare
  `dotenv/config` preload as the first line of `src/main.ts` was safe and the
  strongest long-term fix — see `ASSUMPTIONS.md` for full Assumed/Chose/
  Alternatives/Blast-radius text.
- **Recommendation (Opus, low-blast-radius lane):** confirm as-is. Independent
  re-verification: `grep -rn "@nestjs/config" src/ test/` still zero hits after
  all 5 phases landed; no Docker/CI/docs reference; `dotenv` correctly a direct
  runtime dependency (not dev); `main.ts:1` is the sole `dotenv` reference, no
  duplicate loading; `docs/CONFIGURATION.md` already documents the mechanism
  consistently. Long-term judgment: this repo's own hand-rolled
  `AppConfigService`/`ConfigModule` (`src/config/`) is the established,
  deliberate config pattern (reinforced by the codebase's own convention that
  all `process.env` reads live in `AppConfigService`) — `@nestjs/config` was
  never the intended direction and would collide by name with the local
  `ConfigModule` if ever wired up, and still couldn't reach `main.ts`'s
  pre-`NestFactory` migration path regardless. The dotenv preload is the
  correct permanent mechanism, not a stopgap.
- **Verdict:** Confirmed as-is (human decision, via `/reconcile`).
- **Status:** CONFIRMED.

## 2026-08-30 — CP-5 key rotation status (issue #127)
- **Plan:** `plans/wave1-cp-8-9.md`
- **Question:** issue #127 (filed by an independent two-pass spec-repo audit) flagged
  that Wave 1's CP-5 fix removed the leaked `OPENAI_API_KEY` from `.env`/repo history,
  but removal isn't rotation — no repo-side evidence could confirm the key was actually
  revoked at the provider. This has no defensible code default; only the human who
  holds the provider account can answer it.
- **Asked directly during `/drive` preflight** (not a Fable/Opus recommendation lane —
  this isn't a code judgment call, it's a factual status only the user can confirm).
- **Verdict:** User confirmed the key has been rotated/revoked at the provider.
- **Status:** CONFIRMED. No code change required; CP-5 is closed. `plans/wave1-cp-8-9.md`
  covers only CP-8 and CP-9.

---

## 2026-09-11 — Reconciliation of `plans/dep-migrations-137.md` (issue #137)

Four `UNCONFIRMED` entries, reconciled after the feature merged as `227901d`. Ranked by
blast radius: the `truncateAll` entry first (it issues `TRUNCATE ... CASCADE` over
dynamically discovered tables, so a miss destroys data), the other three are cheap and
reversible. Three were **settled by Opus without escalation**; the destructive one was
analyzed by **Fable**. All four are reopenable from this record.

### 1. Dynamic `pg_tables` truncate discovery — **CONFIRMED**, with a gap closed
- **Decided by:** Fable analysis (destructive operation crossing into "could wipe a real
  database"), accepted by Opus. Not escalated to the user: the analysis found the
  catastrophic case already guarded, so it dropped a tier per the Autonomy ladder rather
  than manufacturing a gate.
- **Assumption:** discovering truncate targets at runtime is safe and strictly better than
  a hardcoded list (which had drifted five tables stale, making the suite non-idempotent).
- **Analysis:** the design is right — the literal list had gone stale twice, and drift in a
  suite gating five phases produces misattributed failures. Going dynamic *did* widen the
  silent-wipe exposure (the old list aborted loudly against a foreign schema), which is
  exactly why `assertTestDatabase` shipped in the same commit (`e07fe6e`) and is
  load-bearing rather than decorative. Net position is stronger than before the change:
  the hardcoded era had **no** guard and would have silently wiped a same-schema
  production database.
- **Gap found:** the entry claimed the guard was "verified by a negative test". It was
  verified **manually, once** — `grep` found zero committed coverage. That matters because
  the guard has a regression history: an earlier revision validated the module's default
  URL while truncating a caller-supplied pool, and wiped a decoy database during phase
  verification.
- **Action taken:** added `test/integration/test-db-guard.integration.spec.ts` (5 tests)
  pinning the refusal, the credential redaction, and that rows survive. Teeth-proved —
  reintroducing the historical URL-vs-connection bug fails 3 of 5, including the
  data-intact assertion. Entry wording corrected.
- **Residual, accepted:** a *foreign* database whose name ends in `_test` still passes.
  Documented in `test/helpers/test-db.ts` and now in `docs/TROUBLESHOOTING.md`. Accepted
  because a `*_test` database is by convention disposable.

### 2. Host port 5433 workaround — **CONFIRMED**, one doc added
- **Decided by:** Opus analysis. Low blast radius; settled without escalation.
- **Verdict:** right call. Moving the published port would have to change
  `docker-compose.test.yml` **and** two lines of `.github/workflows/ci.yml` to work around
  one machine's conflict; `DATABASE_URL` is already first-class in both readers, and
  `git grep 55433` confirms no tracked file encodes the workaround.
- **Gap found:** the *symptom* was undocumented. `docs/TROUBLESHOOTING.md`'s
  `ECONNREFUSED` section offered one cause ("Postgres isn't running"), but a port squatter
  produces a **successful** connect followed by `database "..." does not exist`. Since this
  repo publishes 5433, the collision is structural for anyone running two ACDP-family
  projects.
- **Action taken:** new `docs/TROUBLESHOOTING.md` section covering the squatter symptom,
  the multi-daemon diagnosis, and the `DATABASE_URL` override.

### 3. Deleting `supertest` + `@types/supertest` — **CONFIRMED as-is**
- **Decided by:** Opus analysis. No action needed.
- **Verdict:** the strongest of the four. The analysis tested the four capabilities
  supertest would have bought rather than restating the entry: cookies, redirects and
  multipart have **zero surface** (Bearer/HMAC auth, JSON-only, no `res.redirect` in
  `src/`); SSE — the one real gap — is already served by the purpose-built
  `test/helpers/sse-client.ts`, which supertest could not have replaced anyway since
  superagent buffers to `end`. What remains is `.expect()` sugar that Jest matchers
  already provide, while `TestClient` earns its length on ACDP's `x-acdp-signature` HMAC
  signing.

### 4. Removing `ts-loader` + `tsconfig-paths` — **CONFIRMED**, two corrections
- **Decided by:** Opus analysis. No behavioural change.
- **Verdict:** correct. Traced through the `@nestjs/cli@12` source rather than running a
  destructive build: `loadWebpackDeps()` is the first statement of the webpack defaults
  factory, so `require('webpack')` throws `MODULE_NOT_FOUND` before any config is
  constructed and the action exits 1 — categorically unlike the historical no-emit bug,
  where the compiler ran and wrongly concluded it was up to date.
- **Corrections to the entry:** (a) only **webpack** left the tree —
  `tsconfig-paths@4.2.0` is still installed as a non-optional dependency of
  `@nestjs/cli@12`; removing the devDependency removed the declaration, not the install.
  Verdict unchanged, since no tsconfig declares `paths`. (b) `nest build --webpack`
  **deletes `dist/` before failing**, so "fails loudly" is true but worth stating
  precisely.
- **Note:** the CLI now prints a deprecation notice steering users to rspack, so the
  capability supposedly held in reserve is going away upstream regardless.

**Summary:** 4 confirmed, 0 changed, 0 deferred. 3 settled by Opus without escalation, 1
by Fable analysis that found the catastrophic case already guarded. One code follow-up was
produced and **landed in this same pass** (the guard regression spec); nothing blocks a
future ship.

---

## 2026-09-12 — Logging: structured fields + request correlation (issue #159)

Not a `/reconcile` pass — one design decision made while fixing #159, recorded here
because it sets an internal API shape that later code will copy.

### How a caller passes structured fields to `PinoLogger` — **DECIDED: object-as-message**
- **Decided by:** Opus. Low blast radius: internal logging adapter, no wire contract,
  no schema, reversible in a commit.
- **Options:** (a) an object in the message slot, whose keys pino lifts to top level;
  (b) a new `logStructured(bindings, msg, context)` method on `PinoLogger`;
  (c) inject the raw pino instance into callers that want fields.
- **Chose (a).** `LoggerService` already declares `log(message: any, ...optionalParams)`
  and Nest's `Logger` facade forwards the message **untouched**, appending only its own
  context — verified in `node_modules/@nestjs/common/services/logger.service.js`. So an
  object message reaches the adapter intact through the ordinary
  `new Logger(ClassName.name)` convention, with no new method, no DI change, and no
  second logging path to keep in sync.
- **Why not (b):** a second method is invisible through the `Logger` facade — callers
  hold a `Logger`, not a `PinoLogger`, so they could not reach it without changing how
  every service obtains its logger. That is a much larger diff for the same result.
- **Why not (c):** it breaks the `CLAUDE.md` convention that every class logs through
  `new Logger(ClassName.name)`, and re-introduces a second logging path.
- **Cost if wrong:** a mechanical edit at each call site. Two today.
- **Guarded by:** grep rule 5 in `scripts/ci-conventions.sh` (no `JSON.stringify` into a
  log message), which spans lines because the regression form was a multi-line call.

### Where the correlation `AsyncLocalStorage` lives — **DECIDED: `src/common/correlation.ts`**
- **Decided by:** Opus. Pure code organisation; the middleware re-exports both symbols,
  so no import path changed.
- **Why:** `PinoLogger` must read the store, and `common/` importing `middleware/` would
  drag express and the Nest DI decorators into the logging adapter. Extracting the store
  to a leaf module both layers depend on removes that edge. `CorrelationIdMiddleware`
  remains the only writer.

---

## 2026-09-23 — Lineage cursor TTL promoted to a config knob (Phase 13 assumption)
- **Plan:** `plans/rfc-0014-0015-upgrade.md`
- **Original assumption:** the §7 lineage-walk cursor freshness window is a re-walk
  *cadence* knob, not correctness-affecting, so a hardcoded
  `LINEAGE_CURSOR_TTL_MS = 1h` in `src/audit/revocation-audit.service.ts` was fine;
  the named alternative (`KEY_REVOCATION_LINEAGE_CURSOR_TTL_HOURS` via
  `AppConfigService`) was rejected "only for scope reasons" — Phase 13's `Files` list
  did not include `app-config.service.ts` — see `ASSUMPTIONS.md` for the full text.
- **Recommendation (Opus, low-blast-radius lane):** **CHANGE** — promote it now.
  Independent re-verification of the cadence-not-correctness claim: the constant's
  sole consumer is `findFreshLineageCursor(tenantId, lineageId, registryAuthority,
  ttlMs)`, and that call is reached only *after* `priorFactCount > 0`
  (`revocation-audit.service.ts`), so the "zero facts forces a walk every pass"
  security control genuinely dominates the TTL and no value of it can suppress
  discovery of a lineage's first fact. The assumption is therefore CORRECT — but its
  own stated reason for not exposing the knob (defer to a later phase) expired with
  the plan: this was the last phase, so "confirm as-is" would have silently made a
  scope artifact permanent.
- **Why exposing it is the right shape:** every other audit-timing value in this
  codebase is env-exposed (`RECEIPT_AUDIT_*`, `LOG_WITNESS_*`,
  `LOG_INCLUSION_AUDIT_*`, `KEY_REVOCATION_LOOKBACK_HOURS`); a hardcoded hour inside
  the RFC-ACDP-0014 sweep was the outlier. The knob an operator actually wants here
  is real: RFC-ACDP-0014 §4 revocations are irreversible and §4 tells producers to
  date `compromised_since` conservatively early, so an operator who cares about
  latency-to-discovery of a *superseding* revocation in an already-fact-bearing
  lineage previously had no lever short of a code edit and redeploy.
- **Verdict:** Changed. `KEY_REVOCATION_LINEAGE_CURSOR_TTL_HOURS`, default `1` —
  behaviour byte-identical to the constant when unset, so this is a pure
  capability addition with no migration and no default change. `validate()` rejects
  only **negative** values (the single dangerous direction: a negative TTL makes
  `Date.now() - walkedAt < ttlMs` false-forever inverted, i.e. every stored cursor
  tests as fresh permanently, suppressing all re-walks of fact-bearing lineages) and
  deliberately ACCEPTS `0` as an explicit "ignore cursors, always re-walk" opt-out —
  unlike `KEY_REVOCATION_LOOKBACK_HOURS`, where `0` means "look back nowhere" and is
  rejected. The constant became a `lineageCursorTtlMs(config)` helper so the hours→ms
  conversion stays in one place next to the doc comment explaining the 1h default.
- **Files:** `src/config/app-config.service.ts` (+field, +validation),
  `src/audit/revocation-audit.service.ts` (constant → helper, header comment),
  `src/config/app-config.service.spec.ts`,
  `src/audit/revocation-audit.service.spec.ts` (TTL pass-through + the `0` opt-out),
  `docs/CONFIGURATION.md`, `.env.example`, `CLAUDE.md`.
- **Status:** RESOLVED (CHANGED).

---

## 2026-09-23 — `KEY_REVOCATION_ATTESTED_SCOPE` does not gate persistence (Phase 12 assumption)
- **Plan:** `plans/rfc-0014-0015-upgrade.md`
- **Original assumption:** persistence of a `registry_attested` revocation is gated
  only by `crossCheckRegistryBinding`'s outcome, never by
  `KEY_REVOCATION_ATTESTED_SCOPE` — that knob applies only at Phase 14's
  consumption-time classification. See `ASSUMPTIONS.md` for the full text.
- **Recommendation (Opus, low-blast-radius lane):** CONFIRM, and downgrade the
  stated blast radius from Medium to Low. A persistence-time scope gate would be
  a no-op for `global`/`same_registry` — both ask a question
  `crossCheckRegistryBinding`, and (since the PR3 `same_registry` security fix)
  `filterApplicableRevocations` itself, already answer per-event off the
  authenticated `publisher` field — and pure evidence destruction for `off`,
  which §4/§13 both argue against. Verified every reader of
  `findByFingerprint` (live classification and the Phase 15 fan-out alike)
  funnels through `filterApplicableRevocations` before acting, so an
  unfiltered fact store costs nothing beyond a wasted candidate query.
- **Verdict:** Confirmed as designed (Opus, via `/reconcile`).
- **Status:** CONFIRMED.

---

## 2026-09-23 — Manual `signature.key_id`-vs-`agent_id` DID-binding check (Phase 12 assumption)
- **Plan:** `plans/rfc-0014-0015-upgrade.md`
- **Original assumption:** RFC-ACDP-0014's Phase 12 spec text is silent on
  cross-checking the resolved signer's DID against the revocation body's own
  `agent_id`; the check was added anyway, mirroring the Rust reference
  implementation. See `ASSUMPTIONS.md` for the full text.
- **Recommendation (Opus, low-blast-radius lane):** CONFIRM. Traced the Rust
  reference (`acdp-rs/crates/acdp-verify/src/lib.rs`'s
  `verify_signature_envelope`): this binding check is Step 2, run
  unconditionally before method dispatch — not an optional extra. The `did:key`
  branch here already gets it for free via the SDK's offline verify; removing
  the explicit `did:web` check would make `did:web` signers strictly weaker
  than `did:key` ones, an asymmetry with no protocol basis. The identical
  `stripFragment(key_id) !== expectedDid` guard is standing precedent
  elsewhere in this repo (receipt-audit, checkpoint-witness,
  log-inclusion-audit, cosign, witness-signing).
- **Verdict:** Confirmed as-is (Opus, via `/reconcile`).
- **Status:** CONFIRMED.

---

## 2026-09-23 — Revocation-sweep candidate ordering: oldest-first → newest-first (Phase 12 assumption)
- **Plan:** `plans/rfc-0014-0015-upgrade.md`
- **Original assumption:** a single shared `KEY_REVOCATION_LOOKBACK_HOURS` (720h)
  candidate window, applied uniformly regardless of whether a prior failure was
  permanent or transient, is strictly safer than a narrower per-class window.
  See `ASSUMPTIONS.md` for the full text.
- **Recommendation (Opus, low-blast-radius lane):** CHANGE (ordering only) — the
  single window is confirmed, but its "purely an efficiency" framing missed a
  real asymmetry. Unlike `ReceiptAuditRepository.findUnauditedPublishes` (which
  always writes a verdict row, `status='error'` included, so a bad candidate
  drains from its set), `KeyRevocationRepository.findCandidates` writes nothing
  on `invalid`/`unavailable` — so the original oldest-first `ORDER BY` let a
  one-time backlog of more than `limit` permanently-invalid old candidates form
  a non-draining head-of-line block, silently starving a genuinely new
  revocation for the rest of the 720h window and then losing the fact entirely
  once it aged out — a fail-open outcome for §7 classification, not merely
  wasted work.
- **Verdict:** Changed. `KeyRevocationRepository.findCandidates` now orders
  `desc(contextEvents.createdAt)` (newest-first). A permanently-bad backlog now
  sinks below fresh candidates instead of blocking them forever; starving a
  genuinely old-but-legitimate candidate now requires a sustained flood of
  newer candidates every sweep interval for the rest of its window, not a
  one-time accumulation.
- **Files:** `src/storage/key-revocation.repository.ts` (`orderBy` + doc
  comment), `ASSUMPTIONS.md`.
- **Status:** RESOLVED (CHANGED).

---

## 2026-09-23 — ecdsa-p256 revocation signers: facts corrected, fix deferred (Phase 12 assumption)
- **Plan:** `plans/rfc-0014-0015-upgrade.md`
- **Original assumption:** a did:web P-256 signer fails closed as `unavailable`
  (capability gap), a did:key P-256 signer is rejected as `invalid` at the
  multibase-decode step, and this inconsistency's cheap fix (make both branches
  `unavailable`) was deferred alongside full P-256 support as scope creep. See
  `ASSUMPTIONS.md` for the full original text.
- **Recommendation (Opus, low-blast-radius lane):** CHANGE the entry's facts;
  DEFER the code fix. Independent re-analysis (empirically probing the pinned
  `^0.14.1` SDK binding) found the entry factually wrong in ways that reverse
  its own risk assessment: (1) the P-256 did:key body's signature genuinely
  VERIFIES (`AcdpVerifier.verifyBodyOffline` returns `true`) before being
  rejected for an unrelated reason (the multicodec prefix) — so today's
  `status="invalid"` verdict misreports a cryptographically-proven-genuine
  revocation as malformed/fraudulent, worse than the entry's own "wrong reason
  but safer" framing. (2) The proposed cheap fix — flip did:key P-256 to
  `unavailable` too — is fail-open for Ed25519, not merely imperfect for P-256:
  `unavailable` and `invalid` have opposite consequences in the §7 lineage walk
  (`src/audit/revocation-lineage.ts`) — `unavailable` aborts the ENTIRE walk
  with the cursor unset (Rule 3), while `invalid` drops only that member (Rule
  2) — so one P-256 member anywhere in a mixed-signer lineage would permanently
  block every Ed25519 fact in that same lineage from ever being recorded,
  doubling the surface of a pre-existing, previously-undocumented latent bug
  (the did:web branch already does this) instead of unifying a cosmetic
  inconsistency. (3) `receipt-audit.service.ts` does NOT share "the identical
  gap" — only its did:web branch does; its did:key path never decodes
  multibase and P-256 did:key producers already work there.
- **Verdict:** Do not apply the previously-proposed fix. Real fix specified as
  a follow-up task (not implemented in this pass — it changes fail-open/
  fail-closed semantics of an already-shipped, tested path and deserves its
  own phase + verification gate): add a third lineage-walk `Status` value
  (working name `'unsupported'`) meaning "drop this member, don't abort the
  walk, log at `warn`" — applied to both the did:web algorithm-check branch and
  a new P-256-multicodec-recognizing branch ahead of
  `decodeEd25519Multibase`'s generic rejection, plus a matching metric label.
- **Files:** `ASSUMPTIONS.md` (facts corrected), `src/audit/revocation-audit.service.ts`
  (one comment added at the did:key decode site, pointing future readers at the
  corrected ASSUMPTIONS.md entry before they "fix" this the wrong way).
- **Status:** UNCONFIRMED — facts corrected, resolution deferred to a follow-up
  phase; not a blocker for anything already shipped, since no code changed.

---

## 2026-09-23 — Separate §7 classification metric, not a reuse of Phase 12's (Phase 14 assumption)
- **Plan:** `plans/rfc-0014-0015-upgrade.md`
- **Original assumption:** `acdp_receipt_audit_key_revocation_total{status}` (Phase
  14) is a deliberately new counter, distinct from Phase 12's
  `acdp_key_revocation_checks_total{status,trust_class}`, because the two
  `status` vocabularies describe unrelated questions. See `ASSUMPTIONS.md` for
  the full text.
- **Recommendation (Opus, low-blast-radius lane):** CONFIRM. Both metrics exist
  exactly as described, with genuinely disjoint label vocabularies — a shared
  metric would make `sum by (status)` meaningless and leave `trust_class` absent
  on half the series. Found and fixed one real gap while checking: `docs/ARCHITECTURE.md`'s
  sweep table omitted `acdp_receipt_audit_key_revocation_total{status}` from its
  `Surfaces` cell (present only in prose) — added.
- **Verdict:** Confirmed as-is (Opus, via `/reconcile`).
- **Files:** `docs/ARCHITECTURE.md` (table cell).
- **Status:** CONFIRMED.

---

## 2026-09-23 — Trust-class tie-break on a shared compromise boundary (Phase 14 assumption)
- **Plan:** `plans/rfc-0014-0015-upgrade.md`
- **Original assumption:** when two revocation rows over the same fingerprint tie
  on `compromised_since`, the reported `key_revocation_trust_class` prefers
  `producer_signed` over `registry_attested`. See `ASSUMPTIONS.md` for the full
  text.
- **Recommendation (Opus, low-blast-radius lane):** CONFIRM. `key_revocation_sources`
  is built from every contributing row, not just the tie-break winner, so no
  provenance is lost by the tie-break — only the single-value summary label.
  RFC-ACDP-0014 §6/§7 confirmed genuinely silent on tie-break reporting.
  Preferring `producer_signed` is the fail-closed-leaning choice and is applied
  after `KEY_REVOCATION_ATTESTED_SCOPE` filtering, so it drives no enforcement
  decision.
- **Verdict:** Confirmed as-is (Opus, via `/reconcile`).
- **Status:** CONFIRMED.

---

## 2026-09-23 — Candidate selection on registry-claimed `key_fingerprint` (Phase 15 assumption)
- **Plan:** `plans/rfc-0014-0015-upgrade.md`
- **Original assumption:** `findRevocationAmendmentCandidates` joins on
  `context_events.key_fingerprint` (registry-claimed, not independently
  resolved) — accepted as a permanent limitation rather than fixed, since
  closing it needs a real schema change out of scope for a re-audit phase. See
  `ASSUMPTIONS.md` for the full text.
- **Recommendation (Opus, low-blast-radius lane):** CONFIRM, with two framing
  corrections. This was already a settled decision (accepted, documented in
  three places, nothing awaiting evidence) that should have been marked
  RESOLVED/CONFIRMED alongside its two Phase-15 siblings during Phase 15's own
  gap-closure — simply missed. Corrections: (1) "fixed, non-growing population"
  is only true of pre-0.2.0 rows; a registry that never advertises
  `key_fingerprint` keeps adding to this population indefinitely. (2) The gap is
  RETROACTIVE-only — such an event still classifies correctly at LIVE audit time
  via its independently-resolved `producerFp`; it's unreachable by Phase 15's
  fan-out only if a revocation for its signer surfaces AFTER that live verdict
  already sealed.
- **Verdict:** Confirmed as-is, facts corrected (Opus, via `/reconcile`). Also
  found and closed a related documentation-completeness gap: the sibling
  retention-orphan limitation both docs point readers to ASSUMPTIONS.md for had
  no entry of its own — added as its own entry, "Retention purges
  `context_events` but never `receipt_audits`...".
- **Files:** `ASSUMPTIONS.md` (this entry + the new sibling entry).
- **Status:** CONFIRMED.

---

## 2026-09-23 — Reusing RECEIPT_AUDIT_BATCH_SIZE as the Phase 15 fan-out cap (Phase 15 assumption)
- **Plan:** `plans/rfc-0014-0015-upgrade.md`
- **Original assumption:** `ReceiptAuditService.reauditForFingerprint` reuses
  `RECEIPT_AUDIT_BATCH_SIZE` rather than a dedicated
  `KEY_REVOCATION_REAUDIT_BATCH_SIZE`, reasoning a dedicated knob would be
  unjustified surface area for a rare-by-construction fan-out. See
  `ASSUMPTIONS.md` for the full text.
- **Recommendation (Opus, low-blast-radius lane):** CONFIRM, with one
  correction. Verified `receiptAuditBatchSize` is already validated `>= 1`
  whenever this path can run (`KEY_REVOCATION_CHECK_ENABLED` hard-requires
  `RECEIPT_AUDIT_ENABLED`, so its validation always covers this path too) —
  reuse is the right long-term shape, not merely scope-convenient, since a
  dedicated knob stays purely additive later. The entry's own Alternatives
  clause had the divergence direction backwards: the fan-out does no network
  I/O at all (unlike the live sweep's per-event DID/profile/receipt fetches),
  so it's the cheaper workload — a future dedicated knob would realistically
  need to go HIGHER, not "capped much lower" as originally written. Also
  noted: this batch size bounds work per-fingerprint, not per-sweep — the
  outer loop over `distinctFingerprints()` is itself unbounded, so total
  per-sweep work is `batch × |fingerprints|`, an accepted characteristic
  (revocations are rare by construction) that a dedicated per-fingerprint
  knob wouldn't address anyway.
- **Verdict:** Confirmed as-is, Alternatives direction corrected (Opus, via
  `/reconcile`).
- **Files:** `ASSUMPTIONS.md`.
- **Status:** CONFIRMED.
