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

## 2026-09-25 — Revocation lineage walk: third `'unsupported'` status shipped (issue #170)
- **Plan:** `plans/revocation-lineage-p256-status.md`
- **Prior assumption:** the 2026-09-23 entry above deferred the actual fix — a third
  `Status`/`LineageMemberVerdict` value distinguishing "capability gap" from both
  "verification failure" (`invalid`) and "transient/couldn't check" (`unavailable`) — to
  its own phase with its own verification gate, rather than patching it same-day.
- **What shipped:** `/plan` produced `plans/revocation-lineage-p256-status.md` for issue
  #170 (one phase), reviewed by a fresh Opus agent (`REVISE` → 7 findings, all applied —
  see that plan's own "Plan review" section), then implemented via `/implement` and
  verified `PASS` (5 non-blocking findings, all closed) by a second fresh Opus agent.
  Added `Status`/`LineageMemberVerdict` value `'unsupported'`, applied at both sites that
  previously misclassified a P-256 signer: `RevocationAuditService.verifyRevocationBody`'s
  did:web algorithm check (was `'unavailable'`, silently lost after 30 days at
  `debug`-level logging) and a new early return in its did:key branch, keyed off
  `decodeEd25519Multibase`'s extended return shape recognizing the REAL P-256 multicodec
  varint prefix `0x80 0x24` (not the raw multicodec code `0x1200` — confirmed empirically
  by minting a real `AcdpP256Producer` did:key and base58-decoding it by hand; the
  existing `multibase.spec.ts` fixture had used the wrong bytes and is now corrected).
  The did:key path now preserves the fact that `AcdpVerifier.verifyBodyOffline` already
  proved the signature genuine — the prior `'invalid'` verdict actively misreported a
  cryptographically-proven-genuine revocation as malformed. Both `sweep()`'s per-candidate
  loop and `walkRevocationLineage`'s per-member loop now route the three-way `Status`
  through an exhaustive `switch` with a compile-time `never`-guard in `default`
  (`classifyLineageFailure`'s established pattern), whose runtime fallback is fail-closed
  (`continue`, never `throw` — neither file is on `CLAUDE.md`'s `throw new Error`
  exemption list) rather than risking the uncaught `TypeError` an unhandled status would
  otherwise cause (a non-null assertion on a field only `'verified'` populates, which
  would abort the entire sweep pass — a hard availability bug, not a silent security one;
  this was itself a correction the plan-review agent caught in the first draft).
- **Files:** `src/common/multibase.ts`, `src/common/multibase.spec.ts`,
  `src/telemetry/instrumentation.service.ts`, `src/audit/revocation-audit.service.ts`,
  `src/audit/revocation-audit.service.spec.ts`, `src/audit/revocation-lineage.ts`,
  `src/audit/revocation-lineage.spec.ts`, `test/integration/revocation.integration.spec.ts`,
  `ASSUMPTIONS.md` (entry above flipped to CONFIRMED; new low-blast-radius entry logged
  for the deliberately-unextended lineage-walk metric coverage, per the plan's own Open
  Questions), `CLAUDE.md` (one-line doc update).
- **Status:** CONFIRMED (2026-09-25) — shipped, tested (unit + integration against a
  disposable Postgres; full local gate green), and independently verified.

## 2026-09-25 — Lineage-walk member verdicts stay uncounted: rationale corrected, follow-up tracked (Phase 1 assumption, issue #170)
- **Plan:** `plans/revocation-lineage-p256-status.md`
- **Original assumption:** leave `walkRevocationLineage`'s per-member verdicts
  permanently uncounted by any metric — issue #170's own metric ask scopes only to
  the webhook-candidate path (now fully covered), and `revocation-lineage.ts`'s file
  header states the module "stays free of the SDK/DID-resolution machinery... by
  extension of `InstrumentationService`." Framed as low blast radius and "reversible
  any time as a pure metric addition."
- **Recommendation (Opus, low-blast-radius lane, via `/reconcile`):** CHANGE the
  rationale; do not write code in this pass; track a scoped follow-up instead.
  Independent re-analysis found: (1) the "by extension of `InstrumentationService`"
  clause is an unsupported extrapolation — the file-header quote it leans on
  (`revocation-lineage.ts:172-180`) is scoped to SDK/DID-resolution/crypto
  machinery, and `LineageWalkDeps` (`revocation-lineage.ts:187-191`) already
  injects side-effecting dependencies of the same shape a metrics callback would
  need (`federationClient`, `verifyMemberBody`, `logger`). (2) The repo's real,
  narrower convention — metrics incremented only inside `@Injectable()` service
  classes, never a pure helper module — does argue against injecting a counter
  into `walkRevocationLineage` itself, but not against counting member verdicts at
  all: a per-status tally returned on `LineageWalkResult` and incremented by
  `RevocationAuditService.walkAndPersistLineage` (`revocation-audit.service.ts:469-489`,
  which already holds `this.instrumentation`) fits the established pattern cleanly.
  (3) There is a genuine, previously understated signal gap: an `'unsupported'`
  (or `'invalid'`) lineage member is dropped with no fact recorded in
  `key_revocations` — Phase 14/15 boundary-tightening never sees it — and the only
  operator-visible trace is a single `warn` log line from a background sweep,
  unlike every other verification sweep in this repo, which all have a matching
  counter. (4) The "reversible any time" framing holds only for a genuinely NEW
  counter — reusing `acdp_key_revocation_checks_total` with an added label (e.g.
  `stage`) would repeat the exact move the Phase 14 "A separate metric for §7
  classification" entry already rejected for a different pair of paths (conflating
  two status vocabularies under one label domain).
