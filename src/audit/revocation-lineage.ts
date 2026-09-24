/**
 * RFC-ACDP-0014 §7 lineage fold — walking a revocation's full lineage so the
 * §4 earliest-`compromised_since` rule can be applied to every member the
 * lineage actually contains, not just whichever one a webhook happened to
 * deliver first.
 *
 * **`GET /lineages/{lineage_id}`, never `/current`.** `/current` answers
 * "what is the head now", and RFC-ACDP-0013 §8.3 makes a retracted version
 * never the head, so a lineage whose members are all superseded or retracted
 * **404s** there — exactly the case that matters most for a revocation fold.
 * Ground truth, verified directly against the reference registry
 * (`acdp-registry-core/src/handlers/context.rs:1291-1317`): the response is
 * a bare JSON array of `FullContext` (body included per member — no
 * per-member content fetch is needed), ordered `version` ASC, including
 * superseded and retracted members (only visibility/tenant filtered, never
 * status), and an unrecognised `lineage_id` returns HTTP 200 + `[]`, never
 * 404.
 *
 * Two further RFC-ACDP-0014 §7 rules, both easy to get backwards:
 * - **Supersession does not disarm.** A superseding context that is not
 *   itself a revocation of the same signer class (`key-revocation` or the
 *   §10 interim `acdp:key-revocation` — {@link isRevocationContextType})
 *   MUST be disregarded for revocation-effectiveness. RFC-ACDP-0003 §3.1
 *   constrains supersession by `agent_id`/version/lineage, but not by
 *   `type`, so a consumer MUST NOT assume a registry filtered such a
 *   supersession out.
 * - **Retraction does not un-revoke.** A retracted member still counts in
 *   the earliest-T fold.
 *
 * **Failure discipline**, transcribed from the reference client
 * (`acdp-client/src/revocation.rs:304-351`, `walk_revocation_lineage`):
 * 1. An empty lineage response fails closed — the registry never returns
 *    `[]` for a lineage a live context just named (ground truth above), and
 *    RFC-ACDP-0014 §4 requires every revocation to be `visibility: public`,
 *    so RFC-ACDP-0004 §5.4's "authorized to see zero versions" rule can
 *    never legitimately produce this response here.
 * 1b. A non-empty response that does not contain the `ctx_id` that named
 *    the walk ALSO fails closed, checked against the PRE-verification
 *    member list — not redundant with (1): a registry can serve a
 *    plausible, non-empty lineage that simply omits the one revocation
 *    already known to exist.
 * 2. A member that fails verification PERMANENTLY is dropped with a
 *    warning, not fatal — otherwise one injected garbage member suppresses
 *    every genuine revocation in the lineage (the same denial-of-service
 *    the walk exists to avoid). Such a member was never going to contribute
 *    a valid `compromised_since` to the fold anyway.
 * 3. A member that fails verification TRANSIENTLY aborts the WHOLE walk.
 *    This asymmetry is load-bearing: a dropped member that *would* have
 *    named an earlier `compromised_since` moves the fold LATER — a genuine
 *    false authorization, not a mere omission. A transient failure gives no
 *    information about what that member would have said.
 *
 * `MAX_LINEAGE_WALKS` bounds the number of DISTINCT lineages a caller walks
 * in one pass (`acdp-client/src/revocation.rs:47,568` — the same bound the
 * reference client applies to its own multi-lineage discovery loop), not
 * the members within a single lineage; enforcing it is the caller's
 * (`RevocationAuditService`'s) job, since only the caller knows how many
 * distinct lineages it is about to walk this pass.
 */
import { Logger } from '@nestjs/common';
import { DidResolutionError } from '../auth/did-web/did-web-resolver.service';
import { FederationFetchError, SafeFederationClient } from '../contexts/safe-federation-client';
import { isRevocationContextType } from '../contracts/revocation';
import { ParsedRevocation } from './revocation-verify';

/** Bounds distinct lineages walked in one sweep pass — see the file header. */
export const MAX_LINEAGE_WALKS = 100;

export type LineageFailureClass = 'transient' | 'permanent' | 'hard';

