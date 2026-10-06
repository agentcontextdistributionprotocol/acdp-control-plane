/**
 * Policy decision contract — V2 cross-cutting authorization layer.
 *
 * Today access control is scattered: visibility lives in the registry
 * (audience check), tenancy will live in the auth guard (#6), capability
 * scoping lives in `CapabilityService` (#4). A central `PolicyDecider`
 * lets callers ask one structured question — "may subject X perform
 * action Y on resource Z under constraints W?" — and get an auditable
 * answer, so the rules can be unit-tested in isolation and swapped
 * for a declarative engine (OPA / Rego) without changing call sites.
 *
 * Closes deferred-plan §3 (contract + static-rules impl + caching half).
 * OPA backend is a separate PR — it requires standing up an OPA server
 * and a Rego corpus, neither of which is required for V1.
 *
 * Decision shape:
 *
 *   - `Allow`         — explicit permit.
 *   - `Deny(reason)`  — explicit refusal. The reason is structured
 *                       (code + human-readable detail) so the caller
 *                       can log and surface without leaking sensitive
 *                       resource details to the client.
 *   - `Indeterminate` — no rule matched. By convention callers treat
 *                       this as `Deny` in production but log distinctly
 *                       so operators can spot missing coverage.
 */

export type PolicyAction =
  | 'context.publish'
  | 'context.retrieve'
  | 'context.list'
  | 'capability.declare'
  | 'run.start'
  | 'run.read';

export type Visibility = 'public' | 'restricted' | 'private';

export interface PolicyRequest {
  /** Subject (caller) DID. Empty string for unauthenticated callers. */
  subjectDid: string;
  /** What the subject is trying to do. */
  action: PolicyAction;
  /** Resource identifier (ctx_id / run_id / agent_did). May be empty for list ops. */
  resourceId: string;
  /** Visibility classification of the resource (if applicable). */
  resourceVisibility?: Visibility;
  /** Audience list — for `restricted` resources, the DIDs explicitly granted access. */
  resourceAudience?: ReadonlyArray<string>;
  /** Scopes carried in the subject's JWT: the union of the `scope` / `scopes` / `scp` claims (see auth/scopes.ts). Empty array if absent. */
  scopes: ReadonlyArray<string>;
  /** Tenant boundary (#6). Empty string means single-tenant deployment. */
  tenantId?: string;
}

export type PolicyDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; code: PolicyDenyCode; reason: string }
  | { kind: 'indeterminate'; note?: string };

export type PolicyDenyCode =
  | 'visibility'        // resource not visible to subject
  | 'audience'          // subject not in restricted audience
  | 'scope'             // missing required scope
  | 'tenant_mismatch'   // cross-tenant access attempt
  | 'unauthenticated';  // subject is empty

export const PolicyDecisions = {
  allow(): PolicyDecision {
    return { kind: 'allow' };
  },
  deny(code: PolicyDenyCode, reason: string): PolicyDecision {
    return { kind: 'deny', code, reason };
  },
  indeterminate(note?: string): PolicyDecision {
    return { kind: 'indeterminate', note };
  },
};

export interface PolicyDecider {
  /**
   * Synchronous interface — the static-rules impl is pure CPU; OPA
   * backend will wrap an HTTP call and switch to a Promise. The
   * caller-facing service exposes the async-shape, so static impls
   * naturally resolve immediately.
   */
  decide(req: PolicyRequest): PolicyDecision | Promise<PolicyDecision>;
}

/** Injection token for NestJS DI. */
export const POLICY_DECIDER = Symbol('POLICY_DECIDER');
