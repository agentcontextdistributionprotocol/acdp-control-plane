/**
 * Producer key-revocation discovery + verification (RFC-ACDP-0014, ACDP
 * 0.3.0) — the control plane as an independent verifier of `key-revocation`
 * contexts, off unless `KEY_REVOCATION_CHECK_ENABLED` (which itself requires
 * `RECEIPT_AUDIT_ENABLED=true`, enforced at boot by `AppConfigService`).
 *
 * A background sweep (advisory-locked, like the other audit sweeps) picks up
 * `context_events` rows whose `context_type` is either RFC-ACDP-0014
 * spelling (`key-revocation` or the pre-0.3.0 interim `acdp:key-revocation`
 * — both standard protocol types, never domain-pack-gated; see
 * `src/contracts/revocation.ts`) and that have no verified fact yet
 * (`KeyRevocationRepository.findCandidates`). Discovery is by `context_type`
 * alone: the registry's webhook envelope carries no `metadata` member at
 * all, so there is nothing to project `revoked_key_fingerprint` /
 * `compromised_since` from at ingest time — the sweep fetches the body
 * through `SafeFederationClient` to learn the actual fingerprint and
 * boundary.
 *
 * For each candidate, the pipeline mirrors the SDK reference client's
 * `verify_revocation_body` step for step:
 *
 *   1. Fetch the `FullContext` via the SSRF-gated federation client (same
 *      shape as `receipt-audit.service.ts`'s own fetch).
 *   1.5. `verifyCtxIdBinding` — the registry served the ctx_id that was
 *        requested, not a substituted one (RFC-ACDP-0006 §4.1 step 7). Not
 *        exercised by receipt audit (whose `verifyReceipt` call already
 *        binds `expectedCtxId` internally); this pipeline has no such
 *        all-in-one call, so the check is run explicitly.
 *   2. Recompute the content hash (`verifyContentHash`) — never trust the
 *      echoed value.
 *   3. Verify the body signature: `did:key` via `verifyBodyOffline`
 *      (which also enforces `signature.key_id`'s DID portion equals
 *      `agent_id`, `acdp-verify/src/lib.rs:305-316`); `did:web` by checking
 *      that same DID-equals-`agent_id` binding explicitly (the resolver has
 *      no opinion on which agent a key belongs to — only the caller knows
 *      the expected `agent_id`), resolving `signature.key_id` through
 *      `DidWebResolverService.resolveKey` (the STRICT `assertionMethod`
 *      gate — §5 step 1 requires the signing key be currently authorized),
 *      and verifying with `verifySignatureB64` over the proven `content_hash`
 *      string (RFC-ACDP-0001 §5.8's signing input — never the raw body
 *      JSON).
 *   4. Compute the signer's RFC-ACDP-0010 §6 fingerprint
 *      (`fingerprintEd25519B64`) and pass it to `parseKeyRevocation` — see
 *      that module's doc comment for why this argument is never optional
 *      here, for EITHER DID method.
 *   5. For a `registry_attested` result, run `crossCheckRegistryBinding`
 *      (RFC-ACDP-0014 §6) against the serving authority + its advertised
 *      `capabilities.registry_did`.
 *   6. Persist.
 *
 * **Persistence-time policy for `KEY_REVOCATION_ATTESTED_SCOPE`.** Only the
 * §6 binding-check OUTCOME (pass/fail) gates persistence here, REGARDLESS of
 * the configured scope (`same_registry` | `global` | `off`): a binding
 * failure means the fact isn't even authenticated as coming from the
 * registry it claims to, so it is not evidence worth storing (same
 * treatment as a bad signature). A binding PASS is persisted under every
 * scope value — `KEY_REVOCATION_IGNORE_FINGERPRINTS`, and by the same
 * "record the evidence even when we decline to act on it" principle,
 * `KEY_REVOCATION_ATTESTED_SCOPE`'s reach (same-registry vs. global vs.
 * never-applied) is a downstream CLASSIFICATION-time policy, not a
 * persistence-time one — logged to ASSUMPTIONS.md, since the plan's own
 * prose reads either way and this reconciles the two literal acceptance
 * criteria (6/7) with the plan's stated evidence-recording principle.
 *
 * **Failure discipline** (revised from the plan's first draft — see
 * `plans/rfc-0014-0015-upgrade.md`, Phase 12 divergence note #7): a body
 * that fails verification PERMANENTLY (bad signature, hash mismatch, §4/§5
 * rejection, a ctx_id substitution) counts `status="invalid"`. A body that
 * could not even be FETCHED or DID-resolved (registry down, DID host
 * unreachable, timeout) is TRANSIENT — `status="unavailable"`.
 *
 * **Both classes share ONE candidate window**, `KEY_REVOCATION_LOOKBACK_HOURS`
 * (default 720h = 30 days) — deliberately NOT the narrower 24h
 * `RECEIPT_AUDIT_LOOKBACK_HOURS`, because losing a revocation to a one-day
 * registry outage is a severe, silent, PERMANENT loss (§4: revocations are
 * irreversible). There is no separate, narrower window for permanent
 * failures, and no "processed" marker table distinguishing "never checked"
 * from "checked and permanently rejected" — `KeyRevocationRepository.findCandidates`
 * re-selects EVERY not-yet-persisted candidate every sweep, permanent and
 * transient alike, until it either verifies or ages out of the one shared
 * window. This is a deliberate simplification, not the two-window split a
 * literal reading of the plan's revised Edge-cases text describes — see the
 * divergence note for the cost (repeated re-fetches of an already-known-bad
 * revocation for up to 30 days instead of 24h) and why a real fix needs a
 * persisted per-candidate verdict, which this phase does not add.
 *
 * The transient/permanent classification used here for `FederationFetchError`
 * / `DidResolutionError` / HTTP-status bands (the three private functions at
 * the bottom of this file — `classifyFederationFetchError`,
 * `classifyDidResolutionError`, `classifyHttpStatus`) is LOCAL and TEMPORARY:
 * the same table (by the plan's own account) is Phase 13's
 * `classifyLineageFailure` (`src/audit/revocation-lineage.ts`), built for the
 * §7 lineage walk. Once that lands, these three functions must be deleted
 * and this sweep must import the shared function instead — "reuse it, do not
 * write a second one" — rather than building it early against a
 * Phase-13-owned API shape this phase cannot yet know.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AcdpDid } from '@agentcontextdistributionprotocol/acdp';
import { verifySignatureB64 } from '../auth/acdp-verify';
import { DidResolutionError, DidWebResolverService } from '../auth/did-web/did-web-resolver.service';
import { decodeEd25519Multibase } from '../common/multibase';
import { AppConfigService } from '../config/app-config.service';
import { FederationFetchError, SafeFederationClient } from '../contexts/safe-federation-client';
import { DatabaseService } from '../db/database.service';
import { ContextEvent, NewKeyRevocation } from '../db/schema';
import { KeyRevocationRepository } from '../storage/key-revocation.repository';
import { RegistryRepository } from '../storage/registry.repository';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { crossCheckRegistryBinding } from './revocation-binding';
import {
  fingerprintEd25519B64,
  verifyBodyOffline,
  verifyContentHash,
  verifyCtxIdBinding,
} from './receipt-verify';
import { ParsedRevocation, parseKeyRevocation, sdkSupportsRevocations } from './revocation-verify';
import { RegistryProfileService } from './registry-profile.service';

const ADVISORY_LOCK_KEY = 'acdp-cp-key-revocation-audit';

type Status = 'verified' | 'invalid' | 'unavailable';

interface Outcome {
  status: Status;
  trustClass: 'producer_signed' | 'registry_attested' | 'unknown';
  reason?: string;
  revocation?: ParsedRevocation;
  body?: Record<string, unknown>;
}

@Injectable()
export class RevocationAuditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RevocationAuditService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly database: DatabaseService,
    private readonly revocationRepo: KeyRevocationRepository,
    private readonly registryRepo: RegistryRepository,
    private readonly profiles: RegistryProfileService,
    private readonly federationClient: SafeFederationClient,
    private readonly didResolver: DidWebResolverService,
    private readonly instrumentation: InstrumentationService,
  ) {}

  onModuleInit(): void {
    if (!this.config.keyRevocationCheckEnabled) return;
    if (!sdkSupportsRevocations()) {
      this.logger.warn(
        'key-revocation check enabled but the installed acdp SDK has no parseKeyRevocation ' +
          '(pinned floor is >= 0.14.1; a mis-resolved native optionalDependency looks like this) ' +
          '— the revocation sweep cannot run',
      );
      return;
    }
    // Rides RECEIPT_AUDIT_INTERVAL_SECONDS / RECEIPT_AUDIT_BATCH_SIZE for
    // cadence and batch size: KEY_REVOCATION_CHECK_ENABLED already requires
    // RECEIPT_AUDIT_ENABLED=true, so both are guaranteed present and
    // validated (>= 5s, >= 1) whenever this sweep can run at all, and the
    // plan gives this phase no knobs of its own for cadence — only for the
    // candidate WINDOW (KEY_REVOCATION_LOOKBACK_HOURS), which is
    // deliberately wider and independent (see file header).
    const intervalMs = this.config.receiptAuditIntervalSeconds * 1000;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) =>
        this.logger.warn(
          `key-revocation sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
    this.logger.log(
      `key-revocation check enabled: interval=${this.config.receiptAuditIntervalSeconds}s ` +
        `batch=${this.config.receiptAuditBatchSize} lookback=${this.config.keyRevocationLookbackHours}h ` +
        `attestedScope=${this.config.keyRevocationAttestedScope}`,
    );
    void this.sweep().catch((err) =>
      this.logger.warn(
        `initial key-revocation sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One sweep pass. Multi-instance safe via a Postgres advisory lock. */
  async sweep(): Promise<number> {
    const acquired = await this.database.tryAdvisoryLock(ADVISORY_LOCK_KEY);
    if (!acquired) {
      this.logger.debug('key-revocation sweep skipped — another instance holds the lock');
      return 0;
    }
    try {
      const since = new Date(
        Date.now() - this.config.keyRevocationLookbackHours * 60 * 60 * 1000,
      ).toISOString();
      const candidates = await this.revocationRepo.findCandidates(
        since,
        this.config.receiptAuditBatchSize,
      );
      for (const ev of candidates) {
        const outcome = await this.verifyEvent(ev);
        this.instrumentation.keyRevocationChecksTotal.inc({
          status: outcome.status,
          trust_class: outcome.trustClass,
        });
        if (outcome.status === 'invalid') {
          this.logger.warn(
            `key-revocation rejected ctx=${ev.ctxId ?? '?'} registry=${ev.registryAuthority}: ${outcome.reason ?? ''}`,
          );
          continue;
        }
        if (outcome.status === 'unavailable') {
          this.logger.debug(
            `key-revocation unverifiable this pass ctx=${ev.ctxId ?? '?'}: ${outcome.reason ?? ''}`,
          );
          continue;
        }
        // status === 'verified'
        const revocation = outcome.revocation!;
        const body = outcome.body!;
        await this.revocationRepo.record({
          tenantId: ev.tenantId,
          ctxId: ev.ctxId!,
          revokedKeyFingerprint: revocation.revokedKeyFingerprint,
          compromisedSince: revocation.compromisedSince,
          revokedKeyController: revocation.revokedKeyController,
          publisher: revocation.publisher,
          trustClass: revocation.trustClass,
          revokedKeyId: revocation.revokedKeyId,
          reason: revocation.reason,
          lineageId: strOf(body['lineage_id']) ?? ev.lineageId ?? '',
          // The body's OWN origin_registry claim — outside content_hash/
          // signature coverage, so unauthenticated (proven by the
          // integration fixtures, which merge it in post-signing). This is
          // the RFC-ACDP-0001 "where this lineage originated" field, not the
          // registry actually reached — a Phase 14+ same_registry scope
          // decision must key off `ev.registryAuthority` (the authenticated,
          // actually-reached authority), never this column.
          originAuthority: strOf(body['origin_registry']) ?? ev.registryAuthority,
          contextType: ev.contextType ?? '',
        } satisfies NewKeyRevocation);
      }
      return candidates.length;
    } finally {
      await this.database.advisoryUnlock(ADVISORY_LOCK_KEY);
    }
  }

  /**
   * Verify one candidate event. Never throws — failures become outcomes.
   * Public so `sweep()` and tests can drive it directly (mirrors
   * `ReceiptAuditService.auditEvent`).
   */
  async verifyEvent(ev: ContextEvent): Promise<Outcome> {
    try {
      return await this.verifyEventInner(ev);
    } catch (err) {
      // A crash here is a defect in OUR pipeline (or an unexpected shape),
      // never proof the registry misbehaved — classified `unavailable`
      // (retried on a later sweep) rather than `invalid` (which would
      // permanently give up on a possibly-real revocation over a bug).
      return {
        status: 'unavailable',
        trustClass: 'unknown',
        reason: `unverified: audit crashed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async verifyEventInner(ev: ContextEvent): Promise<Outcome> {
    if (!ev.ctxId) {
      return { status: 'invalid', trustClass: 'unknown', reason: 'event has no ctx_id' };
    }

    const registry = await this.registryRepo.findByAuthority(ev.registryAuthority, ev.tenantId);
    if (!registry?.baseUrl) {
      return {
        status: 'unavailable',
        trustClass: 'unknown',
        reason: `no base_url known for '${ev.registryAuthority}'`,
      };
    }

    // ── 1. Fetch ──────────────────────────────────────────────────────────
    let resp;
    try {
      const url = `${registry.baseUrl.replace(/\/$/, '')}/contexts/${encodeURIComponent(ev.ctxId)}`;
      resp = await this.federationClient.get(url);
    } catch (err) {
      if (err instanceof FederationFetchError) {
        return {
          status: classifyFederationFetchError(err.code) === 'transient' ? 'unavailable' : 'invalid',
          trustClass: 'unknown',
          reason: `context fetch failed (${err.code}): ${err.message}`,
        };
      }
      return {
        status: 'unavailable',
        trustClass: 'unknown',
        reason: `context fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (resp.status < 200 || resp.status >= 300) {
      return {
        status: classifyHttpStatus(resp.status) === 'transient' ? 'unavailable' : 'invalid',
        trustClass: 'unknown',
        reason: `context fetch returned HTTP ${resp.status}`,
      };
    }
    let body: Record<string, unknown>;
    try {
      const full = JSON.parse(resp.body) as { body?: unknown };
      if (full.body === null || typeof full.body !== 'object') {
        return { status: 'invalid', trustClass: 'unknown', reason: 'retrieval response has no body member' };
      }
      body = full.body as Record<string, unknown>;
    } catch (err) {
      return {
        status: 'invalid',
        trustClass: 'unknown',
        reason: `retrieval response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const bodyJson = JSON.stringify(body);

    // ── 1.5. ctx_id binding (RFC-ACDP-0006 §4.1 step 7) ─────────────────────
    // Fail closed on EITHER outcome kind — same polarity as the one other
    // caller of this check, contexts.controller.ts's federation proxy: an
    // unestablished binding must never be treated as "fine, continue",
    // because ctx_id sits outside content_hash/signature coverage
    // (RFC-ACDP-0001 §5.7) and is the only defense against a validly-signed
    // body served under a substituted identity. Only the REASON differs by
    // kind — a genuine 'mismatch' is reported as substitution; an
    // 'unverifiable' throw (the SDK's strict Body parse rejected the body,
    // or the installed binding lacks the method) is reported as such, never
    // upgraded into an unfounded substitution accusation.
    const binding = verifyCtxIdBinding(bodyJson, ev.ctxId);
    if (!binding.ok) {
      return {
        status: 'invalid',
        trustClass: 'unknown',
        reason:
          binding.kind === 'mismatch'
            ? `ctx_id substitution: ${binding.reason}`
            : `ctx_id binding unverifiable: ${binding.reason}`,
      };
    }

    // ── 2. Content hash ──────────────────────────────────────────────────
    const echoedHash = strOf(body['content_hash']);
    if (!echoedHash) {
      return { status: 'invalid', trustClass: 'unknown', reason: 'retrieved body has no content_hash' };
    }
    const hashCheck = verifyContentHash(bodyJson, echoedHash);
    if (!hashCheck.ok) {
      return { status: 'invalid', trustClass: 'unknown', reason: `content_hash_mismatch: ${hashCheck.reason}` };
    }

    // ── 3./4. Signature + signer fingerprint ────────────────────────────
    const agentId = strOf(body['agent_id']) ?? '';
    let signerFingerprint: string;
    if (agentId.startsWith('did:key:')) {
      const offline = verifyBodyOffline(bodyJson);
      if (!offline.ok) {
        return { status: 'invalid', trustClass: 'unknown', reason: `body_signature_invalid: ${offline.reason}` };
      }
      const decoded = decodeEd25519Multibase(agentId);
      if (!decoded.ok) {
        return { status: 'invalid', trustClass: 'unknown', reason: `undecodable did:key agent_id: ${decoded.reason}` };
      }
      signerFingerprint = fingerprintEd25519B64(decoded.publicKey.toString('base64'));
    } else if (agentId.startsWith('did:web:')) {
      const sig =
        body['signature'] !== null && typeof body['signature'] === 'object'
          ? (body['signature'] as Record<string, unknown>)
          : undefined;
      const keyId = strOf(sig?.['key_id']);
      const sigValue = strOf(sig?.['value']);
      const algorithm = strOf(sig?.['algorithm']);
      if (!keyId || !sigValue) {
        return { status: 'invalid', trustClass: 'unknown', reason: 'body signature missing key_id/value' };
      }
      if (!keyId.includes('#') || keyId.endsWith('#')) {
        return { status: 'invalid', trustClass: 'unknown', reason: `signature.key_id '${keyId}' has no non-empty #fragment` };
      }
      // The resolver has no opinion on which agent a key belongs to — only
      // the caller knows the expected agent_id (acdp-verify/src/lib.rs's
      // `verify_signature_envelope` step 2, hand-transliterated: no SDK
      // surface exposes this binding for a did:web body independent of a
      // receipt).
      if (AcdpDid.stripFragment(keyId) !== agentId) {
        return {
          status: 'invalid',
          trustClass: 'unknown',
          reason: `key_not_authorized: signature.key_id DID '${AcdpDid.stripFragment(keyId)}' != agent_id '${agentId}'`,
        };
      }
      // No P-256 fingerprint helper exists in the SDK (same gap
      // receipt-audit.service.ts documents) — a revocation body has no
      // independent claimed fingerprint to fall back on the way a receipt
      // does, so an ecdsa-p256 signer cannot be verified at all here. Fail
      // closed as unavailable (a capability gap, not a rejection) rather
      // than silently skipping. This is only HALF of the P-256 story — a
      // did:key P-256 signer never reaches this branch at all (it is
      // rejected earlier, as `invalid`, by decodeEd25519Multibase's
      // multicodec check) — see ASSUMPTIONS.md §"ecdsa-p256 revocation
      // signers are inconsistently, and only partially, handled".
      if (algorithm && algorithm !== 'ed25519') {
        return {
          status: 'unavailable',
          trustClass: 'unknown',
          reason: `producer algorithm '${algorithm}' has no SDK fingerprint helper for revocation verification`,
        };
      }
      let resolved;
      try {
        resolved = await this.didResolver.resolveKey(keyId, 'ed25519');
      } catch (err) {
        if (err instanceof DidResolutionError) {
          return {
            status: classifyDidResolutionError(err.code) === 'transient' ? 'unavailable' : 'invalid',
            trustClass: 'unknown',
            reason: `signer key resolution failed (${err.code}): ${err.message}`,
          };
        }
        return {
          status: 'unavailable',
          trustClass: 'unknown',
          reason: `signer key resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!verifySignatureB64('ed25519', resolved.publicKeyB64, echoedHash, sigValue)) {
        return { status: 'invalid', trustClass: 'unknown', reason: 'body_signature_invalid: signature verification failed' };
      }
      signerFingerprint = fingerprintEd25519B64(resolved.publicKeyB64);
    } else {
      return {
        status: 'invalid',
        trustClass: 'unknown',
        reason: `key-revocation bodies require a did:web or did:key agent_id; got '${agentId}'`,
      };
    }

    // ── 4b. Parse + shape-validate + §5 step 2 ──────────────────────────
    const parsed = parseKeyRevocation(bodyJson, signerFingerprint);
    if (!parsed.ok) {
      return { status: 'invalid', trustClass: 'unknown', reason: `${parsed.code}: ${parsed.reason}` };
    }
    const revocation = parsed.revocation;

    // ── 5. §6 registry-binding policy (registry_attested only) ─────────
    if (revocation.trustClass === 'registry_attested') {
      const caps = await this.profiles.registryCapabilities(ev.registryAuthority, ev.tenantId);
      if (caps.registryDid === null) {
        return {
          status: 'unavailable',
          trustClass: 'registry_attested',
          reason: `capabilities for '${ev.registryAuthority}' are unreadable — cannot run the §6 binding check`,
        };
      }
      const check = crossCheckRegistryBinding(revocation.publisher, ev.registryAuthority, caps.registryDid);
      if (!check.ok) {
        return { status: 'invalid', trustClass: 'registry_attested', reason: check.reason };
      }
    }

    return { status: 'verified', trustClass: revocation.trustClass, revocation, body };
  }
}

/** See the file header — TEMPORARY, must be replaced by Phase 13's `classifyLineageFailure`. */
function classifyFederationFetchError(code: FederationFetchError['code']): 'transient' | 'permanent' {
  return code === 'FETCH' ? 'transient' : 'permanent';
}

/** See the file header — TEMPORARY, must be replaced by Phase 13's `classifyLineageFailure`. */
function classifyDidResolutionError(code: DidResolutionError['code']): 'transient' | 'permanent' {
  return code === 'FETCH' || code === 'STATUS' ? 'transient' : 'permanent';
}

/** See the file header — TEMPORARY, must be replaced by Phase 13's `classifyLineageFailure`. */
function classifyHttpStatus(status: number): 'transient' | 'permanent' {
  return status === 429 || status === 408 || (status >= 500 && status <= 599) ? 'transient' : 'permanent';
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
