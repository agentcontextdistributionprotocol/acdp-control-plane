/**
 * Receipt ↔ transparency-log inclusion cross-check (ACDP 0.3.0 Tier 3,
 * RFC-ACDP-0012 §9.1) — the sibling sweep to ReceiptAuditService.
 *
 * For stored `context_published` events that carried a `registry_receipt`
 * from a registry advertising `acdp-registry-transparency-log`:
 *
 *   1. Reconstruct the §4 log leaf from OUR stored copy of the receipt
 *      (§9.1 step 1 — never from a registry echo). Every leaf field
 *      duplicates a receipt field; `receipt_hash` is recomputed here over
 *      the stored wire JSON (signature excluded, so the sanctioned
 *      RFC-ACDP-0010 §9 re-mint never changes it).
 *   2. Fetch `GET /log/proof?ctx_id=…` through the SSRF-gated federation
 *      client.
 *   3. Verify the embedded checkpoint per §9.3 (closed parse, registry
 *      binding, skew, signature against the resolved receipt key), then —
 *      when this control plane's checkpoint witness has already witnessed a
 *      head at the same (log_id, tree_size) — require the proof's checkpoint
 *      root to MATCH the witnessed root (a proof quietly riding a different
 *      checkpoint at a size we witnessed is split-view evidence).
 *   4. Fold the §9.1 audit path from the reconstructed leaf hash and compare
 *      against the checkpoint root.
 *
 * Verdicts (sealed once per event in `log_inclusion_audits`, independent of
 * the receipt verdict per §9.3):
 *   - `included`      — inclusion verified against a signature-valid checkpoint
 *   - `invalid_proof` — a §9 check failed (the `invalid_log_proof` semantic;
 *                       details carry ErrorCode.INVALID_LOG_PROOF)
 *   - `not_logged`    — the registry served 404 for a ctx_id it minted a
 *                       receipt for: §3 omission evidence (the receipt proves
 *                       acceptance; the missing proof proves the log lie)
 *   - `no_log`        — registry does not advertise the profile (nothing owed)
 *   - `error`         — environmental; the audit could not complete
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AcdpDid } from 'acdp';
import { AppConfigService } from '../config/app-config.service';
import { SafeFederationClient } from '../contexts/safe-federation-client';
import { DatabaseService } from '../db/database.service';
import { ContextEvent, NewLogInclusionAudit } from '../db/schema';
import { DidWebResolverService } from '../auth/did-web/did-web-resolver.service';
import { ErrorCode } from '../errors/error-codes';
import { LogInclusionAuditRepository } from '../storage/log-inclusion-audit.repository';
import { LogWitnessRepository } from '../storage/log-witness.repository';
import { RegistryRepository } from '../storage/registry.repository';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import {
  buildLogLeaf,
  checkpointTimestampOk,
  leafHash,
  logIdRegistryDid,
  parseCheckpoint,
  parseInclusionProof,
  verifyCheckpointSignature,
  verifyInclusionPath,
} from './log-verify';
import { RegistryProfileService, TRANSPARENCY_LOG_PROFILE } from './registry-profile.service';

const ADVISORY_LOCK_KEY = 'acdp-cp-log-inclusion-audit';

export interface InclusionVerdict {
  status: 'included' | 'invalid_proof' | 'not_logged' | 'no_log' | 'error';
  detail: string[];
  logId: string | null;
  leafIndex: number | null;
  treeSize: number | null;
}

@Injectable()
export class LogInclusionAuditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LogInclusionAuditService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly database: DatabaseService,
    private readonly auditRepo: LogInclusionAuditRepository,
    private readonly witnessRepo: LogWitnessRepository,
    private readonly registryRepo: RegistryRepository,
    private readonly profiles: RegistryProfileService,
    private readonly federationClient: SafeFederationClient,
    private readonly didResolver: DidWebResolverService,
    private readonly instrumentation: InstrumentationService,
  ) {}

  onModuleInit(): void {
    if (!this.config.logInclusionAuditEnabled) return;
    const intervalMs = this.config.logInclusionAuditIntervalSeconds * 1000;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) =>
        this.logger.warn(`log-inclusion audit sweep failed: ${msgOf(err)}`),
      );
    }, intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
    this.logger.log(
      `log-inclusion audit enabled: interval=${this.config.logInclusionAuditIntervalSeconds}s ` +
        `batch=${this.config.logInclusionAuditBatchSize} ` +
        `lookback=${this.config.logInclusionAuditLookbackHours}h`,
    );
    void this.sweep().catch((err) =>
      this.logger.warn(`initial log-inclusion audit sweep failed: ${msgOf(err)}`),
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
      this.logger.debug('log-inclusion audit sweep skipped — another instance holds the lock');
      return 0;
    }
    try {
      const since = new Date(
        Date.now() - this.config.logInclusionAuditLookbackHours * 60 * 60 * 1000,
      ).toISOString();
      const events = await this.auditRepo.findUnauditedReceiptPublishes(
        since,
        this.config.logInclusionAuditBatchSize,
      );
      for (const ev of events) {
        const verdict = await this.auditEvent(ev);
        await this.auditRepo.record(this.toRow(ev, verdict));
        this.instrumentation.logInclusionAuditsTotal.inc({ status: verdict.status });
        if (verdict.status === 'invalid_proof' || verdict.status === 'not_logged') {
          this.logger.warn(
            `log-inclusion ${verdict.status} ctx=${ev.ctxId ?? '?'} ` +
              `registry=${ev.registryAuthority}: ${verdict.detail.join('; ')}`,
          );
        }
      }
      return events.length;
    } finally {
      await this.database.advisoryUnlock(ADVISORY_LOCK_KEY);
    }
  }

  /** Audit one publish event. Never throws — failures become verdicts. */
  async auditEvent(ev: ContextEvent): Promise<InclusionVerdict> {
    try {
      return await this.auditEventInner(ev);
    } catch (err) {
      return verdict('error', [`unverified: audit crashed: ${msgOf(err)}`]);
    }
  }

  private async auditEventInner(ev: ContextEvent): Promise<InclusionVerdict> {
    const authority = ev.registryAuthority;
    const receipt =
      ev.rawPayload['registry_receipt'] !== null &&
      typeof ev.rawPayload['registry_receipt'] === 'object'
        ? (ev.rawPayload['registry_receipt'] as Record<string, unknown>)
        : undefined;
    if (!receipt) {
      // receipt_present said otherwise — treat as environmental, not a flag.
      return verdict('error', ['unverified: event has no stored registry_receipt']);
    }
    if (!ev.ctxId) {
      return verdict('error', ['unverified: event has no ctx_id to prove']);
    }

    const advertises = await this.profiles.advertisesTransparencyLog(authority, ev.tenantId);
    if (advertises === false) {
      return verdict('no_log', []);
    }
    if (advertises === null) {
      return verdict('error', [`unverified: capabilities for '${authority}' unreadable`]);
    }

    const registry = await this.registryRepo.findByAuthority(authority, ev.tenantId);
    if (!registry?.baseUrl) {
      return verdict('error', [`unverified: no base_url known for '${authority}'`]);
    }
    const baseUrl = registry.baseUrl.replace(/\/$/, '');

    // §9.1 step 1: reconstruct the leaf from OUR stored receipt.
    const leafBuild = buildLogLeaf(receipt);
    if (!leafBuild.ok) {
      return verdict('error', [`unverified: leaf reconstruction failed: ${leafBuild.reason}`]);
    }

    // §8.2 inclusion mode, the consumer surface: by ctx_id.
    let proofRaw: unknown;
    try {
      const url = `${baseUrl}/log/proof?ctx_id=${encodeURIComponent(ev.ctxId)}`;
      const resp = await this.federationClient.get(url);
      if (resp.status === 404) {
        // The registry advertises the log AND minted this receipt (we hold
        // it), yet cannot prove inclusion: §3 — "the receipt proves
        // acceptance; the missing inclusion proof proves the log lie".
        return verdict('not_logged', [
          `registry advertises ${TRANSPARENCY_LOG_PROFILE} and minted a receipt for ` +
            `'${ev.ctxId}' but served not_found for its inclusion proof (RFC-ACDP-0012 §3 omission evidence)`,
        ]);
      }
      if (resp.status < 200 || resp.status >= 300) {
        return verdict('error', [`unverified: /log/proof returned HTTP ${resp.status}`]);
      }
      proofRaw = JSON.parse(resp.body);
    } catch (err) {
      return verdict('error', [`unverified: proof fetch failed: ${msgOf(err)}`]);
    }

    const parsedProof = parseInclusionProof(proofRaw);
    if (!parsedProof.ok) {
      return verdict('invalid_proof', [
        `${ErrorCode.INVALID_LOG_PROOF}: ${parsedProof.reason}`,
      ]);
    }
    const proof = parsedProof.proof;

    // ── §9.3 on the embedded checkpoint ───────────────────────────────────
    const parsedCp = parseCheckpoint(proof.log_checkpoint);
    if (!parsedCp.ok) {
      return verdict(
        'invalid_proof',
        [`${ErrorCode.INVALID_LOG_PROOF}: checkpoint: ${parsedCp.reason}`],
        proof,
      );
    }
    const checkpoint = parsedCp.checkpoint;
    const expectedDid = `did:web:${authority}`;
    if (logIdRegistryDid(checkpoint.log_id) !== expectedDid) {
      return verdict(
        'invalid_proof',
        [
          `${ErrorCode.INVALID_LOG_PROOF}: checkpoint log_id '${checkpoint.log_id}' is not bound to '${expectedDid}'`,
        ],
        proof,
      );
    }
    if (AcdpDid.stripFragment(checkpoint.signature.key_id) !== expectedDid) {
      return verdict(
        'invalid_proof',
        [
          `${ErrorCode.INVALID_LOG_PROOF}: checkpoint signature.key_id '${checkpoint.signature.key_id}' is not a key of '${expectedDid}'`,
        ],
        proof,
      );
    }
    const skew = checkpointTimestampOk(checkpoint);
    if (!skew.ok) {
      return verdict('invalid_proof', [`${ErrorCode.INVALID_LOG_PROOF}: ${skew.reason}`], proof);
    }

    let registryKeyB64: string;
    try {
      const resolved = await this.didResolver.resolveReceiptKey(
        checkpoint.signature.key_id,
        'ed25519',
      );
      registryKeyB64 = resolved.publicKeyB64;
    } catch (err) {
      return verdict('error', [
        `unverified: registry receipt key resolution failed: ${msgOf(err)}`,
      ]);
    }
    const sigVerdict = verifyCheckpointSignature(checkpoint, registryKeyB64);
    if (!sigVerdict.ok) {
      return verdict(
        'invalid_proof',
        [`${ErrorCode.INVALID_LOG_PROOF}: ${sigVerdict.reason}`],
        proof,
      );
    }

    // ── §9.1 step 4: proof ↔ checkpoint binding ──────────────────────────
    if (
      proof.log_id !== checkpoint.log_id ||
      proof.tree_size !== checkpoint.tree_size ||
      proof.leaf_index >= proof.tree_size
    ) {
      return verdict(
        'invalid_proof',
        [
          `${ErrorCode.INVALID_LOG_PROOF}: proof/checkpoint binding failed ` +
            `(log_id, tree_size equality; leaf_index < tree_size)`,
        ],
        proof,
      );
    }

    // Witness cross-binding: if OUR checkpoint witness saw a head at this
    // exact (log_id, tree_size), the proof's checkpoint must carry the same
    // root — otherwise the registry is showing this consumer a different
    // tree than it showed the witness (split view).
    const witnessed = await this.witnessRepo.findByLogIdAndSize(
      checkpoint.log_id,
      checkpoint.tree_size,
    );
    if (witnessed && witnessed.rootHash !== checkpoint.root_hash) {
      return verdict(
        'invalid_proof',
        [
          `${ErrorCode.INVALID_LOG_PROOF}: proof checkpoint root '${checkpoint.root_hash}' diverges ` +
            `from the witnessed root '${witnessed.rootHash}' at (log_id='${checkpoint.log_id}', ` +
            `tree_size=${checkpoint.tree_size}) — split-view evidence`,
        ],
        proof,
      );
    }

    // ── §9.1 steps 2, 5, 6: hash the reconstructed leaf, fold, compare ───
    const leafH = leafHash(leafBuild.leaf);
    if (leafH === null) {
      return verdict('error', ['unverified: reconstructed leaf could not be canonicalized']);
    }
    const fold = verifyInclusionPath(
      proof.leaf_index,
      proof.tree_size,
      leafH,
      proof.inclusion_path,
      checkpoint.root_hash,
    );
    if (!fold.ok) {
      return verdict('invalid_proof', [`${ErrorCode.INVALID_LOG_PROOF}: ${fold.reason}`], proof);
    }

    return verdict('included', [], proof);
  }

  private toRow(ev: ContextEvent, v: InclusionVerdict): NewLogInclusionAudit {
    return {
      eventId: ev.id,
      tenantId: ev.tenantId,
      runId: ev.runId,
      ctxId: ev.ctxId,
      registryAuthority: ev.registryAuthority,
      logId: v.logId,
      leafIndex: v.leafIndex,
      treeSize: v.treeSize,
      status: v.status,
      detail: v.detail,
    };
  }
}

function verdict(
  status: InclusionVerdict['status'],
  detail: string[],
  proof?: { log_id: string; leaf_index: number; tree_size: number },
): InclusionVerdict {
  return {
    status,
    detail,
    logId: proof?.log_id ?? null,
    leafIndex: proof?.leaf_index ?? null,
    treeSize: proof?.tree_size ?? null,
  };
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