- **Verdict:** Correction applied to the `ASSUMPTIONS.md` entry (rationale fixed,
  the two follow-on facts above added). Code not written in this pass — this is a
  new, small feature (a returned tally + a new counter + tests), not a doc-only
  fix, so it's tracked as its own task rather than folded into a reconcile pass.
  Filed as [issue #173](https://github.com/agentcontextdistributionprotocol/acdp-control-plane/issues/173),
  with the exact proposed shape (new counter name, never a label on the existing
  one) specified in the issue body so a future implementer doesn't have to
  re-derive it.
- **Files:** `ASSUMPTIONS.md`.
- **Status:** NEEDS-CHANGE — not blocking (Low blast radius, nothing currently
  shipping depends on the gap), but the entry's original "confirm as permanently
  uncounted" framing did not hold up under analysis. Resolves when issue #173 ships.

## 2026-09-25 — Lineage-walk member verdicts now counted: issue #173 implemented and verified

- **Plan:** `plans/revocation-lineage-member-metric.md`.
- **Original assumption entry:** "Lineage-walk member verdicts stay uncounted by
  any metric" (above, corrected 2026-09-25) — tracked as follow-up issue #173,
  `Status: NEEDS-CHANGE`, "Resolves when issue #173 ships."
- **What shipped:** `LineageWalkOutcome` gains a `memberVerdictCounts` tally,
  non-optional on both the `ok: true` and `ok: false` branches — accumulated
  once per member ahead of the routing `switch` in `walkRevocationLineage`
  (`src/audit/revocation-lineage.ts`), so a Rule-3 `'unavailable'` abort never
  discards tallies already computed for earlier members in the same call. A new
  counter, `acdp_key_revocation_lineage_members_total{status}`
  (`src/telemetry/instrumentation.service.ts`) — a genuinely new Counter, never
  a reused label on `acdp_key_revocation_checks_total` — is incremented by
  `RevocationAuditService.walkAndPersistLineage` from that tally, placed ahead
  of the `if (!result.ok)` early return so a partial tally survives an aborted
  walk.
- **Verification:** plan review round 1 (REVISE, factual corrections applied —
  a wrong integration-test expected tally, a needed delta-based assertion, a
  self-contradicting docs justification, corrected line citations). Implementation
  verification: 3 rounds (round 1 GAPS — 3 test-coverage gaps, no runtime
  defects: AC10 lineage-dedup untested, AC7's `?? 0`-guard test didn't actually
  exercise the guard, AC4's all-zero pre-loop-failure tally had no assertion;
  round 2 GAPS — AC7/AC4 fixes confirmed closed, but the AC10 fix was a false
  proof caught by the reviewer mutation-testing the dedup key; round 3 PASS,
  the AC10 fix re-verified with a genuinely mutation-distinguishing two-member
  lineage stub). Full local gate green throughout: both tsconfigs, lint,
  conventions, unit suite (1124 passed), integration suite (212 passed,
  including a real prom-client delta assertion on the new counter).
- **Files:** `src/audit/revocation-lineage.ts`, `src/audit/revocation-lineage.spec.ts`,
  `src/telemetry/instrumentation.service.ts`, `src/audit/revocation-audit.service.ts`,
  `src/audit/revocation-audit.service.spec.ts`, `test/integration/revocation.integration.spec.ts`,
  `docs/ARCHITECTURE.md`, `CLAUDE.md` (gitignored, local-only).
- **Status:** CONFIRMED (2026-09-25) — the originating `ASSUMPTIONS.md` entry
  flipped from `NEEDS-CHANGE` to `CONFIRMED` in the same pass. No new
  `ASSUMPTIONS.md` entries logged — the plan's one Open Question (tally on both
  outcome branches) was decided directly by Opus in the plan itself.

