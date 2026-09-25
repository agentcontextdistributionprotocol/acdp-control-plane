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
 * `plans/rfc-0014-0015-upgrade.md`, Phase 12 divergence note #7; extended to
 * a third bucket by issue #170 / `plans/revocation-lineage-p256-status.md`):
 * a body that fails verification PERMANENTLY (bad signature, hash mismatch,
 * §4/§5 rejection, a ctx_id substitution) counts `status="invalid"`. A body
 * that could not even be FETCHED or DID-resolved (registry down, DID host
 * unreachable, timeout) is TRANSIENT — `status="unavailable"`. A body whose
 * signer uses an algorithm this pipeline has no verification path for
 * (currently: ecdsa-p256 — no SDK fingerprint helper for a revocation body,
 * for EITHER DID method) is a CAPABILITY GAP, not a verification outcome —
 * `status="unsupported"`. This third bucket exists because the other two are
 * both wrong for it: `"invalid"` would misreport a body whose signature may
 * be genuinely valid (confirmed empirically for did:key ecdsa-p256, which
 * offline-verifies before being dropped at the multibase-decode step) as
 * malformed, and `"unavailable"` would ABORT THE ENTIRE §7 lineage walk
 * (Rule 3, `revocation-lineage.ts`) on any lineage containing even one
 * unsupported-algorithm member — fail-open for every Ed25519 fact sharing
 * that lineage. `"unsupported"` drops only the one candidate/member, same as
 * `"invalid"`, but is logged and counted distinguishably so an operator can
 * tell "we rejected this" apart from "we cannot currently verify this at
 * all" (see ASSUMPTIONS.md §"ecdsa-p256 revocation signers").
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
 * The transient/permanent classification for `FederationFetchError` /
 * `DidResolutionError` / HTTP-status bands is `classifyLineageFailure`
 * (`src/audit/revocation-lineage.ts`) — one shared table for both this
 * per-event fetch and the §7 lineage walk below, not two drifting copies.
 * Its three-way result (`'transient' | 'permanent' | 'hard'`) collapses to
 * two of this file's four `Outcome.status` values (`'unavailable'` |
 * `'invalid'` — never `'unsupported'`, a capability gap distinct from any
 * fetch/DID-resolution outcome) via `toStatus` at the bottom: `'hard'`
 * (a response too large to trust) gets the same `'invalid'` treatment as
 * `'permanent'` here, because a single oversized context body is simply
 * unusable evidence, not a lineage that must never be silently truncated —
 * that distinction only matters for the lineage walk itself.
 *
 * ## The §7 lineage walk (RFC-ACDP-0014 §7, Phase 13)
 *
 * Discovering one revocation via a webhook only proves that ONE context
 * exists — §4's earliest-`compromised_since` rule is defined over the whole
 * lineage, including members the control plane was never webhooked about
 * (published before enrollment, or belonging to a producer's earlier key).
 * After persisting a freshly-verified event's own fact, `sweep()` walks that
 * revocation's lineage (`walkRevocationLineage`, `revocation-lineage.ts`) via
 * `GET /lineages/{lineage_id}` and persists every OTHER verified revocation
 * member it finds, reusing the exact same `verifyRevocationBody` pipeline
 * (steps 2-5 below) so a lineage-discovered member gets identical scrutiny
 * to a webhook-discovered one.
 *
 * **When a lineage gets walked.** Gated by `KeyRevocationLineageCursor`, a
 * TTL-bounded freshness marker (`KEY_REVOCATION_LINEAGE_CURSOR_TTL_HOURS`,
 * default 1h to match the DID resolver's own cache duration) — but a
 * cursor ALONE is never sufficient to skip a walk: if `key_revocations`
 * currently holds zero facts for that lineage, the walk runs regardless of
 * cursor freshness, every pass, forever. A cached "walked, found nothing"
 * marker suppressing a walk is precisely how a revocation gets missed
 * (migration 0022's header) — this only costs anything for the rare lineage
 * whose only known member keeps failing verification, and revocations are
 * rare by construction.
 *
 * **`MAX_LINEAGE_WALKS`** bounds the number of DISTINCT lineages queued in
 * one sweep pass, checked BEFORE any of them are walked: exceeding it skips
 * the whole lineage-walk phase of this pass (never a silently partial set —
 * `revocation-lineage.ts`'s own doc comment), logging at error level. No new
 * Prometheus counter for this — genuinely exceeding 100 distinct lineages
 * needing a walk in one pass is an extreme, defensive-only condition; a
 * later phase can add one if it ever fires in practice.
 *
 * **The cursor is written ONLY on a fully successful walk** (`{ok: true}`).
 * Every failure kind — empty response, missing the naming ctx_id, a
 * transient/permanent/hard fetch failure — leaves the cursor untouched, so
 * the next sweep retries. Retrying a failed lineage walk is cheap and safe;
 * writing a cursor for an incomplete walk is not.
 *
 * **Continuing past one bad lineage.** Unlike the reference client's
 * `discover_revocations` (which aborts its whole multi-lineage call via `?`
 * on any single lineage's failure — correct for an on-demand query that
 * needs one definitive answer NOW), this sweep's lineage-walk phase logs and
 * moves on to the next distinct lineage in its queue when one fails: a
 * background pass has no single caller waiting on a combined verdict, and
 * one troubled registry must not block verifying revocations for every
 * OTHER registry's lineages in the same pass. Fail-closed is preserved
 * PER-LINEAGE (no partial fold is ever recorded for a failed one); it is
 * only not escalated to aborting unrelated work.
 *
 * ## Retroactive re-audit fan-out (RFC-ACDP-0014 §7, Phase 15)
 *
 * After the discovery + lineage-walk phases above, every `sweep()` pass
 * also re-attempts `ReceiptAuditService.reauditForFingerprint` for EVERY
 * `(tenant_id, revoked_key_fingerprint)` pair currently in `key_revocations`
 * — not only ones with a fact recorded THIS pass. That is what makes a
 * fingerprint whose amendment fan-out exceeds one batch converge over
 * subsequent sweeps (see that method's doc for the batching/idempotency
 * story) rather than needing a separate retry mechanism here. Gated on
 * `KEY_REVOCATION_CHECK_ENABLED` (re-checked inside
 * `reauditForFingerprint` too, so this gate is belt-and-suspenders, not
 * load-bearing on its own) and run under THIS service's own advisory lock
 * — `receipt_audits` amendments and `ReceiptAuditService.sweep()`'s own
 * inserts race under two DIFFERENT locks by design (see the plan's Phase 15
 * edge cases): they touch disjoint rows in practice (one sweep inserts
 * brand-new verdicts, the other only ever amends already-sealed rows —
 * never `status`, so an unaudited row is never a re-audit target), so no
 * additional coordination is needed. A failure re-auditing one fingerprint
 * is logged and never aborts
 * the rest — same "continue past one bad item" discipline as the lineage
 * walk above.
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
import { ReceiptAuditService } from './receipt-audit.service';
import { crossCheckRegistryBinding } from './revocation-binding';
import {
  fingerprintEd25519B64,
  verifyBodyOffline,
  verifyContentHash,
  verifyCtxIdBinding,
} from './receipt-verify';
import {
  classifyLineageFailure,
  LineageFailureClass,
  MAX_LINEAGE_WALKS,
  walkRevocationLineage,
} from './revocation-lineage';
import { ParsedRevocation, parseKeyRevocation, sdkSupportsRevocations } from './revocation-verify';
import { RegistryProfileService } from './registry-profile.service';

const ADVISORY_LOCK_KEY = 'acdp-cp-key-revocation-audit';

/**
 * Freshness window for a lineage's "fully walked" marker — see the file
 * header. `KEY_REVOCATION_LINEAGE_CURSOR_TTL_HOURS`, default 1h, chosen to
 * match the DID resolver's own default cache duration
 * (`did-web-resolver.service.ts`'s 1h cache — Phase 13's plan text notes it
 * "absorbs most of the resolution cost"), so a repeat walk within the window
 * would mostly be re-verifying against a DID document already cached locally
 * anyway. A re-walk CADENCE knob, not a correctness gate: the
 * freshness-vs-zero-facts rule above means a wide window cannot suppress
 * discovery of a lineage's FIRST fact, only how often an
 * already-confirmed-nonempty lineage gets re-checked. `0` opts out of cursor
 * suppression entirely (always re-walk); negatives are rejected at boot.
 */
function lineageCursorTtlMs(config: AppConfigService): number {
  return config.keyRevocationLineageCursorTtlHours * 60 * 60 * 1000;
}

type Status = 'verified' | 'invalid' | 'unavailable' | 'unsupported';

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
    private readonly receiptAuditService: ReceiptAuditService,
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
      const lineageQueue = new Map<
        string,
        { lineageId: string; registryAuthority: string; baseUrl: string; tenantId: string; expectCtxId: string }
      >();
      for (const ev of candidates) {
        const outcome = await this.verifyEvent(ev);
        this.instrumentation.keyRevocationChecksTotal.inc({
          status: outcome.status,
          trust_class: outcome.trustClass,
        });
        // Exhaustive by construction (mirrors classifyLineageFailure's own
        // established pattern, revocation-lineage.ts) — a status value
        // reaching neither an explicit `case` nor `default` here would
        // otherwise fall through to `outcome.revocation!`/`outcome.body!`
        // below with both `undefined`, throwing and crashing this WHOLE
        // sweep pass (skipping every remaining candidate, the lineage-walk
        // phase, and Phase 15's re-audit fan-out for this pass — not a
        // silent security hole, but a real availability one). The `default`
        // branch's runtime fallback is a safe, fail-closed `continue` rather
        // than a thrown error — this file is not on CLAUDE.md's "no throwing
        // Error in handler paths" exemption list, same discipline
        // `classifyLineageFailure` already uses for its own unreachable
        // default.
        switch (outcome.status) {
          case 'invalid':
            this.logger.warn(
              `key-revocation rejected ctx=${ev.ctxId ?? '?'} registry=${ev.registryAuthority}: ${outcome.reason ?? ''}`,
            );
            continue;
          case 'unavailable':
            this.logger.debug(
              `key-revocation unverifiable this pass ctx=${ev.ctxId ?? '?'}: ${outcome.reason ?? ''}`,
            );
            continue;
          case 'unsupported':
            this.logger.warn(
              `key-revocation unsupported (capability gap, not a verification failure) ` +
                `ctx=${ev.ctxId ?? '?'} registry=${ev.registryAuthority}: ${outcome.reason ?? ''}`,
            );
            continue;
          case 'verified':
            break;
          default: {
            const _exhaustive: never = outcome.status;
            this.logger.warn(`key-revocation: unexpected status '${String(_exhaustive)}' — dropping`);
            continue;
          }
        }
        const revocation = outcome.revocation!;
        const body = outcome.body!;
        const lineageId = strOf(body['lineage_id']) ?? ev.lineageId ?? '';
        // Counted BEFORE this event's own fact is recorded below — the
        // "zero facts, walk regardless of cursor" rule (file header) means
        // exactly "zero facts known BEFORE this candidate", not "zero minus
        // the one we are about to add"; recording first would make this
        // count >= 1 for every single verified candidate, silently
        // defeating the rule it exists to implement.
        const priorFactCount = lineageId ? await this.revocationRepo.countByLineage(ev.tenantId, lineageId) : 0;
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
          lineageId,
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

        // ── §7 lineage walk (Phase 13) — see the file header ──────────────
        if (!lineageId) continue;
        const queueKey = `${ev.tenantId}::${lineageId}::${ev.registryAuthority}`;
        if (priorFactCount > 0) {
          const fresh = await this.revocationRepo.findFreshLineageCursor(
            ev.tenantId,
            lineageId,
            ev.registryAuthority,
            lineageCursorTtlMs(this.config),
          );
          if (fresh) continue;
        }
        if (!lineageQueue.has(queueKey)) {
          const registry = await this.registryRepo.findByAuthority(ev.registryAuthority, ev.tenantId);
          if (!registry?.baseUrl) continue;
          lineageQueue.set(queueKey, {
            lineageId,
            registryAuthority: ev.registryAuthority,
            baseUrl: registry.baseUrl,
            tenantId: ev.tenantId,
            expectCtxId: ev.ctxId!,
          });
        }
      }

      if (lineageQueue.size > MAX_LINEAGE_WALKS) {
        this.logger.error(
          `key-revocation lineage walk: ${lineageQueue.size} distinct lineages exceed ` +
            `MAX_LINEAGE_WALKS=${MAX_LINEAGE_WALKS} this pass — refusing a partial walk, ` +
            `skipping all lineage walks this pass (they retry next sweep)`,
        );
      } else {
        for (const item of lineageQueue.values()) {
          await this.walkAndPersistLineage(item);
        }
      }

      // ── RFC-ACDP-0014 §7 retroactive re-audit fan-out (Phase 15) ────────
      // See the file header. Every pass, every known-revoked fingerprint —
      // not only ones touched above — so a fan-out exceeding one batch
      // converges over subsequent sweeps with no separate cursor.
      if (this.config.keyRevocationCheckEnabled) {
        const known = await this.revocationRepo.distinctFingerprints();
        for (const { tenantId, fingerprint } of known) {
          try {
            await this.receiptAuditService.reauditForFingerprint(tenantId, fingerprint);
          } catch (err) {
            this.logger.warn(
              `key-revocation re-audit failed fingerprint=${fingerprint} tenant=${tenantId}: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      return candidates.length;
    } finally {
      await this.database.advisoryUnlock(ADVISORY_LOCK_KEY);
    }
  }

  /**
   * Walk one lineage and persist every verified member it contains. Never
   * throws — a failed walk is logged and the cursor is left unset so the
   * next sweep retries (see the file header's "cursor written only on
   * success" rule).
   */
  private async walkAndPersistLineage(item: {
    lineageId: string;
    registryAuthority: string;
    baseUrl: string;
    tenantId: string;
    expectCtxId: string;
  }): Promise<void> {
    const result = await walkRevocationLineage(
      {
        federationClient: this.federationClient,
        verifyMemberBody: (registryAuthority, tenantId, bodyJson, body) =>
          this.verifyRevocationBody(registryAuthority, tenantId, bodyJson, body),
        logger: this.logger,
      },
      {
        lineageId: item.lineageId,
        registryAuthority: item.registryAuthority,
        baseUrl: item.baseUrl,
        tenantId: item.tenantId,
        expectCtxId: item.expectCtxId,
      },
    );
    // Counted regardless of outcome — an aborted walk (Rule 3) still leaves
    // memberVerdictCounts holding every member evaluated before the abort,
    // and an observed tally must never be lost to a later failure (see
    // Approach step 3, plans/revocation-lineage-member-metric.md). Placed
    // ahead of the persistence loop below too, for the same reason:
    // revocationRepo.record can reject and this drain loop has no try/catch.
    for (const [status, count] of Object.entries(result.memberVerdictCounts) as [Status, number][]) {
      if (count > 0) this.instrumentation.keyRevocationLineageMembersTotal.inc({ status }, count);
    }
    if (!result.ok) {
      this.logger.warn(
        `key-revocation lineage walk failed lineage=${item.lineageId} registry=${item.registryAuthority} ` +
          `kind=${result.kind}: ${result.reason}`,
      );
      return;
    }
    for (const member of result.members) {
      await this.revocationRepo.record({
        tenantId: item.tenantId,
        ctxId: member.ctxId,
        revokedKeyFingerprint: member.revocation.revokedKeyFingerprint,
        compromisedSince: member.revocation.compromisedSince,
        revokedKeyController: member.revocation.revokedKeyController,
        publisher: member.revocation.publisher,
        trustClass: member.revocation.trustClass,
        revokedKeyId: member.revocation.revokedKeyId,
        reason: member.revocation.reason,
        lineageId: item.lineageId,
        originAuthority: member.originAuthority ?? item.registryAuthority,
        contextType: member.contextType,
      } satisfies NewKeyRevocation);
    }
    await this.revocationRepo.recordLineageWalk(item.tenantId, item.lineageId, item.registryAuthority);
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
          status: toStatus(classifyLineageFailure(err)),
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
        status: toStatus(classifyLineageFailure(resp.status)),
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

    return this.verifyRevocationBody(ev.registryAuthority, ev.tenantId, bodyJson, body);
  }

  /**
   * Steps 2-5 of the file header's pipeline — content-hash, signature, §4/§5
   * shape, §6 registry-binding policy — over an ALREADY-FETCHED body. Shared
   * between `verifyEventInner` (a webhook-discovered candidate, fetched and
   * ctx_id-bound above) and the §7 lineage walk (`walkAndPersistLineage`,
   * whose members arrive pre-fetched, embedded in the `GET /lineages/{id}`
   * response — no ctx_id-binding check applies there: there was no per-member
   * REQUEST for the registry to have substituted a response against).
   */
  private async verifyRevocationBody(
    registryAuthority: string,
    tenantId: string,
    bodyJson: string,
    body: Record<string, unknown>,
  ): Promise<Outcome> {
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
      // A P-256 did:key body reaches here with `offline.ok === true` (the
      // signature genuinely verifies) and is dropped below for an unrelated
      // reason — the multicodec prefix, not the signature. See issue #170 /
      // ASSUMPTIONS.md §"ecdsa-p256 revocation signers" for why this is
      // classified `'unsupported'` (a capability gap, not a rejection):
      // making it `'invalid'` would misreport a genuinely-verified signature
      // as malformed, and making it `'unavailable'` instead would abort the
      // ENTIRE §7 lineage walk (Rule 3) on any lineage containing a P-256
      // member — fail-open for every Ed25519 fact sharing that lineage.
      const decoded = decodeEd25519Multibase(agentId);
      if (!decoded.ok) {
        if (decoded.unsupportedAlgorithm) {
          return {
            status: 'unsupported',
            trustClass: 'unknown',
            reason:
              `producer signing algorithm '${decoded.unsupportedAlgorithm}' has no SDK fingerprint ` +
              'helper for revocation verification (signature independently verified offline; ' +
              'dropped for capability, not authenticity)',
          };
        }
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
      // does, so an ecdsa-p256 signer cannot be verified at all here.
      // Classified `'unsupported'` (a capability gap, not a rejection) —
      // NOT `'unavailable'`: this branch runs BEFORE any signature
      // verification is attempted (`resolveKey`/`verifySignatureB64` below),
      // so `'unavailable'`'s "could not ask, retry later" framing would be
      // wrong, and — the load-bearing reason — `'unavailable'` ABORTS the
      // entire §7 lineage walk (Rule 3), so a single did:web P-256 member
      // anywhere in a lineage would permanently block every Ed25519 fact
      // sharing it. See issue #170 / ASSUMPTIONS.md §"ecdsa-p256 revocation
      // signers".
      if (algorithm && algorithm !== 'ed25519') {
        return {
          status: 'unsupported',
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
            status: toStatus(classifyLineageFailure(err)),
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
      const caps = await this.profiles.registryCapabilities(registryAuthority, tenantId);
      if (caps.registryDid === null) {
        return {
          status: 'unavailable',
          trustClass: 'registry_attested',
          reason: `capabilities for '${registryAuthority}' are unreadable — cannot run the §6 binding check`,
        };
      }
      const check = crossCheckRegistryBinding(revocation.publisher, registryAuthority, caps.registryDid);
      if (!check.ok) {
        return { status: 'invalid', trustClass: 'registry_attested', reason: check.reason };
      }
    }

    return { status: 'verified', trustClass: revocation.trustClass, revocation, body };
  }
}

/**
 * Collapse `classifyLineageFailure`'s three-way result to two of this
 * file's four `Outcome.status` values (never `'unsupported'`, which is a
 * capability gap distinct from any fetch/DID-resolution failure this
 * classifies) — see the file header for why `'hard'` folds into `'invalid'`
 * here (unlike the lineage walk, which treats it as its own
 * abort-and-record-nothing case).
 */
function toStatus(cls: LineageFailureClass): 'unavailable' | 'invalid' {
  return cls === 'transient' ? 'unavailable' : 'invalid';
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
