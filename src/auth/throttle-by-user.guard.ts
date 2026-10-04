import { ExecutionContext, Injectable } from '@nestjs/common';
import { normalizeIp, ThrottlerGuard } from '@nestjs/throttler';

/**
 * Coarse per-principal rate limit (the 2nd APP_GUARD).
 *
 * Tracker resolution:
 *   - Authenticated (`req.actorId` pinned by AuthGuard) → the principal,
 *     byte-for-byte as before. Rotating source addresses does not help an
 *     authenticated caller; nor does sharing an address hurt one.
 *   - Unauthenticated (`@Public()` routes — AuthGuard returns before pinning
 *     `actorId`) → the client IP, normalized by the throttler's own exported
 *     `normalizeIp` (issue #187): IPv4 as-is, IPv4-mapped IPv6
 *     (`::ffff:a.b.c.d`) collapsed onto its IPv4, and every other IPv6
 *     address masked to its `/<ipv6SubnetPrefix>` network (default /64,
 *     `THROTTLE_IPV6_SUBNET_PREFIX`). A host that holds a /64 — the normal
 *     single-site allocation — can otherwise rotate source addresses to get
 *     a fresh bucket per request. `this.ipv6SubnetPrefix` is the base class's
 *     field, set from the module options' `ipv6SubnetPrefix` in
 *     `ThrottlerGuard.onModuleInit` (object-form options only — see
 *     `app.module.ts`).
 *   - No usable IP → the shared `'anonymous'` bucket, never an empty key.
 */
@Injectable()
export class ThrottleByUserGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    if (req.actorId !== undefined && req.actorId !== null) {
      return String(req.actorId);
    }
    const ip = req.ip;
    if (typeof ip !== 'string' || ip.length === 0) return 'anonymous';
    return normalizeIp(ip, this.ipv6SubnetPrefix);
  }

  protected getRequestResponse(context: ExecutionContext) {
    const ctx = context.switchToHttp();
    return { req: ctx.getRequest(), res: ctx.getResponse() };
  }
}
