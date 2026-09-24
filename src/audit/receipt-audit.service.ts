/**
 * Receipt audit mode (ACDP 0.2.0, RFC-ACDP-0010) — the control plane as an
 * independent SECOND OBSERVER of registry claims.
 *
 * A background sweep picks up recently ingested `context_published` events
 * that have no audit verdict yet. (Publish-only by design: the registry's
 * ACDP 0.3.0 lifecycle events — `context_retracted` / `context_republished` —
 * carry no `registry_receipt` on the wire, so there is nothing to audit on
 * them; see ReceiptAuditRepository.findUnauditedPublishes.) For each one:
 *
 *   1. **Coverage** — if the registry advertises the `acdp-registry-receipts`
 *      profile but the event carried no receipt, that is a discrepancy (a
 *      0.2.0 registry with the profile MUST always mint).
 *   2. **Structural cross-checks** (no crypto needed) — the receipt's
 *      `ctx_id` / `lineage_id` / `key_fingerprint` / `origin_registry` /
 *      `registry_did` must equal the event's fields, and its `created_at`
 *      must not postdate our own observation of the event (the cheap
 *      precursor to the RFC-ACDP-0009 §2.11 transparency log: we persist
 *      arrival-vs-claimed skew so backdating is detectable in our window).
 *   3. **Cryptographic verification** (when the installed `acdp` SDK carries
 *      the receipt API — feature-detected, see receipt-verify.ts): fetch the
 *      context through the SSRF-gated federation client, independently
 *      recompute the body hash (a mismatch is enriched with the SDK's
 *      divergence diagnosis), resolve the registry's receipt key from its
 *      did:web document, resolve the producer key (did:web via the resolver;
 *      did:key bodies verify fully offline), and run the SDK's
 *      `verifyReceipt` cross-checks — including the RFC-ACDP-0010 §8 step 3
 *      body bindings (`lineage_id` / `origin_registry` / `created_at` must
 *      equal the SERVED body's, so a registry that serves a body
 *      disagreeing with its own receipt is caught) — plus the Ed25519
 *      signature check. Receipts are Ed25519-only (registry + SDK); a
 *      receipt declaring any other signature algorithm is rejected as
 *      non-conformant.
 *
 * Verdicts land in `receipt_audits` (PK = event id, idempotent) and surface
 * per run via GET /runs/:runId (`trust` member) and the
 * `acdp_receipt_audits_total{status}` metric.
 *
 * Statuses: `verified` (full crypto), `verified_historical` (full crypto, but
 * the receipt was signed by a *retired* registry key — retained in
 * `verificationMethod`, no longer in `assertionMethod` — so it is
 * RFC-ACDP-0010 §9 historically authorized rather than current), `structural`
 * (checks passed but signature verification unavailable/incomplete),
 * `discrepancy` (≥1 trust flag), `no_receipt` (absent, registry doesn't
 * advertise the profile — or its capabilities were unreadable), `error`
 * (audit could not complete).
 *
 * Retired registry receipt keys are resolved through
 * `DidWebResolverService.resolveReceiptKey` (the SDK's
 * `receiptKeyForAlgorithm`, RFC-ACDP-0010 §9 lifecycle) — a key rotated out
 * of `assertionMethod` still verifies, as `verified_historical`. A key gone
 * from `verificationMethod` entirely still fails closed.
 *
 * ## RFC-ACDP-0014 §7 consumer classification (Phase 14)
 *
 * When `KEY_REVOCATION_CHECK_ENABLED`, every audited event is ALSO
 * classified against the revocations Phase 12/13 verified for its signer
 * key — {@link classifyKeyRevocation}, which wraps the SDK's
 * `AcdpVerifier.classifyUnderRevocation`. This is a separate VERIFICATION
 * VERDICT, not a `discrepancies` flag: an otherwise perfectly honest
 * registry can serve a context signed by a key its own producer has since
 * revoked, and RFC-ACDP-0014 §10 is explicit that a §7 fail-closed "is a
 * verification verdict, not a wire condition."
 *
 * **Where it slots in.** Always AFTER the receipt verdict's `status` is
 * already decided — never before, and never keyed on `crypto.ran` alone.
 * §7 step 1 forbids feeding an UNVERIFIED `created_at` into the boundary
 * check, and `crypto.ran` can be `true` while `status` is still `'error'`
 * (an unverified-algorithm note — see the P-256 case below — does not stop
 * the rest of the crypto pipeline from running, but DOES force the overall
 * verdict to `'error'` via the `notes.length > 0` branch). Gating on the
 * FINAL `status ∈ {verified, verified_historical}` rather than on
 * `crypto.ran` is what makes the P-256 case fail closed correctly with no
 * special-casing — see `classifyRevocationForEvent`'s call site.
 *
 * **The one disambiguation that matters.** `classifyUnderRevocation` reports
 * a fail-closed verdict as `{"authorization":"none","boundary":…,"error":…}`
 * — the SAME `authorization` value as "no revocation applies at all". Code
 * here disambiguates on the presence of `boundary`, never on
 * `authorization` — see {@link classifyKeyRevocation}.
 *
 * **The P-256 producer gap — decided, not deferred.** For a non-ed25519
 * producer, `resolveProducerFingerprint` passes through the receipt's
 * CLAIMED fingerprint (the SDK exposes no P-256 fingerprint helper) and
 * appends an `unverified:` note. Feeding that unverified claim into
 * classification as though it were confirmed would let a hostile registry
 * dodge revocation checking by misreporting the fingerprint. Because the
 * note already forces `status = 'error'`, the `status ∈ {verified,
 * verified_historical}` gate on `receiptCreatedAt` above ALREADY fails this
 * case closed — `revoked_time_unverifiable`, never `none` and never
 * `pre_compromise` — with no extra code path.
 *
 * **The signer-fingerprint fallback.** `no_receipt` events never reach the
 * crypto phase at all (no receipt ⇒ nothing to verify), so there is no
 * `producerFp` from it. `auditEventInner` falls back to `ev.keyFingerprint`
 * — the RFC-ACDP-0010 trust column populated straight from the webhook
 * envelope's own (registry-supplied, UNVERIFIED) `key_fingerprint` field —
 * so a revocation naming that claimed key still surfaces as
 * `revoked_time_unverifiable` rather than being silently skipped (AC5).
 * `receiptCreatedAt` is `null` in every one of these paths regardless, so
 * this fallback can never produce `pre_compromise`.
 *
 * **`KEY_REVOCATION_ATTESTED_SCOPE` / `KEY_REVOCATION_IGNORE_FINGERPRINTS`
 * apply HERE, at classification time** — never at persistence time (Phase
 * 12's `revocation-audit.service.ts` records every binding-verified fact
 * regardless of scope; see that file's own header note on this same split).
 *
 * ## Retroactive re-audit (Phase 15)
 *
 * Everything above classifies an event AT AUDIT TIME. {@link
 * ReceiptAuditService#reauditForFingerprint} is the companion path for a
 * revocation fact recorded AFTER an event was already sealed with a
 * `verified` (or any other) verdict — `RevocationAuditService.sweep()`
 * calls it for every fingerprint with a verified fact, every pass, so a
 * `compromised_since` predating existing history amends the old verdicts
 * in place instead of leaving them reporting `verified` forever. See that
 * method's doc for the batching/idempotency/scope details, and
 * `ReceiptAuditRepository.amendKeyRevocation` for the monotone,
 * column-scoped guarantee the amendment itself relies on.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AcdpDid, AcdpVerifier } from '@agentcontextdistributionprotocol/acdp';
import { authorityToDidWeb, nonCanonicalAuthorityReason } from '../common/did-authority';
import { AppConfigService } from '../config/app-config.service';
import { SafeFederationClient } from '../contexts/safe-federation-client';
import { DatabaseService } from '../db/database.service';
import { ContextEvent, KeyRevocation, NewReceiptAudit } from '../db/schema';
import { DidWebResolverService } from '../auth/did-web/did-web-resolver.service';
import { KeyRevocationRepository } from '../storage/key-revocation.repository';
import { ReceiptAuditRepository } from '../storage/receipt-audit.repository';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { RegistryRepository } from '../storage/registry.repository';
import {
  explainHashMismatch,
  fingerprintEd25519B64,
  isCanonicalCtxId,
  sdkSupportsReceipts,
  verifyBodyOffline,
  verifyContentHash,
  verifyReceipt,
} from './receipt-verify';
import { RegistryProfileService } from './registry-profile.service';

/**
 * `Pick<typeof AcdpVerifier, …>`, not a hand-copied interface — see
 * CLAUDE.md's CI grep rule #6 / `receipt-verify.ts`'s `ReceiptSurface` for
 * why: it keeps `tsc` watching the binding's real signature.
 */
