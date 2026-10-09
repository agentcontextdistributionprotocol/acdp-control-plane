/**
 * QuotaGuard — applies `QuotaService.enforce` to every handler tagged
 * with `@CheckQuota(action)`. The limit lookup, store increment,
 * fail-open and 429 body all live in `QuotaService` (`quota.service.ts`).
 *
 * Lookup chain:
 *   1. No `@CheckQuota` metadata → pass through.
 *   2. Tenant = `req.tenantId` when it is a non-empty string, otherwise
 *      `DEFAULT_TENANT_ID` (anonymous / unpinned requests are metered
 *      under `default`, so a `default:<action>` rule applies to them).
 *   3. `QuotaService.enforce(tenant, action, res)` — passes, or throws
 *      429 with `Retry-After` set on the response.
 */
import { CanActivate, ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';
import { QUOTA_ACTION_KEY } from './check-quota.decorator';
import { QuotaAction } from './quota-config';
import { QuotaService } from './quota.service';

// Re-exported for existing importers; the tokens now live beside the service.
export { QUOTA_CONFIG, QUOTA_STORE } from './quota.service';

@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    // Optional, like the config/store it wraps: an app without QuotaModule
    // still boots and the guard is a no-op. Explicit @Inject: the
    // `| null` union serializes as `Object` in design:paramtypes.
    @Optional() @Inject(QuotaService) private readonly quota: QuotaService | null = null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<QuotaAction | undefined>(
      QUOTA_ACTION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!action) return true;
    if (!this.quota) return true;

    const req = context.switchToHttp().getRequest();
    const tenantId =
      typeof req.tenantId === 'string' && req.tenantId
        ? req.tenantId
        : DEFAULT_TENANT_ID;
    const res = req.res ?? context.switchToHttp().getResponse();
    await this.quota.enforce(tenantId, action, res);
    return true;
  }
}