## Reconcile: plans #182 (error codes), #156 Phase 1 (bundler), #155 (NestJS 12) — 2026-10-03
Scope: the 18 `UNCONFIRMED` `ASSUMPTIONS.md` entries tagged to those three plans.
Analysis: Fable for the two genuine one-way doors; one Opus agent for the other 13;
four were pre-decided by the user.

### Decided by the user (after Fable analysis) — both CONFIRMED
- **Generic 4xx fallback codes are CP-local SCREAMING_SNAKE names.** Fable: confirm.
  The registry's vocabulary is lowercase snake_case by mandate (RFC-ACDP-0007 §5.1),
  and the console reads `errorCode`/`error.code` into one field with an exact lookup
  across both vocabularies, so upper-case is what keeps the sets disjoint; console
  tests already key on `FORBIDDEN`/`NOT_FOUND`, so a rename is breaking. Wording fix:
  alignment is to HTTP reason phrases (RFC 403 is `not_authorized`; CP chose
  `FORBIDDEN` deliberately so the generic 403 does not inherit registry semantics).
- **Ingest enrollment codes answered before HMAC.** Fable: confirm. The same 403s with
  the same messages were returned pre-#182 before HMAC, so the codes add no
  information; the bounded leak is the enabled/enrolled state of a NAMED authority
  (no tenant, no secret). Deferring the throws until after HMAC would make
  `REGISTRY_NOT_ENROLLED` effectively unreachable (an unenrolled authority has no
  per-registry secret). Correction to the entry: "verify HMAC first" is ~10 lines,
  not a redesign — it is rejected on the merits, not on cost.

