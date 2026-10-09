/**
 * QuotaService — the per-tenant, per-action quota check itself, independent
 * of how the caller learned the tenant. `QuotaGuard` is a thin wrapper that
 * reads `@CheckQuota(action)` metadata and calls `enforce`; a handler that
 * only learns its tenant inside the request (e.g. after HMAC verification)
 * can call `enforce` directly. Limits are sourced from `TENANT_QUOTAS`
 * (see `quota-config.ts`).
 *
 * `enforce(tenantId, action, res?)`:
 *   1. No quota config/store registered → no-op (modules without quota boot).
 *   2. No limit configured for `(tenantId, action)` → no-op.
 *   3. Store INCR; if `count > limit.count` → 429 with `Retry-After` (set on
 *      `res` when given).
 *
 * Fail-open is deliberate: a Redis outage MUST NOT take down the control
 * plane. The store returns `{count: 0, ttlSeconds: 0}` on transport failure;
 * `count == 0` is treated as "no signal" and the request proceeds. Operators
 * see the warn log from `RedisQuotaStore.increment`.
 *
 * The 429 is one of the documented legacy-body `HttpException`s (#182): the
 * top-level fields stay for existing clients, with `errorCode` + `metadata`
 * added alongside.
 */
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ErrorCode } from '../errors/error-codes';
import {
  ParsedQuotaConfig,
  QuotaAction,
  resolveLimit,
} from './quota-config';
import { QuotaStore } from './quota-store';

export const QUOTA_CONFIG = Symbol('QUOTA_CONFIG');
export const QUOTA_STORE = Symbol('QUOTA_STORE');

/** The slice of an Express `Response` the 429 path needs. */
export interface QuotaResponseLike {
  setHeader?: (name: string, value: string) => unknown;
}

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);

  constructor(
    @Optional() @Inject(QUOTA_CONFIG) private readonly config: ParsedQuotaConfig | null = null,
    @Optional() @Inject(QUOTA_STORE) private readonly store: QuotaStore | null = null,
  ) {}

  /**
   * Count one `action` against `tenantId`. Resolves when the request may
   * proceed; throws a 429 `HttpException` (and sets `Retry-After` on `res`)
   * once the tenant's window is exhausted.
   */
  async enforce(
    tenantId: string,
    action: QuotaAction,
    res?: QuotaResponseLike | null,
  ): Promise<void> {
    if (!this.config || !this.store) return;

    const limit = resolveLimit(this.config, tenantId, action);
    if (!limit) return; // no rule for this (tenant, action) — unconstrained

    const key = `acdp:quota:${tenantId}:${action}`;
    const { count, ttlSeconds } = await this.store.increment(key, limit.windowSeconds);
    if (count === 0) {
      // Store unavailable — fail open (already warned by the store).
      return;
    }

    if (count > limit.count) {
      this.logger.warn({
        msg: 'quota exceeded',
        tenantId,
        action,
        count,
        limit: limit.count,
        windowSeconds: limit.windowSeconds,
      });
      const retryAfter = Math.max(1, ttlSeconds);
      if (res?.setHeader) res.setHeader('Retry-After', String(retryAfter));
      // Labelled IN PLACE (#182): the documented legacy top-level fields
      // (docs/POLICY.md, TROUBLESHOOTING.md) stay put; `errorCode` +
      // `metadata` (→ envelope `error.details`) are additive. QUOTA_EXCEEDED,
      // not RATE_LIMITED: the coarse throttle has a different remedy.
      const details = {
        code: 'rate_limited',
        tenantId,
        action,
        limit: limit.count,
        windowSeconds: limit.windowSeconds,
        retryAfterSeconds: retryAfter,
      };
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          errorCode: ErrorCode.QUOTA_EXCEEDED,
          message: 'quota exceeded',
          ...details,
          metadata: details,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
