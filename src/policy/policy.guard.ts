/**
 * PolicyGuard — runs the configured `PolicyDecider` on every handler
 * tagged with `@CheckPolicy(action)`.
 *
 * Lookup chain:
 *   1. Pull `action` from handler-level metadata. No tag → skip
 *      (handler is unguarded; controller-level auth gates still apply).
 *   2. Build a `PolicyRequest` from the request's `actorId`,
 *      `tenantId`, scopes (the union of the JWT's `scope`/`scopes`/`scp`
 *      claims, pinned by AuthGuard; empty for API keys), and the resource id extracted from path params /
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
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '../errors/error-codes';
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
      this.logger.warn({
        msg: 'PolicyGuard hit @CheckPolicy but no POLICY_DECIDER is registered',
        action,
      });
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
      // Scopes pinned by the AuthGuard from the JWT (`scope`/`scopes`/`scp` union).
      scopes: Array.isArray(req.actorScopes) ? req.actorScopes : [],
      tenantId: typeof req.tenantId === 'string' ? req.tenantId : DEFAULT_TENANT_ID,
    };

    const decision = await this.decider.decide(policyReq);
    switch (decision.kind) {
      case 'allow':
        return true;
      case 'deny':
        this.logger.warn({
          msg: 'policy deny',
          action,
          subject: policyReq.subjectDid,
          reasonCode: decision.code,
          reason: decision.reason,
        });
        throw policyDenied({
          message: 'policy denied',
          code: decision.code,
          reason: decision.reason,
        });
      case 'indeterminate':
        this.logger.warn({
          msg: 'policy indeterminate, treating as DENY',
          action,
          subject: policyReq.subjectDid,
          note: decision.note ?? '',
        });
        throw policyDenied({
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

/**
 * Label the policy 403 IN PLACE (#182) rather than converting to
 * AppException: the documented legacy body (`message`, `code`, `reason` at the
 * top level — docs/POLICY.md) must stay where clients read it, while
 * `errorCode` (the CP error category) and `metadata` (→ envelope
 * `error.details`) are added. `errorCode` never overwrites the decider's
 * `code` — different axes (CP category vs policy rule id). A plain
 * HttpException, not ForbiddenException: the status is the contract.
 */
function policyDenied(body: {
  message: string;
  code: string;
  reason: string;
}): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.FORBIDDEN,
      errorCode: ErrorCode.POLICY_DENIED,
      ...body,
      metadata: { code: body.code, reason: body.reason },
    },
    HttpStatus.FORBIDDEN,
  );
}
