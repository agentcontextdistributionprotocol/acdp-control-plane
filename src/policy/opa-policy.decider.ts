/**
 * OPA-backed `PolicyDecider`.
 *
 * Delegates each decision to a remote OPA sidecar via the standard
 * `POST /v1/data/<package>/<rule>` endpoint. The Rego corpus is the
 * customer's authoring surface; this module is just the HTTP shim.
 *
 * Request shape (sent as `input`):
 *
 *   {
 *     "subject_did": "...",
 *     "action": "context.publish",
 *     "resource_id": "...",
 *     "resource_visibility": "public" | "restricted" | "private" | null,
 *     "resource_audience": ["did:web:...", ...],
 *     "scopes": ["publish", "..."],
 *     "tenant_id": "tenant-a"
 *   }
 *
 * Response shape (Rego's `data.<package>.<rule>` output):
 *
 *   { "allow": true }
 *   { "allow": false, "deny_code": "audience", "deny_reason": "not in list" }
 *   { "indeterminate": true, "note": "no rule matched" }
 *
 * The contract is documented in detail in
 * `docs/policies/example.rego` — V1 ships a reference corpus that
 * mirrors the static-rules logic so deployments can switch backends
 * without policy churn.
 *
 * ## Failure modes
 *
 *   - OPA unreachable / 5xx / timeout → `indeterminate` (which the
 *     PolicyGuard treats as deny). Operators who want fail-open set
 *     `OPA_FAIL_OPEN=true`.
 *   - OPA returns a malformed response → `indeterminate` (same).
 *   - OPA returns `{}` (rule not defined) → `indeterminate`.
 *
 * Operators monitor the warn logs from this service to detect OPA
 * outages — they manifest as a spike in 403 ForbiddenException at
 * the PolicyGuard.
 */
import { Logger } from '@nestjs/common';
import {
  PolicyDecider,
  PolicyDecision,
  PolicyDecisions,
  PolicyDenyCode,
  PolicyRequest,
} from './policy-decider';

export interface OpaPolicyDeciderOptions {
  /** Base URL of the OPA sidecar, e.g. `http://localhost:8181`. */
  baseUrl: string;
  /** OPA package path, e.g. `acdp/policy/v1`. */
  packagePath: string;
  /** Rule name to query within the package. Defaults to `decision`. */
  rule?: string;
  /** Per-request timeout (ms). Defaults to 1500 — policy is on the hot path. */
  timeoutMs?: number;
  /** When true, transport errors return `allow` instead of `indeterminate`. */
  failOpen?: boolean;
}

interface OpaResponseBody {
  /** Rego rule output (the `result` field of OPA's wire response). */
  result?:
    | {
        allow?: boolean;
        deny_code?: string;
        deny_reason?: string;
        indeterminate?: boolean;
        note?: string;
      }
    | undefined;
}

export class OpaPolicyDecider implements PolicyDecider {
  private readonly logger = new Logger(OpaPolicyDecider.name);
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly failOpen: boolean;

  constructor(private readonly opts: OpaPolicyDeciderOptions) {
    const rule = opts.rule ?? 'decision';
    const base = opts.baseUrl.replace(/\/+$/, '');
    const path = opts.packagePath.replace(/\//g, '.').replace(/^\.+|\.+$/g, '');
    // OPA dot-segments the package path in the URL after /v1/data.
    this.url = `${base}/v1/data/${path}/${rule}`.replace(/\/+/g, '/').replace(':/', '://');
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.failOpen = opts.failOpen ?? false;
  }

  async decide(req: PolicyRequest): Promise<PolicyDecision> {
    const body = JSON.stringify({ input: toOpaInput(req) });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        signal: ctrl.signal,
      });
    } catch (e) {
      this.logger.warn({
        msg: 'OPA unreachable',
        error: e instanceof Error ? e.message : String(e),
      });
      return this.onError();
    } finally {
      clearTimeout(t);
    }
    if (!resp.ok) {
      this.logger.warn({
        msg: 'OPA returned non-OK HTTP status',
        status: resp.status,
        statusText: resp.statusText,
      });
      return this.onError();
    }
    let payload: OpaResponseBody;
    try {
      payload = (await resp.json()) as OpaResponseBody;
    } catch (e) {
      this.logger.warn({
        msg: 'OPA response is not JSON',
        error: e instanceof Error ? e.message : String(e),
      });
      return this.onError();
    }
    return interpretOpa(payload);
  }

  private onError(): PolicyDecision {
    if (this.failOpen) {
      this.logger.warn('OPA decider failing OPEN (OPA_FAIL_OPEN=true)');
      return PolicyDecisions.allow();
    }
    return PolicyDecisions.indeterminate('opa unreachable');
  }
}

/** Map our PolicyRequest to the snake_case input shape Rego policies expect. */
function toOpaInput(req: PolicyRequest): Record<string, unknown> {
  return {
    subject_did: req.subjectDid,
    action: req.action,
    resource_id: req.resourceId,
    resource_visibility: req.resourceVisibility ?? null,
    resource_audience: req.resourceAudience ?? [],
    scopes: req.scopes,
    tenant_id: req.tenantId ?? '',
  };
}

const DENY_CODES: ReadonlySet<PolicyDenyCode> = new Set<PolicyDenyCode>([
  'visibility',
  'audience',
  'scope',
  'tenant_mismatch',
  'unauthenticated',
]);

/** Parse OPA's response into a PolicyDecision. Returns indeterminate on any malformed shape. */
export function interpretOpa(payload: OpaResponseBody): PolicyDecision {
  const r = payload.result;
  if (!r || typeof r !== 'object') {
    return PolicyDecisions.indeterminate('opa returned no result');
  }
  if (r.allow === true) return PolicyDecisions.allow();
  if (r.allow === false) {
    const code = (r.deny_code ?? 'visibility') as PolicyDenyCode;
    const validCode = DENY_CODES.has(code) ? code : ('visibility' as PolicyDenyCode);
    return PolicyDecisions.deny(validCode, r.deny_reason ?? 'opa denied');
  }
  if (r.indeterminate === true) {
    return PolicyDecisions.indeterminate(r.note ?? 'opa indeterminate');
  }
  return PolicyDecisions.indeterminate('opa result has neither allow nor indeterminate');
}
