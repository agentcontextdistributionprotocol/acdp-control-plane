import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppConfigService } from '../config/app-config.service';
import {
  buildTenantLookup,
  DEFAULT_TENANT_ID,
  parseTenantApiKeys,
} from '../tenant/tenant-context';
import { CrossIssuerValidator } from './cross-issuer-validator.service';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  /**
   * `apiKey → tenantId` lookup built at first `canActivate`. Lazy
   * init avoids parsing in the constructor (which the linter prefers
   * for testability — tests can swap the config without triggering
   * unwanted side effects).
   */
  private tenantLookup: Map<string, string> | null = null;

  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfigService,
    /**
     * Optional JWT validator. Present when TOKEN_ISSUANCE_ENABLED=true
     * (AuthModule.forRoot registers it). When absent, the guard falls
     * back to api-key-only authentication and JWT-shaped tokens are
     * rejected as "invalid token".
     */
    @Optional()
    @Inject(CrossIssuerValidator)
    private readonly jwtValidator: CrossIssuerValidator | null = null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers?.authorization;

    if (!authHeader) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    if (!token) {
      throw new UnauthorizedException('Empty authorization token');
    }

    // Dispatch on token shape. A compact JWT has exactly two dots
    // separating three base64url segments; api keys are opaque
    // strings without that structure. We do NOT fall back from a
    // failed JWT verify to api-key matching — silently accepting a
    // forged-but-malformed JWT as an api-key would be an oracle.
    if (looksLikeJwt(token)) {
      if (!this.jwtValidator) {
        throw new UnauthorizedException(
          'JWT presented but TOKEN_ISSUANCE_ENABLED=false',
        );
      }
      let claims;
      try {
        claims = await this.jwtValidator.verify(token);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`JWT auth rejected: ${msg}`);
        throw new UnauthorizedException('Invalid authorization token');
      }
      // Local issuance: DIDs are the canonical subject. Federated
      // tokens carry the same shape (sub = did:web:…). We use sub as
      // both actorId (for logging) and actorDid (for policy / revoke).
      request.actorId = claims.sub;
      request.actorDid = claims.sub;
      request.actorType = 'jwt';
      request.actorIsAdmin = false; // admin is api-key-gated today
      // Expose JWT scopes for the PolicyGuard. Accepts an OAuth-style
      // space-delimited `scope` string or a `scopes` array.
      request.actorScopes = extractScopes(claims);
      // Tenant binding order of precedence (claim > header):
      //   1. `tenant` claim in the JWT (authoritative — minted by the
      //      issuer, signed, can't be forged by the bearer).
      //   2. `X-Tenant-Id` header (legacy; trust-on-input).
      //   3. DEFAULT_TENANT_ID.
      // If both 1 and 2 are present and disagree, reject — the
      // header is asserting a tenant the issuer didn't actually
      // bind. That's a hostile request.
      const headerTenant = readHeaderTenant(request.headers);
      const claimTenant =
        typeof (claims as { tenant?: unknown }).tenant === 'string' &&
        (claims as { tenant: string }).tenant.length > 0
          ? (claims as { tenant: string }).tenant
          : null;
      if (claimTenant && headerTenant && headerTenant !== claimTenant) {
        this.logger.warn(
          `tenant assertion mismatch: claim=${claimTenant} header=${headerTenant} sub=${claims.sub}`,
        );
        throw new ForbiddenException(
          'X-Tenant-Id does not match the tenant the token was issued under',
        );
      }
      request.tenantId = claimTenant ?? headerTenant ?? DEFAULT_TENANT_ID;
      return true;
    }

    const validTokens = this.config.authApiKeys;
    if (validTokens.length === 0) {
      this.logger.warn('No AUTH_API_KEYS configured; allowing request');
      request.tenantId = DEFAULT_TENANT_ID;
      return true;
    }

    if (!validTokens.includes(token)) {
      throw new UnauthorizedException('Invalid authorization token');
    }

    request.actorId = token.slice(0, 8) + '...';
    request.actorType = 'api-key';
    request.actorIsAdmin = this.config.authAdminApiKeys.includes(token);
    request.tenantId = this.tenantFor(token);
    request.actorScopes = []; // api keys carry no scopes

    return true;
  }

  private tenantFor(apiKey: string): string {
    if (this.tenantLookup === null) {
      this.tenantLookup = buildTenantLookup(parseTenantApiKeys(this.config.tenantApiKeysRaw));
    }
    return this.tenantLookup.get(apiKey) ?? DEFAULT_TENANT_ID;
  }
}

/**
 * RFC 7519 compact-JWT shape: three base64url segments separated by
 * dots. We don't enforce the segment alphabet here — that's the
 * verifier's job — but the dot count uniquely separates JWTs from
 * opaque api keys (which the rest of the codebase has never let
 * contain '.').
 */
function looksLikeJwt(token: string): boolean {
  return token.split('.').length === 3;
}

/**
 * Extract scopes from JWT claims. Supports the OAuth-style space-delimited
 * `scope` string and a `scopes` array claim. Returns [] when neither is set.
 */
function extractScopes(claims: unknown): string[] {
  const c = claims as { scope?: unknown; scopes?: unknown };
  if (Array.isArray(c.scopes)) {
    return c.scopes.filter((s): s is string => typeof s === 'string');
  }
  if (typeof c.scope === 'string') {
    return c.scope.split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(c.scope)) {
    return c.scope.filter((s): s is string => typeof s === 'string');
  }
  return [];
}

function readHeaderTenant(headers: unknown): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const v = (headers as Record<string, unknown>)['x-tenant-id'];
  if (typeof v === 'string') {
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}
