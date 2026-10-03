/**
 * QuotaGuard — runs the configured `QuotaStore` on every handler
 * tagged with `@CheckQuota(action)`. Limits are sourced from
 * `TENANT_QUOTAS` (see `quota-config.ts`).
 *
 * Lookup chain (cheap to expensive):
 *   1. No `@CheckQuota` metadata → pass through.
 *   2. No tenantId on the request → pass through (anonymous routes
 *      aren't rate-limited per-tenant; rely on the global throttler).
 *   3. No limit configured for `(tenantId, action)` → pass through.
 *   4. Store INCR; if `count > limit.count` → 429 with `Retry-After`.
 *
 * Fail-open is deliberate: a Redis outage MUST NOT take down the
 * control plane. The store returns `{count: 0, ttlSeconds: 0}` on
 * transport failure; the guard treats `count == 0` as "no signal"
 * and lets the request through. Operators see the warn log from
 * `RedisQuotaStore.increment`.
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
import { QUOTA_ACTION_KEY } from './check-quota.decorator';
import {
  ParsedQuotaConfig,
  QuotaAction,
  resolveLimit,
} from './quota-config';
import { QuotaStore } from './quota-store';

export const QUOTA_CONFIG = Symbol('QUOTA_CONFIG');
export const QUOTA_STORE = Symbol('QUOTA_STORE');

@Injectable()
export class QuotaGuard implements CanActivate {
  private readonly logger = new Logger(QuotaGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(QUOTA_CONFIG) private readonly config: ParsedQuotaConfig | null = null,
    @Optional() @Inject(QUOTA_STORE) private readonly store: QuotaStore | null = null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<QuotaAction | undefined>(
      QUOTA_ACTION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!action) return true;
    if (!this.config || !this.store) return true;

    const req = context.switchToHttp().getRequest();
    const tenantId =
      typeof req.tenantId === 'string' && req.tenantId
        ? req.tenantId
        : DEFAULT_TENANT_ID;

    const limit = resolveLimit(this.config, tenantId, action);
    if (!limit) return true; // no rule for this (tenant, action) — unconstrained

    const key = `acdp:quota:${tenantId}:${action}`;
    const { count, ttlSeconds } = await this.store.increment(key, limit.windowSeconds);
    if (count === 0) {
      // Store unavailable — fail open (already warned by the store).
      return true;
    }

    if (count > limit.count) {
      this.logger.warn(
        `quota exceeded: tenant=${tenantId} action=${action} ` +
          `count=${count}/${limit.count} window=${limit.windowSeconds}s`,
      );
      const retryAfter = Math.max(1, ttlSeconds);
      const res = req.res ?? context.switchToHttp().getResponse();
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
    return true;
  }
}
