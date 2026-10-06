import { readScopes } from './scopes';
import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import {
  buildTenantLookup,
  DEFAULT_TENANT_ID,
  parseTenantApiKeys,
} from '../tenant/tenant-context';
import { assertNotReservedTenant } from '../tenant/request-tenant';
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
      let trusted;
      try {
        ({ claims, trusted } = await this.jwtValidator.verifyWithProvenance(token));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn({ msg: 'JWT auth rejected', error: msg });
        throw new UnauthorizedException('Invalid authorization token');
      }
      // Local issuance: DIDs are the canonical subject. Federated
      // tokens carry the same shape (sub = did:web:…). We use sub as
      // both actorId (for logging) and actorDid (for policy / revoke).
      request.actorId = claims.sub;
      request.actorDid = claims.sub;
      request.actorType = 'jwt';
      request.actorIsAdmin = false; // admin is api-key-gated today
      // Provenance: which issuer vouched for this token. A trusted-issuer
      // (federated) principal is distinguishable from a locally-issued one.
      request.actorIssuer = claims.iss;
      request.actorFederated = trusted !== null;
      // Expose JWT scopes for the PolicyGuard: the union of `scope`, `scopes`
      // and `scp` (see ./scopes.ts) — the same vocabulary the trusted-issuer
      // `requiredScope` gate reads.
      request.actorScopes = readScopes(claims);
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
      // Reserved-tenant guard (parity with the registry's
      // `reject_reserved_tenant`, commit c988ea4): `default` is the silent
      // column default for untenanted rows. Allowing a caller to *assert* it
      // (even via a signed claim) would alias the entire untenanted bucket — a
      // cross-boundary read. Untenanted access stays reachable only through the
      // *absence* of any assertion, never an explicit `default`.
      assertNotReservedTenant(claimTenant, 'token claim');
      assertNotReservedTenant(headerTenant, 'X-Tenant-Id header');
      if (claimTenant && headerTenant && headerTenant !== claimTenant) {
        this.logger.warn({
          msg: 'tenant assertion mismatch',
          claimTenant,
          headerTenant,
          sub: claims.sub,
        });
        throw new AppException(
          ErrorCode.TENANT_MISMATCH,
          'X-Tenant-Id does not match the tenant the token was issued under',
          HttpStatus.FORBIDDEN,
        );
      }
      // Strict mode (AUTH_REQUIRE_TENANT): an unbound token — one with no
      // `tenant` claim — cannot assert a tenant via the spoofable header,
      // so default-deny it. Mirrors the registry's `require_tenant`.
      if (this.config.requireTenant && !claimTenant) {
        this.logger.warn({ msg: 'strict tenant: token has no tenant claim', sub: claims.sub });
        throw new AppException(
          ErrorCode.TENANT_REQUIRED,
          'tenant required: token carries no tenant claim (AUTH_REQUIRE_TENANT)',
          HttpStatus.FORBIDDEN,
        );
      }
      // Header trust (parity with the registry's `tenant_header_trust`): a token
      // with NO tenant claim may not pick a tenant via the spoofable header
      // unless the operator declared a trusting boundary (`any_peer`). Reject
      // rather than ignore — ignoring would silently serve `default`. Runs after
      // the reserved/mismatch/strict checks, so those keep precedence.
      if (!claimTenant && headerTenant && this.config.tenantHeaderTrust !== 'any_peer') {
        this.logger.warn({
          msg: 'untrusted X-Tenant-Id on a token with no tenant claim',
          sub: claims.sub,
          iss: claims.iss,
          federated: trusted !== null,
        });
        throw new AppException(
          ErrorCode.TENANT_HEADER_UNTRUSTED,
          'X-Tenant-Id is not trusted for a token with no tenant claim (TENANT_HEADER_TRUST=none); ' +
            'use a tenant-bound token',
          HttpStatus.FORBIDDEN,
        );
      }
      request.tenantId = claimTenant ?? headerTenant ?? DEFAULT_TENANT_ID;
      // Per-issuer `read_only` (opt-in, #225): tokens from a TRUSTED_ISSUERS
      // entry flagged `read_only` may only use safe methods. Placed AFTER the
      // tenant checks so tenant 403s keep precedence. Method-based, not
      // route-based, so any future write route is covered automatically —
      // but a future state-changing GET would bypass it: never add one.
      if (trusted?.readOnly && !isSafeForReadOnlyIssuer(request)) {
        this.logger.warn({
          msg: 'read-only issuer: non-safe method denied',
          iss: claims.iss,
          sub: claims.sub,
          method: request.method,
          path: request.path,
        });
        throw new AppException(
          ErrorCode.ISSUER_READ_ONLY,
          'tokens from this issuer are read-only',
          HttpStatus.FORBIDDEN,
        );
      }
      return true;
    }

    const validTokens = this.config.authApiKeys;
    if (validTokens.length === 0) {
      if (this.config.requireTenant) {
        // Strict mode can't resolve a tenant for an unauthenticated
        // request, so default-deny rather than silently using `default`.
        throw new AppException(
          ErrorCode.TENANT_REQUIRED,
          'tenant required but no AUTH_API_KEYS configured (AUTH_REQUIRE_TENANT)',
          HttpStatus.FORBIDDEN,
        );
      }
      this.logger.warn('No AUTH_API_KEYS configured; allowing request');
      request.tenantId = DEFAULT_TENANT_ID;
      return true;
    }

    if (!constantTimeIncludes(validTokens, token)) {
      throw new UnauthorizedException('Invalid authorization token');
    }

    request.actorId = token.slice(0, 8) + '...';
    request.actorType = 'api-key';
    request.actorFederated = false; // actorIssuer stays unset: no JWT issuer
    request.actorIsAdmin = constantTimeIncludes(this.config.authAdminApiKeys, token);
    const keyTenant = this.tenantFor(token);
    // Parity with the JWT path: a header asserting a tenant other than the
    // one the key is bound to is hostile. We only enforce this for bound
    // keys — a bare (unbound) key resolves to `default` and never honors
    // the spoofable header, so there's nothing to disagree with.
    const apiKeyHeaderTenant = readHeaderTenant(request.headers);
    // Reserved-tenant guard: a request may never *assert* `default` via the
    // header (see the JWT path above). A key resolving to `default` through
    // the absence of a binding is still legitimate untenanted access.
    assertNotReservedTenant(apiKeyHeaderTenant, 'X-Tenant-Id header');
    if (
      keyTenant !== DEFAULT_TENANT_ID &&
      apiKeyHeaderTenant &&
      apiKeyHeaderTenant !== keyTenant
    ) {
      this.logger.warn({
        msg: 'tenant assertion mismatch',
        keyTenant,
        headerTenant: apiKeyHeaderTenant,
      });
      throw new AppException(
        ErrorCode.TENANT_MISMATCH,
        'X-Tenant-Id does not match the tenant this API key is bound to',
        HttpStatus.FORBIDDEN,
      );
    }
    // Strict mode: a bare (unbound) API key can't assert a tenant.
    if (this.config.requireTenant && keyTenant === DEFAULT_TENANT_ID) {
      throw new AppException(
        ErrorCode.TENANT_REQUIRED,
        'tenant required: API key is not bound to a tenant (AUTH_REQUIRE_TENANT)',
        HttpStatus.FORBIDDEN,
      );
    }
    request.tenantId = keyTenant;
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

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether a request from a `read_only` issuer may proceed: GET/HEAD/OPTIONS,
 * plus `POST /auth/introspect` (RFC 7662 mandates POST; it is read-shaped and
 * never mutates). Path match is normalised (case, trailing slashes) the way
 * Express routes it.
 */
function isSafeForReadOnlyIssuer(request: { method?: string; path?: string }): boolean {
  const method = (request.method ?? '').toUpperCase();
  if (SAFE_METHODS.has(method)) return true;
  const path = (request.path ?? '').toLowerCase().replace(/\/+$/, '');
  return method === 'POST' && path === '/auth/introspect';
}

/**
 * Constant-time membership test for a secret `token` against a list of valid
 * secrets. Both sides are SHA-256-hashed first so the comparison is over
 * fixed-length (32-byte) buffers — this makes `timingSafeEqual` length-safe
 * and removes the byte-wise short-circuit timing oracle that `===` /
 * `Array.prototype.includes` leak. We deliberately scan the ENTIRE list (no
 * early return on match) so the time does not depend on the match position.
 */
function constantTimeIncludes(candidates: string[], token: string): boolean {
  const tokenHash = createHash('sha256').update(token).digest();
  let matched = false;
  for (const candidate of candidates) {
    const candidateHash = createHash('sha256').update(candidate).digest();
    if (timingSafeEqual(candidateHash, tokenHash)) {
      matched = true;
    }
  }
  return matched;
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
