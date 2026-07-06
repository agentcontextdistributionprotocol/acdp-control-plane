/**
 * Transparency-log checkpoint witness (ACDP 0.3.0 Tier 3, RFC-ACDP-0012).
 *
 * The control plane as an EXTERNAL WITNESS / MONITOR — the standing vantage
 * RFC-ACDP-0012 §13 says detection requires: it retains registry checkpoints
 * over time and demands consistency between them, so a history rewrite,
 * split view, or log reset produces persisted, non-repudiable evidence
 * instead of going unnoticed. Strictly the witness half of the reserved
 * RFC-ACDP-0009 §2.12 ecosystem: the cosigning protocol is NOT specified,
 * so no cosignatures are minted — witness + detect only.
 *
 * Per sweep (advisory-locked, config-gated — the receipt-audit pattern),
 * for every enrolled+enabled registry advertising
 * `acdp-registry-transparency-log` (RegistryProfileService):
 *
 *   1. GET /log/checkpoint through the SSRF-gated federation client.
 *   2. §9.3: closed parse; registry binding (`log_id`'s DID and the
 *      signature key's DID must both be `did:web:<source authority>`);
 *      timestamp skew; signature over the recomputed JCS preimage hash,
 *      against the registry's receipt signing key resolved from its did:web
 *      document (RFC-ACDP-0010 §9 lifecycle — retired keys verify, same as
 *      receipt audit).
 *   3. When a prior head is retained for the registry: demand
 *      GET /log/proof?first=<prev>&second=<new> and verify §9.2 consistency
 *      against the RETAINED root.
 *
 * Alert taxonomy (dishonesty signals — each persists evidence, marks the
 * cursor alerted, increments `acdp_log_witness_alerts_total{reason}`, and —
 * on the not-alerted → alerted transition (or a reason change; repeat sweeps
 * over the same broken state don't re-spam subscribers) — emits a
 * `log_witness_alert` SSE event + outbound webhook):
 *
 *   - `checkpoint_invalid`            — §9.3 shape/binding/skew failure
 *   - `checkpoint_signature_invalid`  — §9.3 step 2 failure
 *   - `tree_size_regression`          — new head smaller than the retained one
 *   - `root_mismatch`                 — same tree_size, different root (split view)
 *   - `consistency_failed`            — §9.2 fold failure or the registry
 *     refusing the REQUIRED consistency proof (HTTP error on a valid range)
 *     — the ROOT REWRITE headline
 *   - `log_id_changed`                — new log instantiation (§7.4 reset)
 *
 * Environmental failures (transport, capabilities unreachable, DID
 * resolution) are never alerts: they bump `consecutive_failures` and retry
 * next sweep. The cursor's retained head advances ONLY on full success, so
 * the pre-incident root survives as the §9.2 first_root and forensic anchor.
 * Failures are per-registry isolated — one broken registry never stalls the
 * loop for the rest.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AcdpDid } from 'acdp';
import { RegistryEnrollment } from '../db/schema';
import { AppConfigService } from '../config/app-config.service';
import { SafeFederationClient } from '../contexts/safe-federation-client';
import { AcdpStreamEvent } from '../contracts/acdp';
import { DatabaseService } from '../db/database.service';
import { DidWebResolverService } from '../auth/did-web/did-web-resolver.service';
import { ErrorCode } from '../errors/error-codes';
import { StreamHubService } from '../events/stream-hub.service';
import { LogCosignatureRepository } from '../storage/log-cosignature.repository';
import { LogWitnessRepository } from '../storage/log-witness.repository';
import { RegistryEnrollmentRepository } from '../storage/registry-enrollment.repository';
import { RegistryRepository } from '../storage/registry.repository';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { WebhookService } from '../webhooks/webhook.service';
import { WitnessSigningService } from '../witness/witness-signing.service';
import { mintCosignature } from './cosign';
import {
  checkpointTimestampOk,
  LogCheckpoint,
  logIdRegistryDid,
  parseCheckpoint,
  parseConsistencyProof,
  sdkHasLogSurface,
  verifyCheckpointSignature,
  verifyConsistency,
} from './log-verify';
import { RegistryProfileService } from './registry-profile.service';

const ADVISORY_LOCK_KEY = 'acdp-cp-log-witness';
/** SSE / outbound-webhook event type for witness alerts. */
export const LOG_WITNESS_ALERT_EVENT = 'log_witness_alert';