type RevocationClassifySurface = Pick<typeof AcdpVerifier, 'classifyUnderRevocation'>;
const classifyVerifier = AcdpVerifier as Partial<RevocationClassifySurface>;

/** True when the installed `acdp` binding carries `classifyUnderRevocation` (ships in `acdp` 0.9.1+). */
export function sdkSupportsRevocationClassification(): boolean {
  return typeof classifyVerifier.classifyUnderRevocation === 'function';
}

export type KeyRevocationStatus =
  | 'none'
  | 'pre_compromise'
  | 'revoked_at_or_after'
  | 'revoked_time_unverifiable';

export type KeyRevocationClassification =
  | { status: 'none' }
  | {
      status: 'pre_compromise' | 'revoked_at_or_after' | 'revoked_time_unverifiable';
      boundary: string;
      trustClass: 'producer_signed' | 'registry_attested';
      sources: Array<{ ctxId: string; publisher: string }>;
    };

/**
 * Apply the RFC-ACDP-0014 §7 compromise-boundary rule to one signer's
 * already-filtered set of verified revocations (§6 policy — which trust
 * classes apply — is the CALLER's job; see `classifyRevocationForEvent`).
 *
 * **Disambiguates on the presence of `boundary`, never on `authorization`.**
 * The SDK's fail-closed shape (§7 steps 3-4) reports
 * `{"authorization":"none","boundary":…,"error":…}` — the identical
 * `authorization` value `{"authorization":"none"}` (no revocation applies
 * at all) also uses. Reading `authorization` alone would silently disable
 * every fail-closed case this phase exists to add.
 *
 * `receiptCreatedAt === null` (no verified receipt) vs. non-null (a
 * verified receipt whose `created_at` still landed at-or-after the
 * boundary) is what tells `revoked_time_unverifiable` (§7 step 4) apart
 * from `revoked_at_or_after` (§7 step 3) — the SDK's own return shape does
 * not distinguish the two (both are `authorization:"none"` + `boundary` +
 * `error`), because from the SDK's point of view they differ only in
 * whether the CALLER had a verified `created_at` to offer it at all.
 *
 * **`receiptCreatedAt`, when non-null, is normalized to strict RFC3339
 * internally — callers may pass either form.** At live audit time it is
 * always already RFC3339 (a freshly-fetched receipt's own `created_at`
 * field, straight from JSON — never DB-sourced). At Phase 15 retroactive
 * re-audit time it comes back out of `receipt_audits.receipt_created_at`,
 * which round-trips through the exact same Postgres `timestamp with time
 * zone` rendering `toRevocationJson`'s doc describes for
 * `compromised_since` (`"2026-06-12 00:00:00+00"`, not the RFC3339 it was
 * written with) — confirmed to make the SDK throw outright, the same way,
 * by this phase's own integration test. Normalizing here, once, for every
 * caller (rather than requiring each one to remember it) turns a
 * SDK-throws-a-cryptic-error footgun into a non-issue by construction.
 */