/**
 * Classify a lineage-walk failure as transient ("could not ask" — retry
 * later, never record a partial fold), permanent ("asked and was denied" —
 * drop the one thing that failed, keep going), or hard ("would have to
 * truncate to keep going" — abort and record nothing, same treatment as
 * `MAX_LINEAGE_WALKS`).
 *
 * TypeScript has no `AcdpError::is_transient()` (the Rust one is
 * `acdp-primitives/src/error.rs:473`) — this is the real table, read off
 * the source rather than assumed:
 *
 * | Source | Code / condition | Class | Why |
 * |---|---|---|---|
 * | HTTP status | 5xx, 429, 408 | transient | "could not ask" |
 * | HTTP status | other 4xx | permanent | "asked and was denied/not-found" |
 * | `FederationFetchError` | `FETCH` | transient | transport / DNS / timeout |
 * | `FederationFetchError` | `BODY_TOO_LARGE` | hard | never silently truncate a lineage |
 * | `FederationFetchError` | `SSRF`, `REDIRECT` | permanent | a policy denial is a decision, not an outage |
 * | `DidResolutionError` | `FETCH`, `STATUS` | transient | the DID host is unreachable or erroring |
 * | `DidResolutionError` | `BODY_TOO_LARGE`, `CONTENT_TYPE` | permanent | the host answered; the answer is unusable |
 * | `DidResolutionError` | `URL`, `SSRF`, `PARSE`, `PICK` | permanent | malformed DID, policy denial, unparseable document, key denied |
 *
 * `DidResolutionError.STATUS` is deliberately transient even though a 404
 * on a DID document is arguably a denial: the resolver does not distinguish
 * the status class in `did-web-resolver.service.ts` today, so the
 * conservative reading is "could not ask". If that resolver later separates
 * 4xx from 5xx, this row moves.
 *
 * Exhaustive by construction (a TS compile error, not just a runtime
 * default, if either union gains a member this switch does not handle) —
 * `classifyLineageFailure.spec` additionally iterates every member of both
 * unions at runtime so the guarantee holds even under `--downlevelIteration`
 * weirdness or a JS caller that bypasses the type checker.
 */
export function classifyLineageFailure(input: FederationFetchError | DidResolutionError | number): LineageFailureClass {
  if (typeof input === 'number') {
    return input === 429 || input === 408 || (input >= 500 && input <= 599) ? 'transient' : 'permanent';
  }
  if (input instanceof FederationFetchError) {
    const code = input.code;
    switch (code) {
      case 'FETCH':
        return 'transient';
      case 'BODY_TOO_LARGE':
        return 'hard';
      case 'SSRF':
      case 'REDIRECT':
        return 'permanent';
      default: {
        // Unreachable under the pinned type: the `never` assignment below is
        // a COMPILE-TIME exhaustiveness guard — adding a code to
        // `FederationFetchError['code']` without a case above fails the
        // build, not just this test. Deliberately not throwing an error
        // here (this file is not in CLAUDE.md's request-handler exemption
        // list, and that list is a ratchet — never extended for new code):
        // the safest runtime fallback for a value the type system says
        // cannot occur is the fail-closed classification, same as an
        // unrecognised HTTP status above.
        const _exhaustive: never = code;
        return 'permanent';
      }
    }
  }
  const code = input.code;
  switch (code) {
    case 'FETCH':
    case 'STATUS':
      return 'transient';
    case 'BODY_TOO_LARGE':
    case 'CONTENT_TYPE':
    case 'URL':
    case 'SSRF':
    case 'PARSE':
    case 'PICK':
      return 'permanent';
    default: {
      // See the FederationFetchError branch above for why this returns
      // rather than throws.
      const _exhaustive: never = code;
      return 'permanent';
    }
  }
}

/** One lineage member, verified and ready to persist as a `key_revocations` fact. */
export interface LineageMember {
  ctxId: string;
  contextType: string;
  originAuthority: string | undefined;
  revocation: ParsedRevocation;
}

export interface LineageMemberVerdict {
  status: 'verified' | 'invalid' | 'unavailable';
  reason?: string;
  revocation?: ParsedRevocation;
}

/**
 * Verify one already-fetched revocation body (content-hash, signature,
 * §4/§5 shape, §6 registry-binding policy) — the same pipeline
 * `RevocationAuditService` runs for a webhook-delivered candidate, reused
 * here so a lineage member discovered only through the walk gets identical
 * scrutiny. Injected rather than imported directly: this module stays free
 * of the SDK/DID-resolution machinery, so its own tests can stub verification
 * outcomes instead of re-mocking the whole crypto chain.
 */
export type VerifyLineageMemberBody = (
  registryAuthority: string,
  tenantId: string,
  bodyJson: string,
  body: Record<string, unknown>,
) => Promise<LineageMemberVerdict>;

export interface LineageWalkDeps {
  federationClient: Pick<SafeFederationClient, 'get'>;
  verifyMemberBody: VerifyLineageMemberBody;
  logger: Pick<Logger, 'warn'>;
}

