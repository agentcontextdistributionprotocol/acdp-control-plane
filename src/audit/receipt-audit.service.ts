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
 *      `verifyReceipt` cross-checks + Ed25519 signature check. Receipts are
 *      Ed25519-only (registry + SDK); a receipt declaring any other signature
 *      algorithm is rejected as non-conformant.
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
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AcdpDid } from 'acdp';
import { AppConfigService } from '../config/app-config.service';
import { SafeFederationClient } from '../contexts/safe-federation-client';
import { DatabaseService } from '../db/database.service';
import { ContextEvent, NewReceiptAudit } from '../db/schema';
import { DidWebResolverService } from '../auth/did-web/did-web-resolver.service';
import { ReceiptAuditRepository } from '../storage/receipt-audit.repository';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { RegistryRepository } from '../storage/registry.repository';
import {
  explainHashMismatch,
  fingerprintEd25519B64,
  sdkSupportsReceipts,
  verifyBodyOffline,
  verifyContentHash,
  verifyReceipt,
} from './receipt-verify';
import { RegistryProfileService } from './registry-profile.service';

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
}

/** Outcome of the cryptographic verification phase. */
interface CryptoOutcome {
  /** True when every signature/cross-check actually executed and passed. */
  ran: boolean;
  /**
   * True when the receipt verified against a *retired* registry key
   * (RFC-ACDP-0010 §9 historically authorized). Only meaningful when `ran`.
   */
  historical: boolean;
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
  ) {}

  onModuleInit(): void {
    if (!this.config.receiptAuditEnabled) return;
    if (!sdkSupportsReceipts()) {
      this.logger.warn(
        'receipt audit enabled but the installed acdp SDK predates the receipt API ' +
          '(need > 0.3.0) — running structural cross-checks only, no signature verification',
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
      };
    }
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
        return {
          status: 'discrepancy',
          discrepancies: [
            `missing_receipt: '${authority}' advertises acdp-registry-receipts but the publish event carried no registry_receipt`,
          ],
          receiptCreatedAt: null,
          skewMs: null,
        };
      }
      return { status: 'no_receipt', discrepancies: [], receiptCreatedAt: null, skewMs: null };
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
    if (rRegistryDid !== `did:web:${authority}`) {
      flags.push(
        `registry_did_mismatch: receipt '${rRegistryDid ?? ''}' != 'did:web:${authority}'`,
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
    return {
      status,
      discrepancies: [...flags, ...notes],
      receiptCreatedAt: rCreatedAt && Number.isFinite(claimedMs) ? rCreatedAt : null,
      skewMs,
    };
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
    const notRun: CryptoOutcome = { ran: false, historical: false };
    if (!sdkSupportsReceipts()) return notRun;
    if (!ev.ctxId) {
      notes.push('unverified: event has no ctx_id to fetch');
      return notRun;
    }

    const registry = await this.registryRepo.findByAuthority(
      ev.registryAuthority,
      ev.tenantId,
    );
    if (!registry?.baseUrl) {
      notes.push(`unverified: no base_url known for '${ev.registryAuthority}'`);
      return notRun;
    }

    // Fetch the FullContext through the SSRF gate (public-only, no creds).
    let body: Record<string, unknown>;
    try {
      const url = `${registry.baseUrl.replace(/\/$/, '')}/contexts/${encodeURIComponent(ev.ctxId)}`;
      const resp = await this.federationClient.get(url);
      if (resp.status < 200 || resp.status >= 300) {
        notes.push(`unverified: context fetch returned HTTP ${resp.status}`);
        return notRun;
      }
      const full = JSON.parse(resp.body) as { body?: unknown };
      if (full.body === null || typeof full.body !== 'object') {
        notes.push('unverified: retrieval response has no body member');
        return notRun;
      }
      body = full.body as Record<string, unknown>;
    } catch (err) {
      notes.push(
        `unverified: context fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return notRun;
    }

    // Independently recompute the body hash. On success the echoed string is
    // proven equal to the recomputation, so it is safe to hand to
    // verifyReceipt as `recomputedBodyHash`.
    const bodyJson = JSON.stringify(body);
    const echoedHash = strOf(body['content_hash']);
    if (!echoedHash) {
      notes.push('unverified: retrieved body has no content_hash');
      return notRun;
    }
    const hashCheck = verifyContentHash(bodyJson, echoedHash);
    if (!hashCheck.ok) {
      // Enrich the flag with the SDK's divergence diagnosis so an operator can
      // tell a genuine tamper from a benign canonicalization divergence (e.g.
      // acdp_version omitted-vs-explicit). Best-effort, bounded length.
      const diagnosis = explainHashMismatch(bodyJson, echoedHash);
      const detail = diagnosis ? ` [${diagnosis.slice(0, 300)}]` : '';
      flags.push(`content_hash_mismatch: ${hashCheck.reason}${detail}`);
      return notRun;
    }

    // Producer key fingerprint — resolved INDEPENDENTLY of the registry's
    // claim wherever possible (that independence is the audit's value).
    const producerFp = await this.resolveProducerFingerprint(ev, body, receipt, flags, notes);
    if (producerFp === null) return notRun;

    // Registry receipt key: must belong to the source registry's did:web
    // identity; resolved from its DID document via the shared resolver.
    const sig =
      receipt['signature'] !== null && typeof receipt['signature'] === 'object'
        ? (receipt['signature'] as Record<string, unknown>)
        : undefined;
    const receiptKeyId = strOf(sig?.['key_id']);
    if (!receiptKeyId) {
      flags.push('receipt_invalid: signature.key_id missing');
      return notRun;
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
      return notRun;
    }
    if (AcdpDid.stripFragment(receiptKeyId) !== `did:web:${ev.registryAuthority}`) {
      flags.push(
        `receipt_key_foreign_did: '${receiptKeyId}' is not a key of 'did:web:${ev.registryAuthority}'`,
      );
      return notRun;
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
      return notRun;
    }

    const result = verifyReceipt(
      JSON.stringify(receipt),
      registryKeyB64,
      ev.ctxId,
      echoedHash,
      producerFp,
    );
    if (!result.ok) {
      flags.push(`receipt_invalid: ${result.reason}`);
      return notRun;
    }
    return { ran: true, historical };
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
    };
  }
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