export type WitnessAlertReason =
  | 'checkpoint_invalid'
  | 'checkpoint_signature_invalid'
  | 'tree_size_regression'
  | 'root_mismatch'
  | 'consistency_failed'
  | 'log_id_changed';

/** Outcome of witnessing one registry — returned for tests / diagnostics. */
export interface WitnessOutcome {
  authority: string;
  status: 'witnessed' | 'skipped' | 'alert' | 'error';
  /** Alert reason, or a human-readable skip/error note. */
  reason?: string;
}

@Injectable()
export class CheckpointWitnessPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CheckpointWitnessPollerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly database: DatabaseService,
    private readonly witnessRepo: LogWitnessRepository,
    private readonly enrollmentRepo: RegistryEnrollmentRepository,
    private readonly registryRepo: RegistryRepository,
    private readonly profiles: RegistryProfileService,
    private readonly federationClient: SafeFederationClient,
    private readonly didResolver: DidWebResolverService,
    private readonly instrumentation: InstrumentationService,
    private readonly streamHub: StreamHubService,
    private readonly webhookService: WebhookService,
    // ACDP 0.4.0 (RFC-ACDP-0015): the cosign layer. Both are no-ops when
    // WITNESS_COSIGNING_ENABLED=false — the witness stays detect-only.
    private readonly witnessSigning: WitnessSigningService,
    private readonly cosignatureRepo: LogCosignatureRepository,
  ) {}

  onModuleInit(): void {
    if (!this.config.logWitnessEnabled) return;
    const intervalMs = this.config.logWitnessIntervalSeconds * 1000;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) =>
        this.logger.warn(`log-witness sweep failed: ${msgOf(err)}`),
      );
    }, intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
    this.logger.log(
      `checkpoint witness enabled: interval=${this.config.logWitnessIntervalSeconds}s ` +
        `excluded=[${this.config.logWitnessExcludeAuthorities.join(',')}] ` +
        `verification=${sdkHasLogSurface() ? 'acdp-binding (native §9.2 fold)' : 'host (§5/§9 over SDK JCS + Ed25519; binding predates the log API)'} ` +
        `cosigning=${this.witnessSigning.enabled ? `on (RFC-ACDP-0015, witness_id=${this.witnessSigning.witnessId})` : 'off (detect-only)'}`,
    );
    void this.sweep().catch((err) =>
      this.logger.warn(`initial log-witness sweep failed: ${msgOf(err)}`),
    );
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One witness pass over all enrolled registries. Multi-instance safe. */
  async sweep(): Promise<WitnessOutcome[]> {
    const acquired = await this.database.tryAdvisoryLock(ADVISORY_LOCK_KEY);
    if (!acquired) {
      this.logger.debug('log-witness sweep skipped — another instance holds the lock');
      return [];
    }
    try {
      const enrollments = await this.enrollmentRepo.listAllEnabled();
      const outcomes: WitnessOutcome[] = [];
      for (const enrollment of enrollments) {
        // Per-registry isolation: one throwing registry never stalls the rest.
        try {
          outcomes.push(await this.witnessRegistry(enrollment));
        } catch (err) {
          this.logger.warn(
            `log-witness pass for '${enrollment.authority}' crashed: ${msgOf(err)}`,
          );
          await this.recordFailureSafe(enrollment.tenantId, enrollment.authority);
          outcomes.push({
            authority: enrollment.authority,
            status: 'error',
            reason: msgOf(err),
          });
        }
      }
      return outcomes;
    } finally {
      await this.database.advisoryUnlock(ADVISORY_LOCK_KEY);
    }
  }

  /** Witness one registry's current checkpoint. Never throws on registry data. */
  private async witnessRegistry(enrollment: RegistryEnrollment): Promise<WitnessOutcome> {
    const authority = enrollment.authority;
    const tenantId = enrollment.tenantId;

    if (this.config.logWitnessExcludeAuthorities.includes(authority)) {
      return { authority, status: 'skipped', reason: 'excluded by LOG_WITNESS_EXCLUDE_AUTHORITIES' };
    }

    const advertises = await this.profiles.advertisesTransparencyLog(authority, tenantId);
    if (advertises !== true) {
      // false → conformantly log-less; null → capabilities unreachable.
      // Either way there is nothing to witness (and nothing to flag — a
      // registry is free not to offer the log, RFC-ACDP-0012 §13).
      return {
        authority,
        status: 'skipped',
        reason:
          advertises === false
            ? 'registry does not advertise acdp-registry-transparency-log'
            : 'capabilities unreadable',
      };
    }

    const baseUrl = await this.resolveBaseUrl(enrollment);
    if (!baseUrl) {
      await this.recordFailureSafe(tenantId, authority);
      return { authority, status: 'error', reason: 'no base_url known' };
    }

    // ── Fetch the current signed tree head ────────────────────────────────
    let checkpointRaw: unknown;
    try {
      const resp = await this.federationClient.get(`${baseUrl}/log/checkpoint`);
      if (resp.status < 200 || resp.status >= 300) {
        await this.recordFailureSafe(tenantId, authority);
        return { authority, status: 'error', reason: `/log/checkpoint returned HTTP ${resp.status}` };
      }
      checkpointRaw = JSON.parse(resp.body);
    } catch (err) {
      await this.recordFailureSafe(tenantId, authority);
      return { authority, status: 'error', reason: `checkpoint fetch failed: ${msgOf(err)}` };
    }

    // ── §9.3 steps 1, 3, 4: closed parse, registry binding, skew ─────────
    const parsed = parseCheckpoint(checkpointRaw);
    if (!parsed.ok) {
      return this.raiseAlert(tenantId, authority, 'checkpoint_invalid', {
        code: ErrorCode.INVALID_LOG_PROOF,
        error: parsed.reason,
        checkpoint: checkpointRaw as Record<string, unknown> | null,
      });
    }
    const checkpoint = parsed.checkpoint;

    const expectedDid = `did:web:${authority}`;
    const bindingError = this.checkRegistryBinding(checkpoint, expectedDid);
    if (bindingError) {
      return this.raiseAlert(tenantId, authority, 'checkpoint_invalid', {
        code: ErrorCode.INVALID_LOG_PROOF,
        error: bindingError,
        checkpoint: checkpoint as unknown as Record<string, unknown>,
      });
    }

    const skew = checkpointTimestampOk(checkpoint);
    if (!skew.ok) {
      return this.raiseAlert(tenantId, authority, 'checkpoint_invalid', {
        code: ErrorCode.INVALID_LOG_PROOF,
        error: skew.reason,
        checkpoint: checkpoint as unknown as Record<string, unknown>,
      });
    }

    // ── §9.3 step 2: signature against the resolved receipt signing key ──
    let registryKeyB64: string;
    try {
      const resolved = await this.didResolver.resolveReceiptKey(
        checkpoint.signature.key_id,
        'ed25519',
      );
      registryKeyB64 = resolved.publicKeyB64;
    } catch (err) {
      // Resolution failure is environmental (registry DID doc unreachable),
      // not proof of dishonesty — retry next sweep, cursor holds.
      await this.recordFailureSafe(tenantId, authority);
      return { authority, status: 'error', reason: `receipt key resolution failed: ${msgOf(err)}` };
    }

    const sigVerdict = verifyCheckpointSignature(checkpoint, registryKeyB64);
    if (!sigVerdict.ok) {
      await this.persistCheckpointSafe(tenantId, authority, checkpoint, false, null);
      return this.raiseAlert(tenantId, authority, 'checkpoint_signature_invalid', {
        code: ErrorCode.INVALID_LOG_PROOF,
        error: sigVerdict.reason,
        checkpoint: checkpoint as unknown as Record<string, unknown>,
      });
    }

    // ── State machine vs the retained cursor ─────────────────────────────
    const cursor = await this.witnessRepo.getCursor(tenantId, authority);
    const prior =
      cursor &&
      cursor.logId !== null &&
      cursor.lastWitnessedSize !== null &&
      cursor.lastRootHash !== null
        ? { logId: cursor.logId, size: cursor.lastWitnessedSize, root: cursor.lastRootHash }
        : null;

    if (prior === null) {
      // First witnessed checkpoint of this registry: nothing to compare —
      // consistency_ok stays NULL. This head becomes the retained anchor.
      // RFC-ACDP-0015 §7: a witness's first observation of a log anchors but
      // proves no consistency; its signature IS verified (step 1), so it may be
      // cosigned — the anti-rewrite guarantee accrues from the SECOND
      // observation onward.
      await this.persistCheckpointSafe(tenantId, authority, checkpoint, true, null);
      await this.witnessRepo.advanceCursor({
        tenantId,
        authority,
        logId: checkpoint.log_id,
        treeSize: checkpoint.tree_size,
        rootHash: checkpoint.root_hash,
      });
      await this.cosignSafe(tenantId, authority, checkpoint);
      this.instrumentation.logWitnessChecksTotal.inc({ result: 'witnessed' });
      this.logger.log(
        `witnessed first checkpoint of '${checkpoint.log_id}' at size ${checkpoint.tree_size}`,
      );
      return { authority, status: 'witnessed' };
    }

    if (checkpoint.log_id !== prior.logId) {
      // §7.4: a new instantiation is an explicit, detectable reset — loud by
      // design. Evidence persists; the cursor holds the OLD log's head so an
      // operator can still demand history for it out-of-band.
      await this.persistCheckpointSafe(tenantId, authority, checkpoint, true, null);
      return this.raiseAlert(tenantId, authority, 'log_id_changed', {
        error: `log instantiation changed from '${prior.logId}' to '${checkpoint.log_id}' (RFC-ACDP-0012 §7.4 reset)`,
        previous: { log_id: prior.logId, tree_size: prior.size, root_hash: prior.root },
        checkpoint: checkpoint as unknown as Record<string, unknown>,
      });
    }

    if (checkpoint.tree_size < prior.size) {
      await this.persistCheckpointSafe(tenantId, authority, checkpoint, true, false);
      return this.raiseAlert(tenantId, authority, 'tree_size_regression', {
        code: ErrorCode.INVALID_LOG_PROOF,
        error: `tree_size regressed from ${prior.size} to ${checkpoint.tree_size} — an append-only log can never shrink (§5.3)`,
        previous: { log_id: prior.logId, tree_size: prior.size, root_hash: prior.root },
        checkpoint: checkpoint as unknown as Record<string, unknown>,
      });
    }

    if (checkpoint.tree_size === prior.size) {
      if (checkpoint.root_hash !== prior.root) {
        // Two signature-valid checkpoints, same log_id + tree_size,
        // different roots: compact non-repudiable split-view proof (§3).
        await this.persistCheckpointSafe(tenantId, authority, checkpoint, true, false);
        return this.raiseAlert(tenantId, authority, 'root_mismatch', {
          code: ErrorCode.INVALID_LOG_PROOF,
          error: `root_hash changed at unchanged tree_size ${prior.size} — signed split-view/equivocation evidence`,
          previous: { log_id: prior.logId, tree_size: prior.size, root_hash: prior.root },
          checkpoint: checkpoint as unknown as Record<string, unknown>,
        });
      }
      // Unchanged head re-signed with a fresh timestamp — a liveness signal
      // (§6). Nothing new to prove; touch the cursor's success clock. The tuple
      // is unchanged, so the cosignature is idempotent (RFC-ACDP-0015 §4/§7 —
      // we retain the first per tuple rather than re-mint a liveness copy).
      await this.witnessRepo.advanceCursor({
        tenantId,
        authority,
        logId: checkpoint.log_id,
        treeSize: checkpoint.tree_size,
        rootHash: checkpoint.root_hash,
      });
      await this.cosignSafe(tenantId, authority, checkpoint);
      this.instrumentation.logWitnessChecksTotal.inc({ result: 'witnessed' });
      return { authority, status: 'witnessed' };
    }

    // tree_size grew: demand the §9.2 consistency proof against OUR root.
    return this.verifyGrowth(tenantId, authority, baseUrl, prior, checkpoint);
  }

  /**
   * §9.2: the tree at the retained size must be a prefix of the new tree.
   * The registry refusing the proof (consistency mode is REQUIRED, §8.2) or
   * serving one that fails the fold is the root-rewrite evidence this
   * service exists to catch.
   */
  private async verifyGrowth(
    tenantId: string,
    authority: string,
    baseUrl: string,
    prior: { logId: string; size: number; root: string },
    checkpoint: LogCheckpoint,
  ): Promise<WitnessOutcome> {
    const proofUrl = `${baseUrl}/log/proof?first=${prior.size}&second=${checkpoint.tree_size}`;
    let proofRaw: unknown;
    try {
      const resp = await this.federationClient.get(proofUrl);
      if (resp.status < 200 || resp.status >= 300) {
        // A 2xx-capable registry refusing a valid-range consistency proof is
        // itself the evidence (§3: "refusal or failure to produce one").
        await this.persistCheckpointSafe(tenantId, authority, checkpoint, true, false);
        return this.raiseAlert(tenantId, authority, 'consistency_failed', {
          code: ErrorCode.INVALID_LOG_PROOF,
          error: `registry refused the REQUIRED consistency proof (HTTP ${resp.status}) for ${prior.size}→${checkpoint.tree_size}`,
          previous: { log_id: prior.logId, tree_size: prior.size, root_hash: prior.root },
          checkpoint: checkpoint as unknown as Record<string, unknown>,
        });
      }
      proofRaw = JSON.parse(resp.body);
    } catch (err) {
      // Transport failure — environmental; retry next sweep with the same
      // retained root (the demand does not expire).
      await this.recordFailureSafe(tenantId, authority);
      return { authority, status: 'error', reason: `consistency proof fetch failed: ${msgOf(err)}` };
    }

    const parsed = parseConsistencyProof(proofRaw);
    const shapeError = !parsed.ok
      ? parsed.reason
      : parsed.proof.log_id !== checkpoint.log_id
        ? `proof log_id '${parsed.proof.log_id}' != checkpoint log_id '${checkpoint.log_id}'`
        : parsed.proof.first_tree_size !== prior.size ||
            parsed.proof.second_tree_size !== checkpoint.tree_size
          ? `proof sizes ${parsed.proof.first_tree_size}→${parsed.proof.second_tree_size} do not match the demanded ${prior.size}→${checkpoint.tree_size}`
          : null;

    // Native binding (acdp 0.6.0+) when present; host arithmetic otherwise.
    // Both fold the §9.2 consistency path against OUR retained root.
    const foldVerdict =
      shapeError || !parsed.ok
        ? { ok: false as const, reason: shapeError ?? 'malformed consistency proof' }
        : verifyConsistency(parsed.proof, checkpoint, prior.root);

    if (!foldVerdict.ok) {
      // THE headline detection: the retained pre-rewrite root, the new signed
      // checkpoint, and the failing path persist together as the evidence
      // pair (§9.2/§15). The cursor holds the pre-rewrite root.
      await this.persistCheckpointSafe(tenantId, authority, checkpoint, true, false);
      return this.raiseAlert(tenantId, authority, 'consistency_failed', {
        code: ErrorCode.INVALID_LOG_PROOF,
        error: `consistency proof ${prior.size}→${checkpoint.tree_size} failed: ${foldVerdict.reason}`,
        previous: { log_id: prior.logId, tree_size: prior.size, root_hash: prior.root },
        checkpoint: checkpoint as unknown as Record<string, unknown>,
        consistency_path: parsed.ok ? parsed.proof.consistency_path : null,
      });
    }

    await this.persistCheckpointSafe(tenantId, authority, checkpoint, true, true);
    await this.witnessRepo.advanceCursor({
      tenantId,
      authority,
      logId: checkpoint.log_id,
      treeSize: checkpoint.tree_size,
      rootHash: checkpoint.root_hash,
    });
    // §7 obligation discharged (signature valid AND consistency from the
    // retained head verified) — only NOW may we cosign.
    await this.cosignSafe(tenantId, authority, checkpoint);
    this.instrumentation.logWitnessChecksTotal.inc({ result: 'witnessed' });
    this.logger.log(
      `witnessed '${checkpoint.log_id}' ${prior.size}→${checkpoint.tree_size} (consistency verified)`,
    );
    return { authority, status: 'witnessed' };
  }

  /**
   * RFC-ACDP-0015 §4–§5/§7 step 3 — MINT and persist a cosignature for a
   * checkpoint that has just passed the §7 obligation (signature valid, and
   * consistency from the retained head verified or this being the first
   * observation). No-op when cosigning is disabled — the witness stays
   * detect-only. A checkpoint that FAILED the obligation never reaches here:
   * every failure path raises an alert and returns before the cosign call,
   * which is the entire point of witnessing.
   *
   * Idempotent per (witness_id, log_id, tree_size, root_hash): re-observing the
   * same head keeps the first cosignature. Never throws — a cosign failure must
   * not stall the detect sweep.
   */
  private async cosignSafe(
    tenantId: string,
    authority: string,
    checkpoint: LogCheckpoint,
  ): Promise<void> {
    const signer = this.witnessSigning.signer;
    if (!this.witnessSigning.enabled || signer === null) return;
    try {
      // witnessed_at: the witness-clock observation time, canonical ms RFC 3339
      // (toISOString is always ms-precision — RFC-ACDP-0001 §5.3).
      const witnessedAt = new Date().toISOString();
      const minted = mintCosignature(
        {
          log_id: checkpoint.log_id,
          tree_size: checkpoint.tree_size,
          root_hash: checkpoint.root_hash,
          timestamp: checkpoint.timestamp,
        },
        witnessedAt,
        signer,
      );
      if (!minted.ok) {
        this.instrumentation.logCosignaturesTotal.inc({ result: 'error' });
        this.logger.warn(`cosignature mint failed for '${authority}': ${minted.reason}`);
        return;
      }
      const cosig = minted.cosignature;
      const row = await this.cosignatureRepo.record({
        tenantId,
        witnessId: cosig.witness_id,
        registryAuthority: authority,
        logId: cosig.witnessed_checkpoint.log_id,
        treeSize: cosig.witnessed_checkpoint.tree_size,
        rootHash: cosig.witnessed_checkpoint.root_hash,
        timestamp: cosig.witnessed_checkpoint.timestamp,
        witnessedAt: cosig.witnessed_at,
        keyId: cosig.signature.key_id,
        cosignatureHash: minted.cosignatureHash,
        signatureValue: cosig.signature.value,
        cosignature: cosig as unknown as Record<string, unknown>,
      });
      this.instrumentation.logCosignaturesTotal.inc({
        result: row === null ? 'duplicate' : 'minted',
      });
      if (row !== null) {
        this.logger.log(
          `cosigned '${cosig.witnessed_checkpoint.log_id}' at size ` +
            `${cosig.witnessed_checkpoint.tree_size} (${minted.cosignatureHash})`,
        );
      }
    } catch (err) {
      this.instrumentation.logCosignaturesTotal.inc({ result: 'error' });
      this.logger.warn(`failed to persist cosignature for '${authority}': ${msgOf(err)}`);
    }
  }

  /** §9.3 step 3: both the log_id and the signing key must belong to the source authority. */
  private checkRegistryBinding(checkpoint: LogCheckpoint, expectedDid: string): string | null {
    const logDid = logIdRegistryDid(checkpoint.log_id);
    if (logDid !== expectedDid) {
      return `log_id registry DID '${logDid ?? ''}' != '${expectedDid}' (the authority the checkpoint was fetched from)`;
    }
    if (AcdpDid.stripFragment(checkpoint.signature.key_id) !== expectedDid) {
      return `signature.key_id '${checkpoint.signature.key_id}' is not a key of '${expectedDid}'`;
    }
    return null;
  }

  private async resolveBaseUrl(enrollment: RegistryEnrollment): Promise<string | null> {
    if (enrollment.baseUrl) return enrollment.baseUrl.replace(/\/$/, '');
    const known = await this.registryRepo.findByAuthority(
      enrollment.authority,
      enrollment.tenantId,
    );
    return known?.baseUrl ? known.baseUrl.replace(/\/$/, '') : null;
  }

  /**
   * Persist a dishonesty signal: evidence row(s) already written by the
   * caller; mark the cursor alerted (retained head untouched), count the
   * metric on EVERY detection, and emit SSE + outbound webhook only on the
   * transition into the alert (or a reason change) so a persistent condition
   * doesn't re-spam subscribers every sweep.
   */
  private async raiseAlert(
    tenantId: string,
    authority: string,
    reason: WitnessAlertReason,
    detail: Record<string, unknown>,
  ): Promise<WitnessOutcome> {
    this.instrumentation.logWitnessAlertsTotal.inc({ reason });
    this.instrumentation.logWitnessChecksTotal.inc({ result: 'alert' });
    this.logger.warn(
      `LOG WITNESS ALERT registry='${authority}' reason=${reason}: ${String(detail.error ?? '')}`,
    );
    const previous = await this.witnessRepo.markAlert({ tenantId, authority, reason, detail });

    const isTransition = !previous.wasAlerted || previous.previousReason !== reason;
    if (isTransition) {
      const ts = new Date().toISOString();
      const checkpoint = detail.checkpoint as Record<string, unknown> | null | undefined;
      const logId =
        checkpoint && typeof checkpoint.log_id === 'string' ? checkpoint.log_id : undefined;
      const streamEvent: AcdpStreamEvent = {
        type: LOG_WITNESS_ALERT_EVENT,
        ts,
        agentId: `did:web:${authority}`,
        registryAuthority: authority,
        derivedFrom: [],
        reason,
        ...(logId ? { logId } : {}),
      };
      this.streamHub.publishGlobal(streamEvent, tenantId);
      void this.webhookService.fireEvent(
        {
          event: LOG_WITNESS_ALERT_EVENT,
          runId: '',
          timestamp: ts,
          data: { registryAuthority: authority, reason, detail },
        },
        tenantId,
      );
    }
    return { authority, status: 'alert', reason };
  }

  private async persistCheckpointSafe(
    tenantId: string,
    authority: string,
    checkpoint: LogCheckpoint,
    signatureValid: boolean,
    consistencyOk: boolean | null,
  ): Promise<void> {
    try {
      await this.witnessRepo.recordCheckpoint({
        tenantId,
        registryAuthority: authority,
        logId: checkpoint.log_id,
        treeSize: checkpoint.tree_size,
        rootHash: checkpoint.root_hash,
        timestamp: checkpoint.timestamp,
        rawCheckpoint: checkpoint as unknown as Record<string, unknown>,
        signatureValid,
        consistencyOk,
      });
    } catch (err) {
      this.logger.warn(
        `failed to persist witnessed checkpoint for '${authority}': ${msgOf(err)}`,
      );
    }
  }

  private async recordFailureSafe(tenantId: string, authority: string): Promise<void> {
    this.instrumentation.logWitnessChecksTotal.inc({ result: 'error' });
    try {
      await this.witnessRepo.markFailure(tenantId, authority);
    } catch (err) {
      this.logger.warn(`failed to record witness failure for '${authority}': ${msgOf(err)}`);
    }
  }
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