export interface LineageWalkParams {
  lineageId: string;
  registryAuthority: string;
  baseUrl: string;
  tenantId: string;
  /** The `ctx_id` that triggered this walk — checked against the raw member list, rule 1b. */
  expectCtxId: string;
}

export type LineageWalkOutcome =
  | { ok: true; members: LineageMember[] }
  | { ok: false; kind: 'empty' | 'missing_named_ctx' | LineageFailureClass; reason: string };

/** Walk one lineage. See the file header for the full rule set. */
export async function walkRevocationLineage(
  deps: LineageWalkDeps,
  params: LineageWalkParams,
): Promise<LineageWalkOutcome> {
  const url = `${params.baseUrl.replace(/\/$/, '')}/lineages/${encodeURIComponent(params.lineageId)}`;

  let resp;
  try {
    resp = await deps.federationClient.get(url);
  } catch (err) {
    if (err instanceof FederationFetchError) {
      return {
        ok: false,
        kind: classifyLineageFailure(err),
        reason: `lineage fetch failed (${err.code}): ${err.message}`,
      };
    }
    return {
      ok: false,
      kind: 'transient',
      reason: `lineage fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (resp.status < 200 || resp.status >= 300) {
    return {
      ok: false,
      kind: classifyLineageFailure(resp.status),
      reason: `lineage fetch returned HTTP ${resp.status}`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(resp.body);
  } catch (err) {
    return {
      ok: false,
      kind: 'permanent',
      reason: `lineage response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, kind: 'permanent', reason: 'lineage response is not a JSON array' };
  }

  // Rule 1: an empty response is never an honest "nothing here" for a
  // lineage a live context just named — see the file header.
  if (raw.length === 0) {
    return { ok: false, kind: 'empty', reason: `lineage '${params.lineageId}' returned no members` };
  }

  const rawMembers: { body: Record<string, unknown>; ctxId: string | undefined }[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') {
      deps.logger.warn(`lineage walk: skipping non-object member in lineage='${params.lineageId}'`);
      continue;
    }
    const full = item as Record<string, unknown>;
    const body =
      full['body'] !== null && typeof full['body'] === 'object' ? (full['body'] as Record<string, unknown>) : undefined;
    if (!body) {
      deps.logger.warn(`lineage walk: skipping member with no body in lineage='${params.lineageId}'`);
      continue;
    }
    rawMembers.push({ body, ctxId: strOf(body['ctx_id']) });
  }

  // Rule 1b: checked against the PRE-verification member list — see the
  // file header for why post-verification survivors would let a hostile
  // registry manufacture this same failure by corrupting the named member.
  if (!rawMembers.some((m) => m.ctxId === params.expectCtxId)) {
    return {
      ok: false,
      kind: 'missing_named_ctx',
      reason: `lineage '${params.lineageId}' does not contain the naming ctx_id '${params.expectCtxId}'`,
    };
  }

  const members: LineageMember[] = [];
  for (const m of rawMembers) {
    const contextType = strOf(m.body['type']);
    // Edge case: a lineage containing non-revocation members is expected
    // and normal (a supersession by an unrelated type) — filter out of the
    // fold, never treat as an error, never let it disarm anything.
    if (!contextType || !isRevocationContextType(contextType)) continue;
    if (!m.ctxId) {
      deps.logger.warn(`lineage walk: dropped revocation-typed member with no ctx_id in lineage='${params.lineageId}'`);
      continue;
    }
    const bodyJson = JSON.stringify(m.body);
    const verdict = await deps.verifyMemberBody(params.registryAuthority, params.tenantId, bodyJson, m.body);
    if (verdict.status === 'unavailable') {
      // Rule 3: a transient member failure aborts the whole walk.
      return {
        ok: false,
        kind: 'transient',
        reason: `lineage '${params.lineageId}' member '${m.ctxId}' unverifiable this pass: ${verdict.reason ?? ''}`,
      };
    }
    if (verdict.status === 'invalid') {
      // Rule 2: dropped with a warning, remaining members still fold.
      deps.logger.warn(
        `lineage walk: dropped member ctx='${m.ctxId}' lineage='${params.lineageId}' (failed verification): ${verdict.reason ?? ''}`,
      );
      continue;
    }
    members.push({
      ctxId: m.ctxId,
      contextType,
      originAuthority: strOf(m.body['origin_registry']),
      revocation: verdict.revocation!,
    });
  }

  return { ok: true, members };
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
