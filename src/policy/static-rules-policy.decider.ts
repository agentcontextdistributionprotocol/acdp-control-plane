/**
 * Static-rules `PolicyDecider` — V1 baseline that re-expresses today's
 * scattered visibility / audience / scope checks as one explicit
 * decision tree.
 *
 * The decision logic matches the current registry code exactly so this
 * impl is drop-in: any decision the existing visibility / audience
 * code allows MUST be allowed here, and any deny it issues MUST be
 * denied here (the regression-equivalence property the deferred plan
 * calls out).
 *
 * Tenancy (#6) is anticipated but optional: when both request and
 * resource carry a `tenantId`, mismatches are denied; when either is
 * empty (single-tenant deployments before #6 ships), the rule is a
 * no-op. Same pattern for required scopes — empty `requiredScopes`
 * means "no scope gate" rather than "deny all".
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  PolicyAction,
  PolicyDecider,
  PolicyDecision,
  PolicyDecisions,
  PolicyRequest,
} from './policy-decider';

/**
 * Note: this decider ignores `PolicyRequest.issuer` / `federated`; federated
 * principals are only distinguished by an OPA policy or the per-issuer
 * `read_only` flag enforced in AuthGuard.
 *
 * Per-action required scopes. Producers MUST present every scope
 * listed for the action; missing → deny. Empty list = no scope gate.
 */
export interface StaticRulesConfig {
  requiredScopes?: Partial<Record<PolicyAction, ReadonlyArray<string>>>;
  /** Resource-tenant lookup (called by static-rules to compare). */
  resourceTenantOf?: (resourceId: string) => string | undefined;
}

@Injectable()
export class StaticRulesPolicyDecider implements PolicyDecider {
  private readonly logger = new Logger(StaticRulesPolicyDecider.name);

  constructor(private readonly config: StaticRulesConfig = {}) {}

  decide(req: PolicyRequest): PolicyDecision {
    // 1. Unauthenticated: only public contexts are readable; everything
    //    else requires identity.
    if (!req.subjectDid) {
      if (req.action === 'context.retrieve' && req.resourceVisibility === 'public') {
        return PolicyDecisions.allow();
      }
      if (req.action === 'context.list') {
        return PolicyDecisions.allow();
      }
      return PolicyDecisions.deny('unauthenticated', `action '${req.action}' requires a subject`);
    }

    // 2. Tenant gate: when both sides carry a tenant, mismatch is fatal.
    const resourceTenant = this.config.resourceTenantOf?.(req.resourceId);
    if (req.tenantId && resourceTenant && req.tenantId !== resourceTenant) {
      return PolicyDecisions.deny(
        'tenant_mismatch',
        `subject tenant '${req.tenantId}' does not match resource tenant '${resourceTenant}'`,
      );
    }

    // 3. Required scopes for this action.
    const required = this.config.requiredScopes?.[req.action] ?? [];
    if (required.length > 0) {
      const have = new Set(req.scopes);
      const missing = required.filter((s) => !have.has(s));
      if (missing.length > 0) {
        return PolicyDecisions.deny(
          'scope',
          `missing required scope(s) for '${req.action}': ${missing.join(' ')}`,
        );
      }
    }

    // 4. Visibility / audience for retrieve.
    if (req.action === 'context.retrieve') {
      switch (req.resourceVisibility) {
        case 'public':
          return PolicyDecisions.allow();
        case 'private':
          return PolicyDecisions.deny('visibility', 'resource is private');
        case 'restricted': {
          const audience = req.resourceAudience ?? [];
          if (audience.length === 0) {
            return PolicyDecisions.deny(
              'audience',
              'restricted resource has empty audience list',
            );
          }
          if (!audience.includes(req.subjectDid)) {
            return PolicyDecisions.deny(
              'audience',
              `subject '${req.subjectDid}' is not in the restricted audience list`,
            );
          }
          return PolicyDecisions.allow();
        }
        case undefined:
          // No visibility supplied at guard time — the guard can't
          // know visibility until the resource is fetched. For an
          // authenticated caller, allow it through; the service layer
          // re-checks visibility/audience post-fetch. Surfacing
          // `indeterminate` here would dead-end every @CheckPolicy-
          // gated retrieve, since no caller can supply visibility
          // before the resource is loaded. Tenant + scope checks
          // above still applied.
          return PolicyDecisions.allow();
      }
    }

    // 5. Default-allow for non-retrieve actions once auth+tenant+scope
    //    gates pass. The retrieve path is the only one that needs
    //    visibility/audience in V1; publish/list/etc. don't.
    return PolicyDecisions.allow();
  }
}