### Decided by the user earlier (recorded)
`REQUEST_REJECTED` as the generic-4xx name; reserved-tenant stays 403 (registry
returns 400); `engines.node >=24.15` (supersedes the older "no engines field" entry);
TS 7 typecheck gate (#156 Phase 2) deferred — still `UNCONFIRMED`/deferred; note
TypeScript 7.0.2 is now `latest`, so the gate is cheaper and worth revisiting.

### Settled by Opus (reversible) — 12 CONFIRMED, 1 NEEDS-CHANGE
CONFIRMED: http-errors exposed-4xx passthrough (`exception.filter.ts:134-150`);
revoke 403 generic `FORBIDDEN` (admin-OR-self, `revoke.controller.ts:165-169`);
`assertAdmin` takes the full message (6 call sites); `POLICY_DENIED` shared by deny
and indeterminate (additive to split later); policy/quota bodies labelled in place
(moving to `AppException` would break the legacy shape); CI rule 7 scoped to
403/404; `moduleResolution: bundler` (`tsconfig.json:3,21`); throttler 6.7.x
behaviour-neutral (IPv6 gap tracked as #187); keep `import 'dotenv/config'`
(stands or falls with bundler); Jest `--experimental-vm-modules` kept (tracking issue
#201 to drop it when Jest supports it natively); four resource-owning destroy hooks
only feed the exit-code collector (guard comment added in `src/shutdown-failures.ts`:
any new resource-owning hook must call `track()`); ExperimentalWarning noise kept
visible (a blanket `--disable-warning` would hide unrelated warnings).
NEEDS-CHANGE (non-blocking, reversible): federation proxy 502 reports
`INTERNAL_ERROR` (`contexts.controller.ts:92`) — follow-up #200.

### Summary
12 confirmed by Opus + 2 by the user (this pass) + 2 pre-decided by the user
(reserved-tenant 403, engines) + `REQUEST_REJECTED` folded into the generic-code entry;
1 NEEDS-CHANGE (#200, not a ship blocker); 1 deferred (TS 7 gate). 12 of 18 were settled
without the user's input. Code follow-up: the one-line guard comment in
`src/shutdown-failures.ts` (PR below).

## Reconcile: #187, #200, TRUST_PROXY/lint follow-ups — 2026-10-04
Scope: the 11 `UNCONFIRMED` `ASSUMPTIONS.md` entries from #187 (IPv6 throttle
bucketing), #200 (federation 502 label), and their follow-ups (#204–#207:
`TRUST_PROXY`, issuance-ledger `signer_ip`, CI rules 8b/9). Analysis: Fable for the
three one-way doors (wire error code, proxy trust, ledger audit field); Opus for the
other 8.

### Decided by the user (after Fable analysis) — 3 CONFIRMED
- **The upstream-failure 502 is named `FEDERATION_UPSTREAM_ERROR`.** Fable: confirm.
  RFC-ACDP-0007 §5 itself collapses these causes (unreachable, SSRF-blocked, oversize,
  bad upstream status) into one 502 `cross_registry_resolution_failed`, so one CP code
  is the faithful mapping; the `FEDERATION_UPSTREAM_` family prefix matches the
  existing `FEDERATION_UPSTREAM_RATE_LIMITED`; finer-grained codes can be added later
  without breaking clients. Follow-up: the console's copy entry for the new code is a
  sibling-repo change — acdp-ui-console #157.
- **`TRUST_PROXY` is opt-in, strict, and rejects `true`.** Fable: confirm. Express
  5.2.1 `compileTrust` semantics verified (hop count / address list / boolean);
  default-off equals Express's own default, so unset is behaviour-neutral. Hardening
  shipped with this reconcile: the `isIP` guard on the ledger (next entry). Docs:
  `docs/CONFIGURATION.md` now covers the Docker Desktop / `userland-proxy` case
  (published-port peers appear as the bridge gateway, inside `uniquelocal`, so
  `uniquelocal` is a bypass case too, not only hop counts) and that a hop over-count
  makes `req.ip` arbitrary client text (neutralised for the ledger, still affects
  throttle bucketing).
- **Issuance-ledger `signer_ip` is `req.ip`, never raw `X-Forwarded-For`.** Fable:
  confirm, with one REQUIRED change — under a misconfigured `TRUST_PROXY` (hop
  over-count, or a proxy forwarding XFF verbatim) Express returns an untrusted XFF
  entry as `req.ip`, which could exceed `varchar(64)` and 500 `/auth/token`.
  Shipped: `extractIp` returns `req.ip` only when it is ≤ 64 chars AND `isIP(req.ip)`
  (`src/auth/auth.controller.ts`; the length cap is needed because `isIP` accepts an
  IPv6 zone id of any length — caught by the verifier); the spec's overflow case now sets the 100-char text
  as `req.ip` itself and was mutation-checked (fails without the guard).

### Settled by Opus (reversible) — 8 CONFIRMED
IPv6 throttle tracker collapses to `/64` by default; `normalizeIp` reused from
`@nestjs/throttler` (no hand-rolled copy); unlabelled 5xx keeps `INTERNAL_ERROR` (no
generic gateway fallback); request logs still carry no client address; CI rule 8b
uses perl (present on ubuntu-latest and macOS — the "scanner failed" branch is now
proven by `src/ci-conventions.spec.ts` with perl absent from `PATH` and with a failing
stub); template-literal log messages converted + CI rule 9 (known minor false
negative: a nested backtick inside `${}` ends the `[^`]*` match early — accepted,
since a rule-9 hit fails CI and false positives surface immediately); federation fetch
cause stays in the log, not on the wire (nit, left as is: the message says
"unreachable" even for SSRF/oversize causes).
- **Prefix knob range is `[1, 128]`, fail-fast in every environment.** CONFIRMED with
  one change shipped: a SET `THROTTLE_IPV6_SUBNET_PREFIX` that is not a plain decimal
  integer (`/48`, `sixty-four`, `0x40`, `1e2`, empty) now also fails startup instead
  of silently becoming `64` (`readStrictInteger` in `src/config/app-config.service.ts`); unset still defaults
  to `64`.

### Follow-ups
- Possible, NOT done: a once-per-process warning when `X-Forwarded-For` arrives while
  `TRUST_PROXY` is off (would flag a proxied deployment that forgot the setting).
- Console copy entry for `FEDERATION_UPSTREAM_ERROR` → acdp-ui-console #157.

### Summary
11 confirmed: 3 by the user after Fable analysis, 8 by Opus. Two required code changes
shipped in this reconcile's PR (ledger `isIP` guard; non-numeric prefix fails fast),
plus docs and a scanner-failure test for CI rule 8b.

## 2026-10-04 — #193 `.env` loader (Opus)
Replaced `dotenv` with `src/env-file.ts` (`util.parseEnv`, BOM strip, ENOENT-only tolerance, explicit env-wins merge) behind `src/load-env.ts`; supersedes the #155 'keep import dotenv/config' assumption. Rejected bare `process.loadEnvFile` (EACCES reported as ENOENT, BOM corrupts first key, undocumented no-override). Behaviour change: unreadable `.env` fails boot; `KEY: value` and `DOTENV_*` unsupported. Status: UNCONFIRMED in ASSUMPTIONS.md pending /reconcile.

## Reconcile (reversible tier): #192, #210, #191 — 2026-10-04
Scope: the 14 reversible `UNCONFIRMED` `ASSUMPTIONS.md` entries from #192 (graceful
drain), #210 (readiness/liveness) and #191 (Jest without `--experimental-vm-modules`).
Each was re-checked against the code at `main` fbd3ffa. The 8 one-way-door entries
(#193 `.env` loader, SSE `retry:` default, shutdown summary/forced-count semantics,
drain-knob validation, `/readyz` drain headers, `SHUTDOWN_DRAIN_DELAY_MS` bounds,
`/healthz` staleness contract, report-only check shape) are left to the separate
Fable analysis and the user. Status: all 14 CONFIRMED (2026-10-04), decided by Opus.
No code changed; one code follow-up found.

### 2026-10-04 — `DrainState` lives in a sibling global module (#192) — decided by Opus
Reasoning: `src/shutdown-drain.ts:160-165`, imported right after `ShutdownFailuresModule`
(`src/app.module.ts:81`). One concern per module; both are hook-free, so both outlive
`close()`. Folding it into `ShutdownFailuresModule` would buy nothing. Verdict: CONFIRMED.

### 2026-10-04 — Idle-socket reaper: injectable interval, absent probe = never reap (#192) — decided by Opus
Reasoning: `src/shutdown.ts:265-294`. Gating on `listenerClosed` is the only safe reading,
because `closeIdleConnections()` would reset new connections while the listener is open.
A throwing `beginDrain` must not make the exit code 1: the hub's `destroy()` backstop still
ends the streams, and exit 1 means a resource teardown failed. The entry was inaccurate in
one point. A throwing reaper tick is not swallowed silently; it is logged once
(`src/shutdown.ts:280-290`). That is the stronger behaviour, so the entry text was corrected
rather than the code. Verdict: CONFIRMED (entry text corrected).

### 2026-10-04 — SSE helper metrics and backstop semantics (#192) — decided by Opus
Reasoning: `src/events/sse-drain.ts:64-110`. `terminated_total{reason="shutdown"}` reads as
"shutdown events written", and that includes reconnects into the drain window. This is
honest, and the metric is best-effort on a dying process. The redundant `isDraining()` early
return is kept: it states the "never touch the hub after teardown" invariant explicitly, at
no cost. Verdict: CONFIRMED.

### 2026-10-04 — Drain gate reads the path from `req.originalUrl` (#192) — decided by Opus
Reasoning: `src/middleware/drain-gate.middleware.ts:26-36`. Inside `forRoutes('*')`
middleware, `originalUrl` is the only path Express has not rewritten (measured: `req.path`
is `/`). The case-insensitive, optional-trailing-slash match mirrors Express 5's default
routing, so the exemption covers exactly what reaches the SSE controllers. Verdict: CONFIRMED.

### 2026-10-04 — Drain gate side effects precede the throw (#192) — decided by Opus
Reasoning: `src/middleware/drain-gate.middleware.ts:89-101`. The gate sets headers, then
throws for `GlobalExceptionFilter`. That is the established pattern (the `/readyz` drain arm
does the same) and it is asserted end to end. The CLAUDE.md env-var gap the entry left to
the user is closed: CLAUDE.md now lists all four drain knobs. Verdict: CONFIRMED.

### 2026-10-04 — Drain delay: phase model, wiring and log fields (#192) — decided by Opus
Reasoning: `src/shutdown-drain.ts:54-76`, `src/shutdown.ts:221-263`. The phases are monotone
(`serving` → `draining` → `closing`). With a delay of 0 the handler is exactly the Phase 2
path. The gate decides from the arrival stamp, not the live phase, which stops it from
rejecting a POST whose headers arrived before the close. Verdict: CONFIRMED.

### 2026-10-04 — Readiness late-settle semantics (#210) — decided by Opus
Reasoning: `src/health/readiness.service.ts:192-282`. A late success refreshes the cache and
the gauge but is not counted twice, so one probe means one counter increment and the gauge
tracks the truth. A late failure only re-labels an existing "down", so ignoring it is
correct. The sequence guard cannot be reached under single-flight. It stays as a defence in
case single-flight is ever relaxed. Verdict: CONFIRMED.

### 2026-10-04 — `/readyz` `Cache-Control: no-store` before the drain check (#210) — decided by Opus
Reasoning: `src/health/health.controller.ts:91` is the first line of `readyz()`, so all three
arms carry it. The interim `/healthz` gap is closed: Phase 2 shipped `no-store` there (line
56). Verdict: CONFIRMED.

### 2026-10-04 — Probe log demotion threshold and path matching (#210) — decided by Opus
Reasoning: `src/middleware/request-logger.middleware.ts:51-60`. Successful probes log at
`debug` because probes are now unthrottled. The exact-path, case-sensitive match errs toward
visibility: an odd-cased or trailing-slash probe stays at `info`, and a failure is never
hidden. Metrics are untouched. Verdict: CONFIRMED.

### 2026-10-04 — Pool-error counter lands with Phase 2 (#210) — decided by Opus
Reasoning: this was phase sequencing only. Phase 2 has landed the listener
(`src/health/readiness.service.ts:114`) and removed the latch. Verdict: CONFIRMED (moot).

### 2026-10-04 — Integration criteria through an in-process TCP fault proxy (#210) — decided by Opus
Reasoning: test-only. `test/helpers/pg-fault-proxy.ts` maps `localhost` to `127.0.0.1`, and
the multi-wave pool-client bound is stronger than a single burst. The "black-holed
`/healthz` hangs" carve-out is closed by Phase 2's case
(`test/integration/readiness.integration.spec.ts:175`). Verdict: CONFIRMED.

### 2026-10-04 — Redis stream hub teardown disconnects a client that is not ready (#210) — decided by Opus
Reasoning: `src/events/redis-stream-hub.strategy.ts:149-160`. Sending `quit()` only to a
`ready` client and calling `disconnect()` on any other is correct. A `QUIT` queued behind
ioredis's reconnect loop never completes. Verdict: CONFIRMED, with a code FOLLOW-UP:
`RedisQuotaStore.close()` (`src/quota/quota-store.ts:108-117`) still awaits an unconditional
`quit()`. `QuotaModule.onModuleDestroy` awaits it, so with Redis down at shutdown,
`app.close()` stalls until `SHUTDOWN_TIMEOUT_MS`, the close is forced and the exit code is
1. This is the same hazard, worse because it is awaited.
`test/integration/quota-store-lifecycle.integration.spec.ts:131-158` already works around it
in the spec's own cleanup. Apply the same `ready` → `quit()`, else `disconnect()` rule there.

### 2026-10-04 — Integration modelling for Phases 2-3 (#210) — decided by Opus
Reasoning: test-only. The 2 s client-side race turns a hang into an assertion. Recovery is
measured with `/healthz`-only polling, which proves the background refresh drives it. The
freed-port "Redis stopped" case never stops the shared Redis. Verdict: CONFIRMED.

### 2026-10-04 — Jest down-compiles `@nestjs/*` via `@swc/jest` (#191) — decided by Opus
Reasoning: the divergence from production is test-only and covered by `check:build`
(it boots `dist/main.js`), the spawned-process shutdown integration spec, and the
`src/test-harness.spec.ts` tripwire. Reversal is a config change. The plan's own condition
still applies: C was chosen as the first step to Option D (swc for project TS, which removes
ts-jest's `typescript <7` peer). Verdict: CONFIRMED, with a re-evaluation trigger. When #156
Phase 3 is planned, decide Option D there; if D is rejected, revisit C against the flag.

### Follow-ups
- Code: `RedisQuotaStore.close()` should `quit()` only a `ready` client and
  `disconnect()` any other (see the Redis teardown entry). This is a small change plus a unit
  spec, and is not implemented here.
- Process: re-evaluate #191 Variant C when #156 Phase 3 decides Option D.

### Summary
14 reversible entries confirmed by Opus. One entry's text was corrected (the reaper logs
once and does not swallow). 0 escalated. 1 code follow-up. The 8 one-way-door entries are
untouched and await the user.

## 2026-10-04 — /reconcile (#193/#192/#210 one-way-door tier) — decided by the user, analysed by Fable
- **Error codes `SERVICE_DRAINING` / `DEPENDENCY_UNAVAILABLE` (public ErrorCode):** CONFIRMED. Two codes (different remedy and retry contract), CP-local SCREAMING_SNAKE (RFC-ACDP-0007 §5 has no 503 code). Rename later = breaking; splitting finer = additive.
- **Probe contract:** CONFIRMED. /readyz 200→503 with the standard envelope, legacy ok/database keys under error.details; /healthz stays 200 with `ok` mirroring the last readiness verdict (true before first probe). Optional additive `checks.database.required:true` DEFERRED.
- **Env knobs:** CONFIRMED (SHUTDOWN_TIMEOUT_MS strict 1000-2147483647, SHUTDOWN_RETRY_AFTER_SECONDS, STREAM_SSE_SHUTDOWN_RETRY_MS, SHUTDOWN_DRAIN_DELAY_MS default 0, READINESS_DB_TIMEOUT_MS 1000, READINESS_CACHE_MS 1000, DB_POOL_CONNECTION_TIMEOUT > 0). CHANGE: DB_POOL_CONNECTION_TIMEOUT moves from lenient readNumber to the strict integer parser (tightening later would be the breaking direction).
- **SSE wire event:** CONFIRMED `event: shutdown` data {reason:'server_shutdown'} + `retry:`.
- **#193 .env loader:** CONFIRMED (unreadable .env fails boot; `KEY: value` and DOTENV_* dropped). CHANGE: EISDIR error names the Docker bind-mount-of-missing-file cause.
- **Shutdown logs and drain details:** CONFIRMED and FROZEN: `graceful close timed out — forcing shutdown`, `shutdown drain complete`, the 25 s budget warning, drain 503 headers, 1000 ms retry default.
- **Follow-up code tasks (this branch):** DB_POOL_CONNECTION_TIMEOUT strict parse; EISDIR hint; RedisQuotaStore.close() quit-only-if-ready (Opus-tier follow-up from the same reconcile).
- **Follow-ups implemented (this branch, uncommitted):** DB_POOL_CONNECTION_TIMEOUT now uses `readStrictInteger` (`5s`/`1.5`/empty fail startup; unset = 5000); `.env` EISDIR error names the Docker bind-mount cause (`src/env-file.ts`, code/syscall kept); `RedisQuotaStore.close()` quits only a `ready` client, else `disconnect()` (lifecycle spec's bounded cleanup kept as a regression backstop).

## 2026-10-05 — /reconcile (#221: strict Ed25519, bearer_jwt) — reversible tier decided by Opus
- **`/auth/token` key_id ↔ agent_id binding:** CONFIRMED. Exact DID-portion equality on both the pinned and did:web paths; bare fragments stay accepted (safe: expanded to `<agent_id>#frag`, documented in docs/API.md:724 and docs/AUTH.md; the registry is stricter, a lenience not a hole); `#frag` rejected as malformed (registry parity); a did:key agent sending `key_id == agent_id` now gets 401 (registry rejects the same). No in-repo or playground client broken. Not checked: acdp-ui-console code for `/auth/token` callers (a search found no mentions). Deferred: registry's did:key fragment == own-identifier check (pinned path only, low value).
- **Follow-ups (not implemented):** (1) add `@MaxLength` (~2048) to `key_id`, `agent_id`, `nonce`, `signature` in `src/auth/dto/auth.dto.ts` — the values land unbounded in the ledger detail and the minted `acdp.key_id` (pre-existing); (2) optional, separate decision: stamp the expanded `keyUrl` instead of the raw `key_id` in the claim (changes docs/AUTH.md:117 and a spec assertion).
- **D2 EdDSA JWT verify via SDK:** CONFIRMED (alg allow-list before path selection, 64-byte length check, strict §5.10 via the SDK, JWKS admits OKP/Ed25519 only).
- **D4 don't advertise `bearer_jwt`:** CONFIRMED (read_authentication_methods is a registry capabilities field; the CP serves no acdp.json).
- **D5 TLS-only as a deployment doc:** CONFIRMED (parity with the registry's own docs; req.protocol is only meaningful under TRUST_PROXY).
- **D6 `exp` required for local and trusted tokens:** CONFIRMED (registry itself requires exp/iss/aud and always mints exp; per-call `requireExp:false` opt-out exists).
- **Side finding (follow-up):** `AuthGuard.extractScopes` reads `scope`/`scopes`, while trusted-issuer `requiredScope` checks `scp` — a vocabulary mismatch; and `requiredScope` is unusable against registry peers (the registry mints no scope claim).
- **D3 (trusted registry tokens with `aud` = the registry stay accepted):** CONFIRMED by the user (2026-10-05) on Fable's analysis, with a hardening plan. Behaviour unchanged (changing it breaks every federation; against the issuer-trust threat `aud` only protects against leak/replay by third parties). Fable's finding: the recorded mitigations were overstated — per-issuer `audience` is a selector, `requiredScope` can't work against registry peers (no scope claim minted), registry revocations never reach the CP — and the concrete blast radius includes `POST /webhooks` exfiltration. Decision: **keep + opt-in per-issuer `read_only` flag** (default off = no behaviour change; default-on rejected since it breaks federations creating webhooks via registry tokens) and `iss` threaded into `PolicyRequest` — tracked in acdp-control-plane#225. docs/AUTH.md corrected. Re-evaluation trigger: when the registry ships multi-audience minting (then set per-issuer `audience` to the CP authority). Cross-repo asks filed as issues (no edits there): acdp-registry-rs#420 (multi-audience `aud`), #421 (`/auth/revocations` feed).

## 2026-10-06 — #225 open decisions A/B (critical tier) — analysed by Fable, settled by convention (no user input needed)
- **A. Error code for the read_only denial:** new `ErrorCode.ISSUER_READ_ONLY` (403). CLAUDE.md requires every 403 to carry a specific code (reusing `FORBIDDEN` is the #182 anti-pattern); naming follows the `<SUBJECT>_<STATE>` convention (`REGISTRY_DISABLED`, `ADMIN_REQUIRED`); nothing in RFC-ACDP-0007 §5 to reuse (CP codes are CP-local). Pinned by error-codes.spec.ts + docs/API.md row.
- **B. Env grammar:** `TRUSTED_ISSUERS` entry `iss|alg|material|audience[|scope[|flags]]`; `flags` is a closed-vocabulary, whitespace-split token set `{read_only}` (case-sensitive; unknown/duplicate tokens fail boot). Tightenings: reject >6 fields (extras were silently dropped), reject `read_only` in the scope slot (positional footgun — hint `|aud||read_only`), never echo the entry in parse errors (HS256 secret leak at trusted-issuers.ts:69/:113). Rollback hazard (older build silently ignores the field) is documented, not a design input. Rejected: key=value options, separate TRUSTED_ISSUERS_READ_ONLY var.
- **POST /auth/introspect under read_only:** decided by Opus — EXEMPT (RFC 7662 mandates POST; it is read-shaped); `POST /auth/token/revoke` stays denied (a write). Covered by tests.


## 2026-10-06 — #225 close-out (Phases 1–5) — decided by Opus
- **Issuer provenance (Phase 3):** `AuthGuard` tags `actorIssuer` / `actorFederated` from the validator's returned trust entry (`verifyWithProvenance`), never from claims; `PolicyRequest.issuer/federated` and the OPA input carry them; the policy cache key includes both. No allow/deny change; the static decider ignores them. No active Rego rule shipped (commented example only).
- **iss == JWT_AUTHORITY (Phase 4 gap):** a `TRUSTED_ISSUERS` entry whose `iss` equals `JWT_AUTHORITY` now fails boot (the validator checks local first, so the entry — including `read_only` — would be silently shadowed).
- **keyUrl stamping (optional item):** NOT done — no consumer; revisit only with a concrete need.
- **Narrowed claim:** "OPA can express the same rule" for federated writes holds only for `@CheckPolicy` routes (7 handlers); `POST /webhooks` is not one, so the per-issuer `read_only` flag is the control for CP-local writes. docs/POLICY.md and docs/AUTH.md say so.
- **Parser hardening (Phase 4 verifier):** no TRUSTED_ISSUERS parse error echoes any field value other than `iss` (secret can sit in any slot of a mis-written entry).
- **Open (filed separately, not part of #225):** `POST /auth/token/revoke` authorizes on an unverified-decode `sub`; recommend its own security issue.

- **Scope vocabulary (plan Decision C):** one union of `scope`/`scopes`/`scp` (order-preserving, deduped) via `src/auth/scopes.ts`, used by the guard (policy input) and the trusted-issuer `requiredScope` gate. Decided by Opus; the assumption stays UNCONFIRMED in ASSUMPTIONS.md for the end-of-plan `/reconcile`.
- **Auth DTO caps (plan Decision D):** `@MaxLength` 2048 on agent_id/key_id/nonce/signature, 64 on algorithm, 8192 on bearer `token` (revoke/introspect); shipped in PR #227.

## 2026-10-06 — /reconcile (#225 assumptions) — reversible tier, decided by Opus
- **Scope union (scope/scopes/scp):** CONFIRMED. Only trusted issuers can supply scopes (CP-minted tokens carry none); the union gives an issuer no power it lacked (it signs all claims); the default static decider consumes no scopes, only OPA does, and OPA also receives issuer/federated; precedence would silently drop claims.
- **read_only as a method gate:** CONFIRMED. Audit of all 29 GET/SSE handlers found none mutating; the gate fails closed for new write routes; an allowlist/decorator would be higher-maintenance and fail open on omission. Optional follow-up: a tripwire spec pinning the set of GET handlers (error-codes.spec pattern) — not yet written.
- **Side finding:** GET /webhooks leaks signing secrets (https://github.com/agentcontextdistributionprotocol/acdp-control-plane/issues/230); revoke unverified-decode (#229).
- Summary: 2 confirmed, 0 changed, 0 deferred, 2 settled without the user, no code follow-up blocking ship.