export function classifyKeyRevocation(
  revocations: KeyRevocation[],
  signerFingerprint: string,
  receiptCreatedAt: string | null,
): KeyRevocationClassification {
  if (revocations.length === 0) return { status: 'none' };
  if (!sdkSupportsRevocationClassification()) return { status: 'none' };
  // Normalize ONCE, up front — `toRevocationJson`'s RFC3339 re-normalization
  // (see its doc comment) must also govern the boundary-equality match below,
  // or a DB-round-tripped row (Postgres's `"... +00"` rendering) would never
  // equal the SDK's own RFC3339 `boundary` even when it's the very row that
  // produced it.
  const normalized = revocations.map((r) => ({
    ...r,
    compromisedSince: new Date(r.compromisedSince).toISOString(),
  }));
  const revocationsJson = JSON.stringify(normalized.map(toRevocationJson));
  const normalizedReceiptCreatedAt =
    receiptCreatedAt === null ? null : new Date(receiptCreatedAt).toISOString();
  const raw = classifyVerifier.classifyUnderRevocation!(
    revocationsJson,
    signerFingerprint,
    normalizedReceiptCreatedAt,
  );
  const parsed = JSON.parse(raw) as { authorization: string; boundary?: string };
  if (typeof parsed.boundary !== 'string') return { status: 'none' };
  const boundary = parsed.boundary;

  // Trust class + sources are OURS to derive (the SDK reports only the
  // boundary): the revocation row(s) whose own compromised_since equals the
  // effective boundary are what "established" it. On a tie (two trust
  // classes landing on the exact same instant — an edge case, not the
  // common path) prefer producer_signed, the stronger class, as the
  // reported one — a defensible tie-break, not a silent collapse of the
  // two (see ASSUMPTIONS.md).
  const atBoundary = normalized.filter((r) => r.compromisedSince === boundary);
  const winners = atBoundary.length > 0 ? atBoundary : normalized;
  // Cast, not re-validated: `key_revocations.trust_class` is a plain
  // varchar column (Drizzle infers `string`), but every row was already
  // fail-closed validated to exactly these two values by
  // `parseKeyRevocation` before it was ever persisted (Phase 12) — the same
  // invariant `key-revocation.repository.ts`'s own `KeyRevocation` type
  // relies on elsewhere. Residual risk, unreachable today, flagged for
  // Phase 15 rather than fixed here: there is no DB CHECK constraint behind
  // that invariant, so a future writer of `key_revocations` that persisted
  // an unrecognised `trust_class` would make the SDK throw on THIS row
  // (unknown-variant deserialize failure) before this cast ever runs —
  // caught by `auditEvent`'s outer try/catch, producing `status:'error'` +
  // `keyRevocationStatus:'none'`, fail-OPEN on the one axis that matters.
  const trustClass = (winners.find((r) => r.trustClass === 'producer_signed')?.trustClass ??
    winners[0]?.trustClass ??
    'producer_signed') as 'producer_signed' | 'registry_attested';
  // Every row FED to this classification, not just the boundary winner(s)
  // — RFC-ACDP-0014 §13 provenance is "surfacing which DID issued each
  // acted-upon revocation," and every row here was acted upon (all were
  // handed to the SDK's min() fold).
  const sources = revocations.map((r) => ({ ctxId: r.ctxId, publisher: r.publisher }));

  const status: 'pre_compromise' | 'revoked_at_or_after' | 'revoked_time_unverifiable' =
    parsed.authorization === 'historically_authorized_pre_compromise'
      ? 'pre_compromise'
      : receiptCreatedAt === null
        ? 'revoked_time_unverifiable'
        : 'revoked_at_or_after';

  return { status, boundary, trustClass, sources };
}

/**
 * The exact snake_case shape `AcdpVerifier.parseKeyRevocation` returns
 * (`index.d.ts:680-685`) — `classifyUnderRevocation`'s own doc says its
 * input is "the shapes `parseKeyRevocation` returns." `reason` /
 * `revoked_key_id` are included explicitly as `null` when absent (never
 * omitted as keys) for parity with that shape, even though serde's
 * `Option<T>` handling means the installed binding accepts either form —
 * a missing key deserializes to `None` the same as an explicit `null`,
 * confirmed empirically against the pinned `acdp` binding.
 *
 * **Callers MUST pass an already-RFC3339-normalized `compromisedSince`.**
 * `key_revocations.compromised_since` round-trips through Postgres as a
 * `timestamp with time zone` — even with Drizzle's `mode: 'string'`, what
 * comes back is the driver's own textual rendering
 * (`"2026-06-01 00:00:00+00"`, a space and `+00`), not the RFC3339 the row
 * was originally written with (`"2026-06-01T00:00:00.000Z"`, from the
 * producer's signed body via `revocation-verify.ts`). The SDK's Rust
 * deserializer parses this field with `chrono`'s strict RFC3339 parser and
 * rejects the Postgres rendering outright — confirmed by this phase's own
 * integration test, which is what caught it (the unit specs construct
 * `KeyRevocation` objects in-process with the original ISO string, so they
 * never see the round-trip). `classifyKeyRevocation` normalizes every row
 * with `new Date(...).toISOString()` ONCE, up front, before calling this —
 * see its own comment for why that same normalized value also has to govern
 * the boundary-equality match below.
 */
function toRevocationJson(r: KeyRevocation): Record<string, unknown> {
  return {
    revoked_key_fingerprint: r.revokedKeyFingerprint,
    compromised_since: r.compromisedSince,
    reason: r.reason,
    revoked_key_id: r.revokedKeyId,
    revoked_key_controller: r.revokedKeyController,
    publisher: r.publisher,
    trust_class: r.trustClass,
  };
}

const ADVISORY_LOCK_KEY = 'acdp-cp-receipt-audit';
/** Tolerated forward clock skew before `created_at` postdating is flagged. */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;
/**
 * The only registry receipt signature algorithm the protocol + SDK support.
 * Registries sign receipts with Ed25519 exclusively (the registry config
 * rejects any other receipt seed and serves an `Ed25519VerificationKey2020`
 * DID document), and the SDK's `verifyReceipt` verifies Ed25519 only. A
 * receipt declaring any other algorithm is non-conformant — surfaced as an
 * `error` verdict with an accurate note rather than a misleading resolution
 * failure.
 */
const RECEIPT_SIG_ALG = 'ed25519';

interface Verdict {
  status:
    | 'verified'
    | 'verified_historical'
    | 'structural'
    | 'discrepancy'
    | 'no_receipt'
    | 'error';
  /** Trust flags (registry dishonesty signals) + `unverified:`-prefixed notes. */
  discrepancies: string[];
  receiptCreatedAt: string | null;
  skewMs: number | null;
  /** RFC-ACDP-0014 §7 — see the file header. Defaults below are 'none' / null / []. */
  keyRevocationStatus: KeyRevocationStatus;
  keyRevocationTrustClass: 'producer_signed' | 'registry_attested' | null;
  compromiseBoundary: string | null;
  keyRevocationSources: Array<{ ctxId: string; publisher: string }>;
}

