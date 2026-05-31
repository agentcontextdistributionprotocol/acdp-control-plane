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
