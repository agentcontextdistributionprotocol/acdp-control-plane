/**
 * PolicyGuard — runs the configured `PolicyDecider` on every handler
 * tagged with `@CheckPolicy(action)`.
 *
 * Lookup chain:
 *   1. Pull `action` from handler-level metadata. No tag → skip
 *      (handler is unguarded; controller-level auth gates still apply).
 *   2. Build a `PolicyRequest` from the request's `actorId`,
 *      `tenantId`, scopes (currently empty until JWT-scope plumbing
 *      lands), and the resource id extracted from path params /
 *      body / query (per-handler shape).
 *   3. Decide. `allow` → continue. `deny` → 403 with the structured
 *      reason. `indeterminate` → deny + warn (coverage-gap signal).
 *
 * Resource-id extraction is intentionally simple in V1: callers can
 * pass a custom extractor via the `extractResourceId` second argument
 * on `@CheckPolicy()` once the need appears.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';
import { POLICY_ACTION_KEY } from './check-policy.decorator';
import {
  POLICY_DECIDER,
  PolicyAction,
  PolicyDecider,
  PolicyRequest,
} from './policy-decider';

@Injectable()
export class PolicyGuard implements CanActivate {
  private readonly logger = new Logger(PolicyGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(POLICY_DECIDER)
    private readonly decider: PolicyDecider | null = null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<PolicyAction | undefined>(
      POLICY_ACTION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!action) return true;
    // No decider configured = open-by-default in V1. We log a warn
    // so operators notice they decorated handlers without wiring
    // the engine.
    if (!this.decider) {
      this.logger.warn(
        `PolicyGuard hit @CheckPolicy(${action}) but no POLICY_DECIDER is registered`,
      );
      return true;
    }

    const req = context.switchToHttp().getRequest();
    // subjectDid prefers the JWT-bound DID (actorDid) over the legacy
    // actorId — the latter is just an api-key prefix and can't match
    // any DID-keyed policy rule (audience checks, OPA `subject_did`).
    const subject =
      (typeof req.actorDid === 'string' && req.actorDid.length > 0
        ? req.actorDid
        : typeof req.actorId === 'string'
          ? req.actorId
          : '') || '';
    const policyReq: PolicyRequest = {
      subjectDid: subject,
      action,
      // V1: best-effort resource extraction from params (runId/ctxId/etc.).
      resourceId: extractResourceId(req),
      // Scopes pinned by the AuthGuard from the JWT (`scope`/`scopes` claim).
      scopes: Array.isArray(req.actorScopes) ? req.actorScopes : [],
      tenantId: typeof req.tenantId === 'string' ? req.tenantId : DEFAULT_TENANT_ID,
    };

    const decision = await this.decider.decide(policyReq);
    switch (decision.kind) {
      case 'allow':
        return true;
      case 'deny':
        this.logger.warn(
          `policy deny: action=${action} subject=${policyReq.subjectDid} reason=${decision.code} (${decision.reason})`,
        );
        throw new ForbiddenException({
          message: 'policy denied',
          code: decision.code,
          reason: decision.reason,
        });
      case 'indeterminate':
        this.logger.warn(
          `policy indeterminate: action=${action} subject=${policyReq.subjectDid} note=${decision.note ?? ''} — treating as DENY`,
        );
        throw new ForbiddenException({
          message: 'policy indeterminate',
          code: 'indeterminate',
          reason: decision.note ?? 'no rule matched',
        });
    }
  }
}

function extractResourceId(req: { params?: Record<string, unknown> }): string {
  const p = req.params ?? {};
  const candidate =
    (p.ctxId as string | string[] | undefined) ??
    (p.runId as string | undefined) ??
    (p.did as string | string[] | undefined) ??
    '';
  if (Array.isArray(candidate)) return candidate.join('/');
  return typeof candidate === 'string' ? candidate : '';
}
