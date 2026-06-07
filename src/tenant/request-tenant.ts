/**
 * Tenant-aware request helpers for controllers.
 *
 * The `AuthGuard` pins the caller's tenant id on `request.tenantId`
 * (resolved from the API key or JWT tenant claim). Controllers read it
 * through `tenantOf(req)` and thread it into repositories / services so
 * the `WHERE tenant_id = …` boundary is enforced on every query.
 *
 * V1 single-tenant deployments fall back to `DEFAULT_TENANT_ID` when no
 * tenant was resolved, matching the repository defaults.
 */
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { DEFAULT_TENANT_ID } from './tenant-context';

/** An Express request carrying the AuthGuard-pinned tenant id. */
export type TenantedRequest = Request & { tenantId?: string };

/** Pull the AuthGuard-pinned tenant id, with a safe default. */
export function tenantOf(req: TenantedRequest): string {
  return typeof req.tenantId === 'string' && req.tenantId
    ? req.tenantId
    : DEFAULT_TENANT_ID;
}

/**
 * Reject an *explicit* assertion of the reserved `default` tenant. The
 * untenanted bucket is reachable only through the absence of an assertion
 * (a `null`/omitted value), never by naming `default` — naming it would let a
 * caller address the entire untenanted bucket. Mirrors the registry's
 * `reject_reserved_tenant`. `null`/omitted passes through untouched.
 */
export function assertNotReservedTenant(
  tenant: string | null | undefined,
  source: string,
): void {
  if (tenant === DEFAULT_TENANT_ID) {
    throw new ForbiddenException(
      `'${DEFAULT_TENANT_ID}' is a reserved tenant sentinel and cannot be ` +
        `asserted via ${source}`,
    );
  }
}