const NO_REVOCATION = {
  keyRevocationStatus: 'none' as const,
  keyRevocationTrustClass: null,
  compromiseBoundary: null,
  keyRevocationSources: [],
};

/** Outcome of the cryptographic verification phase. */
interface CryptoOutcome {
  /** True when every signature/cross-check actually executed and passed. */
  ran: boolean;
  /**
   * True when the receipt verified against a *retired* registry key
   * (RFC-ACDP-0010 §9 historically authorized). Only meaningful when `ran`.
   */
  historical: boolean;
  /**
   * The producer fingerprint resolved this far (independently, for ed25519;
   * a passed-through claim for did:key/non-ed25519 — see
   * `resolveProducerFingerprint`), or `null` if verification never got far
   * enough to resolve one. Carried forward even on a LATER failure (e.g. the
   * registry receipt key itself fails to resolve) — RFC-ACDP-0014 §7
   * classification only needs to know the SIGNER, not that the receipt
   * fully verified.
   */
  producerFp: string | null;
}

@Injectable()
export class ReceiptAuditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReceiptAuditService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly database: DatabaseService,
    private readonly auditRepo: ReceiptAuditRepository,
    private readonly registryRepo: RegistryRepository,
    private readonly profiles: RegistryProfileService,
    private readonly federationClient: SafeFederationClient,
    private readonly didResolver: DidWebResolverService,
    private readonly instrumentation: InstrumentationService,
    private readonly keyRevocationRepo: KeyRevocationRepository,
  ) {}

  onModuleInit(): void {
    if (!this.config.receiptAuditEnabled) return;
    if (!sdkSupportsReceipts()) {
      this.logger.warn(
        'receipt audit enabled but the installed acdp SDK has no receipt API ' +
          '(pinned floor is >= 0.14.1; a mis-resolved native optionalDependency looks like ' +
          'this) — running structural cross-checks only, no signature verification',
      );
    }
    if (this.config.keyRevocationCheckEnabled && !sdkSupportsRevocationClassification()) {
      this.logger.warn(
        'KEY_REVOCATION_CHECK_ENABLED but the installed acdp SDK has no ' +
          'classifyUnderRevocation (ships in acdp 0.9.1+; a mis-resolved native ' +
          'optionalDependency looks like this) — every event will classify key_revocation_status ' +
          "'none' regardless of any verified revocation, silently disabling RFC-ACDP-0014 §7",
      );
    }
    const intervalMs = this.config.receiptAuditIntervalSeconds * 1000;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) =>
        this.logger.warn(
          `receipt audit sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
    this.logger.log(
      `receipt audit enabled: interval=${this.config.receiptAuditIntervalSeconds}s ` +
        `batch=${this.config.receiptAuditBatchSize} lookback=${this.config.receiptAuditLookbackHours}h ` +
        `crypto=${sdkSupportsReceipts() ? 'on' : 'unavailable'}`,
    );
    void this.sweep().catch((err) =>
      this.logger.warn(
        `initial receipt audit sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One audit pass. Multi-instance safe via a Postgres advisory lock. */
  async sweep(): Promise<number> {
    const acquired = await this.database.tryAdvisoryLock(ADVISORY_LOCK_KEY);
    if (!acquired) {
      this.logger.debug('receipt audit sweep skipped — another instance holds the lock');
      return 0;
    }
    try {
      const since = new Date(
        Date.now() - this.config.receiptAuditLookbackHours * 60 * 60 * 1000,
      ).toISOString();
      const events = await this.auditRepo.findUnauditedPublishes(
        since,
        this.config.receiptAuditBatchSize,
      );
      for (const ev of events) {
        const verdict = await this.auditEvent(ev);
        await this.auditRepo.record(this.toRow(ev, verdict));
        this.instrumentation.receiptAuditsTotal.inc({ status: verdict.status });
        if (this.config.keyRevocationCheckEnabled) {
          this.instrumentation.receiptAuditKeyRevocationsTotal.inc({
            status: verdict.keyRevocationStatus,
          });
        }
        if (verdict.status === 'discrepancy') {
          this.logger.warn(
            `receipt discrepancy ctx=${ev.ctxId ?? '?'} run=${ev.runId ?? '?'} ` +
              `registry=${ev.registryAuthority}: ${verdict.discrepancies.join('; ')}`,
          );
        }
      }
      return events.length;
    } finally {
      await this.database.advisoryUnlock(ADVISORY_LOCK_KEY);
    }
  }

  /** Audit a single publish event. Never throws — failures become verdicts. */
  async auditEvent(ev: ContextEvent): Promise<Verdict> {
    try {
      return await this.auditEventInner(ev);
    } catch (err) {
      return {
        status: 'error',
        discrepancies: [
          `unverified: audit crashed: ${err instanceof Error ? err.message : String(err)}`,
        ],
        receiptCreatedAt: null,
        skewMs: null,
        ...NO_REVOCATION,
      };
    }
  }

  /**
   * Attach the RFC-ACDP-0014 §7 classification to an otherwise-complete
   * verdict. See the file header for the gating rules — in particular, why
   * this keys on `base.status`, never on whether crypto verification merely
   * *ran*.
   */
  private async withRevocationClassification(
    ev: ContextEvent,
    base: Omit<
      Verdict,
      'keyRevocationStatus' | 'keyRevocationTrustClass' | 'compromiseBoundary' | 'keyRevocationSources'
    >,
    producerFp: string | null,
  ): Promise<Verdict> {
    if (!this.config.keyRevocationCheckEnabled) return { ...base, ...NO_REVOCATION };
    const signerFingerprint = producerFp ?? ev.keyFingerprint ?? null;
    if (!signerFingerprint) return { ...base, ...NO_REVOCATION };
    // §7 step 1: never a `created_at` that did not itself pass full receipt
    // verification (`verified` / `verified_historical`) — see the file
    // header's P-256 note for why this is `base.status`, not `crypto.ran`.
    const receiptCreatedAt =
      base.status === 'verified' || base.status === 'verified_historical'
        ? base.receiptCreatedAt
        : null;
    const classification = await this.classifyRevocationForEvent(
      ev,
      signerFingerprint,
      receiptCreatedAt,
    );
    if (classification.status === 'none') return { ...base, ...NO_REVOCATION };
    return {
      ...base,
      keyRevocationStatus: classification.status,
      keyRevocationTrustClass: classification.trustClass,
      compromiseBoundary: classification.boundary,
      keyRevocationSources: classification.sources,
    };
  }

  /**
   * `KEY_REVOCATION_ATTESTED_SCOPE` / `KEY_REVOCATION_IGNORE_FINGERPRINTS`
   * are applied HERE — see the file header on why this is classification-
   * time, not persistence-time.
   */
  private async classifyRevocationForEvent(
    ev: ContextEvent,
    signerFingerprint: string,
    receiptCreatedAt: string | null,
  ): Promise<KeyRevocationClassification> {
    const all = await this.keyRevocationRepo.findByFingerprint(signerFingerprint, ev.tenantId);
    if (all.length === 0) return { status: 'none' };
    if (this.config.keyRevocationIgnoreFingerprints.includes(signerFingerprint)) {
      return { status: 'none' };
    }
    const applicable = this.filterApplicableRevocations(all, ev.registryAuthority);
    return classifyKeyRevocation(applicable, signerFingerprint, receiptCreatedAt);
  }

  /**
   * `KEY_REVOCATION_ATTESTED_SCOPE`'s reach (§6 policy) — shared between the
   * live per-event classification above and the retroactive re-audit fan-out
   * below, so the two paths can never drift on which revocations a given
   * registry authority's events are allowed to be classified against.
   */
  private filterApplicableRevocations(
    all: KeyRevocation[],
    registryAuthority: string,
  ): KeyRevocation[] {
    return all.filter((r) => {
      if (r.trustClass === 'producer_signed') return true;
      switch (this.config.keyRevocationAttestedScope) {
        case 'off':
          return false;
        case 'global':
          return true;
        case 'same_registry':
        default:
          return r.originAuthority === registryAuthority;
      }
    });
  }

  /**
   * RFC-ACDP-0014 §7 retroactive re-audit (Phase 15). A revocation whose
   * `compromised_since` predates already-audited history must revise those
   * verdicts — `ReceiptAuditRepository.findUnauditedPublishes`'s `isNull`
   * exclusion and its lookback window both mean a `verified` row from
   * before the revocation was ever recorded would otherwise report
   * `verified` FOREVER, exactly contrary to RFC-ACDP-0014 §4's own advice
   * to producers to choose T conservatively (i.e. early — "the one
   * non-recoverable mistake" is an optimistically LATE T).
   *
   * Called by `RevocationAuditService.sweep()` for every fingerprint it
   * currently holds a verified fact for — not only ones with a fact
   * freshly recorded THIS pass — so a fingerprint whose fan-out exceeds one
   * batch (`RECEIPT_AUDIT_BATCH_SIZE`, reused rather than a dedicated knob:
   * see ASSUMPTIONS.md) converges over the next periodic sweep instead of
   * needing its own retry mechanism (AC5).
   *
   * Amends IN PLACE via `ReceiptAuditRepository.amendKeyRevocation` — see
   * its doc for the monotone, column-scoped guarantee. Candidate selection
   * (`findRevocationAmendmentCandidates`) and the amendment's own WHERE
   * clause both widen on `globalMinBoundaryIso`/`amendment.boundary`, so a
   * row already amended once IS revisited by a LATER, earlier-dated
   * revocation on the same fingerprint that tightens it further — see that
   * repository method's doc for the two-predicate design (candidate
   * selection over-inclusive on scope, the amendment itself exact).
   *
   * Per-row try/catch: one row throwing (e.g. a malformed stored value) logs
   * and counts an `error`, but must not abandon the rest of the batch — the
   * caller (`RevocationAuditService.sweep()`) only wraps this call
   * per-FINGERPRINT, so without a per-row boundary here a single bad row
   * would have silently dropped every other candidate for this fingerprint,
   * for this pass.
   */
  async reauditForFingerprint(tenantId: string, fingerprint: string): Promise<number> {
    if (!this.config.keyRevocationCheckEnabled) return 0; // AC7
    if (!sdkSupportsRevocationClassification()) return 0;
    if (this.config.keyRevocationIgnoreFingerprints.includes(fingerprint)) return 0;

    // The full current fact set for this fingerprint, fetched ONCE and
    // reused across candidate selection AND classification — §4's fold is
    // min(compromised_since) over the WHOLE set. `globalMinBoundaryIso`
    // widens candidate selection to also catch rows a SECOND, earlier-dated
    // revocation could tighten further; each `compromisedSince` is
    // normalized the same way `classifyKeyRevocation` normalizes it
    // internally, since raw comparison of Postgres-rendered timestamp text
    // is not a safe substitute for comparing actual instants.
    const all = await this.keyRevocationRepo.findByFingerprint(fingerprint, tenantId);
    if (all.length === 0) return 0;
    const globalMinBoundaryIso = all
      .map((r) => new Date(r.compromisedSince).toISOString())
      .reduce((min, iso) => (iso < min ? iso : min));

    const candidates = await this.auditRepo.findRevocationAmendmentCandidates(
      tenantId,
      fingerprint,
      globalMinBoundaryIso,
      this.config.receiptAuditBatchSize,
    );
    if (candidates.length === 0) return 0;

    let amended = 0;
    for (const row of candidates) {
      try {
        // Same gate as `withRevocationClassification`: a `created_at` only
        // ever reaches classification when the ORIGINAL verdict's status
        // was itself fully verified — see the file header's P-256 note.
        const receiptCreatedAt =
          row.status === 'verified' || row.status === 'verified_historical'
            ? row.receiptCreatedAt
            : null;
        const applicable = this.filterApplicableRevocations(all, row.registryAuthority);
        const classification = classifyKeyRevocation(applicable, fingerprint, receiptCreatedAt);
        if (classification.status === 'none') continue; // e.g. scope='off' filtered every row out
        const amendedThisRow = await this.auditRepo.amendKeyRevocation(tenantId, row.eventId, {
          status: classification.status,
          trustClass: classification.trustClass,
          boundary: classification.boundary,
          sources: classification.sources,
        });
        if (amendedThisRow) {
          amended++;
          this.instrumentation.receiptAuditRevocationReauditsTotal.inc({
            status: classification.status,
          });
        }
      } catch (err) {
        this.instrumentation.receiptAuditRevocationReauditsTotal.inc({ status: 'error' });
        this.logger.warn(
          `key-revocation re-audit failed event=${row.eventId} fingerprint=${fingerprint} ` +
            `tenant=${tenantId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (amended > 0) {
      this.logger.log(
        `key-revocation re-audit: amended ${amended}/${candidates.length} receipt_audits ` +
          `row(s) for fingerprint=${fingerprint} tenant=${tenantId}`,
      );
    }
    return amended;
  }

  private async auditEventInner(ev: ContextEvent): Promise<Verdict> {
    const payload = ev.rawPayload;
    const receipt =
      payload['registry_receipt'] !== null && typeof payload['registry_receipt'] === 'object'
        ? (payload['registry_receipt'] as Record<string, unknown>)
        : undefined;
    const authority = ev.registryAuthority;

    // No receipt: a discrepancy only when the registry positively advertises
    // the receipts profile. Unknown/unreachable capabilities never flag.
    if (!receipt) {
      const advertises = await this.profiles.advertisesReceipts(authority, ev.tenantId);
      if (advertises === true) {
        return this.withRevocationClassification(
          ev,
          {
            status: 'discrepancy',
            discrepancies: [
              `missing_receipt: '${authority}' advertises acdp-registry-receipts but the publish event carried no registry_receipt`,
            ],
            receiptCreatedAt: null,
            skewMs: null,
          },
          null,
        );
      }
      return this.withRevocationClassification(
        ev,
        { status: 'no_receipt', discrepancies: [], receiptCreatedAt: null, skewMs: null },
        null,
      );
    }

    const flags: string[] = []; // trust flags — registry dishonesty signals
    const notes: string[] = []; // 'unverified:' — checks we could not complete

    // ── Structural cross-checks: receipt fields vs the event's own fields ──
    const rCtxId = strOf(receipt['ctx_id']);
    const rLineageId = strOf(receipt['lineage_id']);
    const rFingerprint = strOf(receipt['key_fingerprint']);
    const rOrigin = strOf(receipt['origin_registry']);
    const rRegistryDid = strOf(receipt['registry_did']);
    const rCreatedAt = strOf(receipt['created_at']);

    if (ev.ctxId && rCtxId !== ev.ctxId) {
      flags.push(`ctx_id_mismatch: receipt '${rCtxId ?? ''}' != event '${ev.ctxId}'`);
    }
    if (ev.lineageId && rLineageId && rLineageId !== ev.lineageId) {
      flags.push(`lineage_id_mismatch: receipt '${rLineageId}' != event '${ev.lineageId}'`);
    }
    if (ev.keyFingerprint && rFingerprint && rFingerprint !== ev.keyFingerprint) {
      flags.push(
        `key_fingerprint_mismatch: receipt '${rFingerprint}' != event '${ev.keyFingerprint}'`,
      );
    }
    if (rOrigin !== authority) {
      flags.push(`origin_registry_mismatch: receipt '${rOrigin ?? ''}' != source '${authority}'`);
    }
    // Source-authority binding (RFC-ACDP-0010 host obligation): the receipt
    // must claim the did:web identity of the registry it actually came from.
    // The expected DID comes from the ONE canonical encoder, so a registry
    // addressed as `host:port` compares against `did:web:host%3Aport` — what a
    // conformant registry actually advertises — and not the naive, wrong
    // `did:web:host:port` that used to flag it as dishonest on every sweep.
    const expectedRegistryDid = authorityToDidWeb(authority);
    if (expectedRegistryDid === null) {
      // We cannot derive the DID to compare against from our OWN enrollment
      // data, so this is a check we could not complete — a note, never a
      // dishonesty flag against the registry.
      notes.push(`unverified: ${nonCanonicalAuthorityReason(authority)}`);
    } else if (rRegistryDid !== expectedRegistryDid) {
      flags.push(
        `registry_did_mismatch: receipt '${rRegistryDid ?? ''}' != '${expectedRegistryDid}'`,
      );
    }

    // Backdating window: persist arrival-vs-claimed skew; flag only the
    // impossible direction (receipt minted AFTER we observed the event).
    const arrivalMs = Date.parse(ev.createdAt);
    const claimedMs = rCreatedAt ? Date.parse(rCreatedAt) : NaN;
    const skewMs =
      Number.isFinite(arrivalMs) && Number.isFinite(claimedMs) ? arrivalMs - claimedMs : null;
    if (skewMs !== null && skewMs < -CLOCK_SKEW_TOLERANCE_MS) {
      flags.push(
        `created_at_after_observation: receipt claims ${rCreatedAt ?? ''} but the event arrived ${ev.createdAt}`,
      );
    }

    // ── Cryptographic verification ─────────────────────────────────────────
    const crypto = await this.verifyCryptographically(ev, receipt, flags, notes);

    const status: Verdict['status'] =
      flags.length > 0
        ? 'discrepancy'
        : notes.length > 0
          ? 'error'
          : crypto.ran
            ? crypto.historical
              ? 'verified_historical'
              : 'verified'
            : 'structural';
    return this.withRevocationClassification(
      ev,
      {
        status,
        discrepancies: [...flags, ...notes],
        receiptCreatedAt: rCreatedAt && Number.isFinite(claimedMs) ? rCreatedAt : null,
        skewMs,
      },
      crypto.producerFp,
    );
  }

  /**
   * Run the SDK's full receipt verification. `ran` is true only when every
   * cryptographic check actually executed and passed; `historical` reports
   * whether the registry receipt key was a retired (verificationMethod-only)
   * key. Environmental failures append an `unverified:` note, dishonesty
   * appends a flag.
   */
  private async verifyCryptographically(
    ev: ContextEvent,
    receipt: Record<string, unknown>,
    flags: string[],
    notes: string[],
  ): Promise<CryptoOutcome> {
    // A function, not a constant: several failure sites below resolve a
    // producer fingerprint before failing on something ELSE (e.g. the
    // registry receipt key), and that fingerprint must still reach §7
    // classification — see CryptoOutcome.producerFp's doc.
    const notRun = (producerFp: string | null = null): CryptoOutcome => ({
      ran: false,
      historical: false,
      producerFp,
    });
    if (!sdkSupportsReceipts()) return notRun();
    if (!ev.ctxId) {
      notes.push('unverified: event has no ctx_id to fetch');
      return notRun();
    }
    // The SDK parses `expectedCtxId` with `CtxId::parse`, so a non-canonical
    // ctx_id in OUR OWN row makes `verifyReceipt` throw. That throw is
    // indistinguishable at the call site from registry dishonesty, so
    // pre-check the same grammar here and report it as what it is: a defect
    // in our stored input, which must never pollute the operator-facing
    // "this registry misbehaved" list. Checked BEFORE the federation fetch —
    // a context we cannot canonically name cannot yield a verdict either
    // way, and the actionable root cause is this one, not whatever the
    // fetch would have said.
    if (!isCanonicalCtxId(ev.ctxId)) {
      notes.push(
        `unverified: stored ctx_id '${ev.ctxId}' is not canonical ` +
          `(acdp://<lowercase DNS authority>/<lowercase v4 UUID>) — the receipt cannot be ` +
          `verified against a ctx_id the protocol cannot parse`,
      );
      this.warnCtxIdUnverifiable(ev, 'stored_ctx_id_not_canonical');
      return notRun();
    }

    const registry = await this.registryRepo.findByAuthority(
      ev.registryAuthority,
      ev.tenantId,
    );
    if (!registry?.baseUrl) {
      notes.push(`unverified: no base_url known for '${ev.registryAuthority}'`);
      return notRun();
    }

    // Fetch the FullContext through the SSRF gate (public-only, no creds).
    let body: Record<string, unknown>;
    try {
      const url = `${registry.baseUrl.replace(/\/$/, '')}/contexts/${encodeURIComponent(ev.ctxId)}`;
      const resp = await this.federationClient.get(url);
      if (resp.status < 200 || resp.status >= 300) {
        notes.push(`unverified: context fetch returned HTTP ${resp.status}`);
        return notRun();
      }
      const full = JSON.parse(resp.body) as { body?: unknown };
      if (full.body === null || typeof full.body !== 'object') {
        notes.push('unverified: retrieval response has no body member');
        return notRun();
      }
      body = full.body as Record<string, unknown>;
    } catch (err) {
      notes.push(
        `unverified: context fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return notRun();
    }

    // Independently recompute the body hash. On success the echoed string is
    // proven equal to the recomputation, so it is safe to hand to
    // verifyReceipt as `recomputedBodyHash`.
    const bodyJson = JSON.stringify(body);
    const echoedHash = strOf(body['content_hash']);
    if (!echoedHash) {
      notes.push('unverified: retrieved body has no content_hash');
      return notRun();
    }
    const hashCheck = verifyContentHash(bodyJson, echoedHash);
    if (!hashCheck.ok) {
      // Enrich the flag with the SDK's divergence diagnosis so an operator can
      // tell a genuine tamper from a benign canonicalization divergence (e.g.
      // acdp_version omitted-vs-explicit). Best-effort, bounded length.
      const diagnosis = explainHashMismatch(bodyJson, echoedHash);
      const detail = diagnosis ? ` [${diagnosis.slice(0, 300)}]` : '';
      flags.push(`content_hash_mismatch: ${hashCheck.reason}${detail}`);
      return notRun();
    }

    // Producer key fingerprint — resolved INDEPENDENTLY of the registry's
    // claim wherever possible (that independence is the audit's value).
    const producerFp = await this.resolveProducerFingerprint(ev, body, receipt, flags, notes);
    if (producerFp === null) return notRun();

    // Registry receipt key: must belong to the source registry's did:web
    // identity; resolved from its DID document via the shared resolver.
    const sig =
      receipt['signature'] !== null && typeof receipt['signature'] === 'object'
        ? (receipt['signature'] as Record<string, unknown>)
        : undefined;
    const receiptKeyId = strOf(sig?.['key_id']);
    if (!receiptKeyId) {
      flags.push('receipt_invalid: signature.key_id missing');
      return notRun(producerFp);
    }
    // Registries MUST sign receipts with Ed25519 (RFC-ACDP-0010); the SDK's
    // verifyReceipt verifies Ed25519 only. Reject any other declared algorithm
    // up front with an accurate note, rather than resolving as ed25519 and
    // surfacing a confusing downgrade/alg-mismatch resolution failure.
    const receiptAlg = strOf(sig?.['algorithm']);
    if (receiptAlg && receiptAlg !== RECEIPT_SIG_ALG) {
      notes.push(
        `unverified: receipt signature algorithm '${receiptAlg}' is unsupported — ` +
          `registries MUST sign receipts with ${RECEIPT_SIG_ALG} (RFC-ACDP-0010)`,
      );
      return notRun(producerFp);
    }
    // Same canonical encoder as the source-authority binding above: the DID a
    // `host:port` registry signs its receipts under is `did:web:host%3Aport`.
    const expectedRegistryDid = authorityToDidWeb(ev.registryAuthority);
    if (expectedRegistryDid === null) {
      notes.push(
        `unverified: cannot derive the registry's did:web identity to bind the receipt key to — ` +
          nonCanonicalAuthorityReason(ev.registryAuthority),
      );
      return notRun(producerFp);
    }
    if (AcdpDid.stripFragment(receiptKeyId) !== expectedRegistryDid) {
      flags.push(
        `receipt_key_foreign_did: '${receiptKeyId}' is not a key of '${expectedRegistryDid}'`,
      );
      return notRun(producerFp);
    }
    // Registry receipt key uses the RFC-ACDP-0010 §9 lifecycle (NOT the
    // assertionMethod gate): a key rotated out of assertionMethod but kept in
    // verificationMethod still verifies — reported as historically authorized.
    let registryKeyB64: string;
    let historical: boolean;
    try {
      const resolved = await this.didResolver.resolveReceiptKey(receiptKeyId, RECEIPT_SIG_ALG);
      registryKeyB64 = resolved.publicKeyB64;
      historical = resolved.historical;
    } catch (err) {
      notes.push(
        `unverified: registry receipt key resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return notRun(producerFp);
    }

    // `bodyJson` is the SAME string `verifyContentHash` was run against, so
    // the SDK's §8 step 3 body bindings are checked against the body whose
    // hash we independently recomputed — not a re-serialization of it.
    const result = verifyReceipt(
      JSON.stringify(receipt),
      bodyJson,
      registryKeyB64,
      ev.ctxId,
      echoedHash,
      producerFp,
    );
    if (!result.ok) {
      // Not every verifyReceipt throw is registry dishonesty. See
      // `ReceiptFailureKind` for why the three are told apart, and why the
      // unrecognised case falls through to the flag rather than the note.
      switch (result.kind) {
        case 'malformed_body':
          notes.push(
            `unverified: '${ev.registryAuthority}' served a body the SDK cannot parse: ` +
              result.reason,
          );
          break;
        case 'ctx_id_rejected':
          // Rare but expected: `isCanonicalCtxId` is a deliberately bounded
          // mirror of CtxId::parse — it does not enforce the SDK's
          // 63-character DNS-label limit (see the note on CANONICAL_CTX_ID),
          // so an over-long label reaches the SDK and is refused here. Either
          // way the ctx_id is OURS, so this is a note, never a flag.
          notes.push(
            `unverified: the SDK's CtxId::parse rejected ctx_id '${ev.ctxId}' that the host ` +
              `pre-check accepted — the host mirror does not enforce every CtxId::parse ` +
              `bound (e.g. the 63-character DNS-label limit); the SDK is the authority: ` +
              result.reason,
          );
          this.warnCtxIdUnverifiable(ev, 'sdk_rejected_ctx_id');
          break;
        default:
          flags.push(`receipt_invalid: ${result.reason}`);
      }
      return notRun(producerFp);
    }
    return { ran: true, historical, producerFp };
  }

  /**
   * The operator-visible signal for the two ways a ctx_id WE stored turns
   * what would have been a `verified` receipt audit into an `error`.
   *
   * Neither is registry dishonesty, so neither appears in
   * `RunTrustSummary.flagged` (which carries only `discrepancy` rows' notes),
   * and `acdp_receipt_audits_total{status="error"}` shares its label with
   * ordinary fetch/DID-resolution failures — so without this line the only
   * way to notice it is querying `receipt_audits` by hand. Structured fields,
   * not a stringified payload: `auditCause` is the stable key to grep and
   * alert on, separate from transport noise.
   */
  private warnCtxIdUnverifiable(
    ev: ContextEvent,
    auditCause: 'stored_ctx_id_not_canonical' | 'sdk_rejected_ctx_id',
  ): void {
    this.logger.warn({
      msg:
        `receipt audit cannot verify ctx_id '${ev.ctxId ?? '?'}' (${auditCause}) — ` +
        `verdict is 'error', not 'verified'`,
      auditCause,
      auditStatus: 'error',
      eventId: ev.id,
      ctxId: ev.ctxId,
      runId: ev.runId,
      registryAuthority: ev.registryAuthority,
      tenantId: ev.tenantId,
    });
  }

  /**
   * Fingerprint of the producer key for the receipt cross-check.
   *
   * - did:web + ed25519: resolve the body's signing key from the producer's
   *   DID document and fingerprint it — fully independent of the registry.
   * - did:key: the body verifies fully OFFLINE against the key embedded in
   *   the DID (`verifyBodyOffline`), which is a stronger statement than the
   *   fingerprint cross-check; the receipt's own fingerprint is then passed
   *   through (making that one verifyReceipt check an internal-consistency
   *   check rather than an independent one).
   * - ecdsa-p256 producers: a conformant receipts-mode registry never emits
   *   one (P-256 producers exist only in playground mode, which the registry
   *   makes mutually exclusive with receipts), and the SDK exposes no P-256
   *   fingerprint helper — so if a P-256 producer fingerprint ever appears it
   *   signals a non-conformant registry, and the receipt's claim is passed
   *   through (consistency-only) with a note rather than failing the audit.
   *
   * Returns null when verification cannot proceed (note already appended).
   */
  private async resolveProducerFingerprint(
    ev: ContextEvent,
    body: Record<string, unknown>,
    receipt: Record<string, unknown>,
    flags: string[],
    notes: string[],
  ): Promise<string | null> {
    const claimedFp = strOf(receipt['key_fingerprint']) ?? '';

    if (ev.agentId.startsWith('did:key:')) {
      const offline = verifyBodyOffline(JSON.stringify(body));
      if (!offline.ok) {
        flags.push(`body_signature_invalid: ${offline.reason}`);
        return null;
      }
      return claimedFp;
    }

    const sig =
      body['signature'] !== null && typeof body['signature'] === 'object'
        ? (body['signature'] as Record<string, unknown>)
        : undefined;
    const keyId = strOf(sig?.['key_id']);
    const algorithm = strOf(sig?.['algorithm']) ?? 'ed25519';
    if (!keyId) {
      notes.push('unverified: body has no signature.key_id');
      return null;
    }
    if (algorithm !== 'ed25519') {
      notes.push(
        `unverified: producer algorithm '${algorithm}' is unexpected in a receipts-mode ` +
          `event (Ed25519/did:key only) and the SDK has no P-256 fingerprint helper — ` +
          `receipt fingerprint passed through`,
      );
      return claimedFp;
    }
    try {
      const resolved = await this.didResolver.resolveKey(keyId, 'ed25519');
      return fingerprintEd25519B64(resolved.publicKeyB64);
    } catch (err) {
      notes.push(
        `unverified: producer key resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private toRow(ev: ContextEvent, verdict: Verdict): NewReceiptAudit {
    return {
      eventId: ev.id,
      tenantId: ev.tenantId,
      runId: ev.runId,
      ctxId: ev.ctxId,
      registryAuthority: ev.registryAuthority,
      status: verdict.status,
      discrepancies: verdict.discrepancies,
      receiptCreatedAt: verdict.receiptCreatedAt,
      eventArrivedAt: ev.createdAt,
      skewMs: verdict.skewMs,
      keyRevocationStatus: verdict.keyRevocationStatus,
      keyRevocationTrustClass: verdict.keyRevocationTrustClass,
      compromiseBoundary: verdict.compromiseBoundary,
      keyRevocationSources: verdict.keyRevocationSources,
    };
  }
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
