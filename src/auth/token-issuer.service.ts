/**
 * Token issuer — the IdP role for the control plane (V2 Seam foundation).
 *
 * Orchestrates:
 *   1. issueChallenge() — mint a one-shot nonce + canonical signing input
 *   2. issueToken()     — verify the agent's Ed25519 signature over the
 *                         signing input, then mint an HS256 JWT whose
 *                         claim shape matches the registry's BearerClaims
 *                         (so consumers can validate either issuer's
 *                         tokens with the same code path in V2).
 *   3. verifyJwt()      — verify signature + consult the revocation
 *                         repository so admin-revoked tokens are
 *                         rejected even before they naturally expire.
 *
 * Every decision point in `issueToken` writes one row to the
 * `IssuanceLedgerService` so compliance auditors have a complete
 * record of who requested what, when, from where, and why we
 * accepted or rejected.
 *
 * Splitting the orchestration out of the controller keeps validation
 * decisions testable without spinning up the HTTP layer.
 */
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

import { AppConfigService } from '../config/app-config.service';
import { ChallengeStore, ChallengeRecord } from './challenge-store.service';
import { DidWebResolverService } from './did-web/did-web-resolver.service';
import { verifySignatureB64 } from './acdp-verify';
import { signJwt, verifyJwt } from './jwt-codec';
import { IssuanceLedgerService } from './issuance-ledger.service';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';
import {
  buildAgentTenantLookup,
  parseTenantAgents,
  tenantForAgent,
} from '../tenant/tenant-agents';
import { PinnedKey, PinnedKeysService } from './pinned-keys.service';
import {
  REVOCATION_REPOSITORY,
  RevocationRepository,
} from './revocation-repository';
import { SigningMaterialService } from './signing-material.service';

const SUPPORTED_SIGNATURE_ALGORITHMS = new Set(['ed25519', 'ecdsa-p256']);

export interface IssuedToken {
  token: string;
  tokenType: string;
  expiresAt: number;
}

export interface AcdpBearerClaims {
  iss: string;
  sub: string;
  /**
   * Audience the token is bound to (the issuing authority). Validated on
   * local verification so a token minted for this CP can't be replayed at
   * a different audience. Optional for backward compatibility with V0
   * tokens minted before audience binding. Typed `string | string[]` to
   * stay compatible with federated tokens (RFC 7519 permits an array
   * audience); CP itself always mints a single string.
   */
  aud?: string | string[];
  jti: string;
  iat: number;
  exp: number;
  acdp: { registry: string; key_id: string };
  /**
   * Tenant the token was issued under. When present, downstream guards
   * use this as the authoritative tenant for the request — preferred
   * over the X-Tenant-Id header so a caller can't forge a tenant they
   * weren't actually issued for. Optional for backward compatibility
   * with V0 tokens that pre-date tenant binding; absent → 'default'.
   */
  tenant?: string;
}

/**
 * Caller context for issueToken — currently just the actor IP for
 * audit. Other fields (user-agent, request id) can be added without
 * breaking callers because the type is structural.
 */
export interface IssueTokenContext {
  signerIp?: string;
}

@Injectable()
export class TokenIssuer {
  private readonly logger = new Logger(TokenIssuer.name);
  /** Lazy lookup, built from TENANT_AGENTS at first mint. */
  private agentTenantLookup: Map<string, string> | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly challenges: ChallengeStore,
    private readonly pinned: PinnedKeysService,
    private readonly signing: SigningMaterialService,
    @Optional()
    @Inject(REVOCATION_REPOSITORY)
    private readonly revocations: RevocationRepository | null = null,
    @Optional() private readonly ledger: IssuanceLedgerService | null = null,
    /**
     * Optional did:web resolver. When present AND the agent isn't
     * pinned, we fall through to resolve the key from the DID
     * document. Pinned-keys-first is deliberate per deferred-plan
     * §1: lets operators stage emergency key revocations locally.
     */
    @Optional() private readonly didWebResolver: DidWebResolverService | null = null,
  ) {}

  // ── Step 1 — challenge ────────────────────────────────────────────────

  async issueChallenge(agentDid: string): Promise<ChallengeRecord> {
    return this.challenges.issue(
      agentDid,
      this.config.jwtAuthority,
      this.config.challengeTtlSeconds,
    );
  }

  // ── Step 2 — token ────────────────────────────────────────────────────

  async issueToken(
    req: {
      agentDid: string;
      keyId: string;
      nonce: string;
      expiresAt: number;
      algorithm: string;
      signature: string;
    },
    ctx: IssueTokenContext = {},
  ): Promise<IssuedToken> {
    if (!SUPPORTED_SIGNATURE_ALGORITHMS.has(req.algorithm)) {
      this.ledger?.record({
        sub: req.agentDid,
        iss: this.config.jwtAuthority,
        signerIp: ctx.signerIp,
        decision: 'reject_alg',
        decisionDetail: `algorithm=${req.algorithm}`,
      });
      throw new BadRequestException(
        `Unsupported signature algorithm: '${req.algorithm}' ` +
          `(supported: ${Array.from(SUPPORTED_SIGNATURE_ALGORITHMS).join(', ')})`,
      );
    }

    // Consume the challenge — this also enforces single-use replay
    // defense and TTL expiry (atomic via DELETE..RETURNING when on
    // Postgres, so two concurrent /auth/token calls can't both win).
    const record = await this.challenges.consume(req.nonce);
    if (!record) {
      this.ledger?.record({
        sub: req.agentDid,
        iss: this.config.jwtAuthority,
        signerIp: ctx.signerIp,
        decision: 'reject_nonce',
        decisionDetail: 'unknown, expired, or already-used',
      });
      throw new UnauthorizedException(
        'Unknown, expired, or already-used nonce',
      );
    }

    // Cross-check the claimed agent_did matches the one that requested
    // the challenge. If a caller could swap agent_id between
    // challenge and token, they could impersonate any pinned identity.
    if (record.agentDid !== req.agentDid) {
      this.ledger?.record({
        sub: req.agentDid,
        iss: this.config.jwtAuthority,
        signerIp: ctx.signerIp,
        decision: 'reject_agent_mismatch',
        decisionDetail: `challenge=${record.agentDid} got=${req.agentDid}`,
      });
      throw new UnauthorizedException(
        `agent_id does not match challenge owner: ` +
          `challenge=${record.agentDid} got=${req.agentDid}`,
      );
    }
    if (record.expiresAt !== req.expiresAt) {
      this.ledger?.record({
        sub: req.agentDid,
        iss: this.config.jwtAuthority,
        signerIp: ctx.signerIp,
        decision: 'reject_expires_mismatch',
        decisionDetail: `challenge=${record.expiresAt} got=${req.expiresAt}`,
      });
      throw new UnauthorizedException(
        `expires_at does not match challenge: ` +
          `challenge=${record.expiresAt} got=${req.expiresAt}`,
      );
    }

    // Resolve the public key. Fallback chain per deferred-plan §1:
    //   1. PinnedKeysService.get() — lets operators stage emergency
    //      key revocations locally, overriding the DID document.
    //   2. DidWebResolverService.resolveKey() — when an agent_id is
    //      a did:web DID and isn't pinned, resolve from the DID
    //      document's verificationMethod (SSRF-guarded; see
    //      did-web/ssrf-guard.ts).
    let pinned: PinnedKey | undefined = this.pinned.get(req.agentDid);
    if (!pinned && this.didWebResolver && isDidWeb(req.agentDid)) {
      pinned = await this.resolveDidWebKey(req, ctx);
      if (!pinned) {
        // resolveDidWebKey already logged + recorded the rejection.
        throw new UnauthorizedException(
          `agent_did '${req.agentDid}' could not be resolved via did:web`,
        );
      }
    }
    if (!pinned) {
      this.ledger?.record({
        sub: req.agentDid,
        iss: this.config.jwtAuthority,
        signerIp: ctx.signerIp,
        decision: 'reject_unpinned',
      });
      throw new UnauthorizedException(
        `agent_did '${req.agentDid}' has no pinned public key on this control plane`,
      );
    }

    // Algorithm-downgrade defense: the request's signature.algorithm
    // MUST match the pinned key's algorithm. Without this, a stolen
    // Ed25519 key could be claimed against an ECDSA-pinned agent and
    // routed to the wrong verifier (or vice versa). Mirrors the
    // registry's check in `acdp-registry-core::playground.rs`.
    if (req.algorithm !== pinned.algorithm) {
      this.ledger?.record({
        sub: req.agentDid,
        iss: this.config.jwtAuthority,
        signerIp: ctx.signerIp,
        decision: 'reject_alg',
        decisionDetail: `request=${req.algorithm} pinned=${pinned.algorithm}`,
      });
      throw new UnauthorizedException(
        `signature.algorithm '${req.algorithm}' does not match pinned algorithm ` +
          `'${pinned.algorithm}' for ${req.agentDid}`,
      );
    }

    // Verify the signature over the canonical signing input.
    const ok = verifySignatureB64(
      pinned.algorithm,
      pinned.rawB64,
      record.signingInput,
      req.signature,
    );
    if (!ok) {
      this.ledger?.record({
        sub: req.agentDid,
        iss: this.config.jwtAuthority,
        signerIp: ctx.signerIp,
        decision: 'reject_signature',
      });
      throw new UnauthorizedException('Signature verification failed');
    }

    // Mint the JWT.
    const issued = this.mintJwt(req.agentDid, req.keyId);
    const decoded = jwt.decode(issued.token) as AcdpBearerClaims;
    this.ledger?.record({
      jti: decoded.jti,
      sub: decoded.sub,
      iss: decoded.iss,
      iat: decoded.iat,
      exp: decoded.exp,
      signerIp: ctx.signerIp,
      decision: 'mint',
      decisionDetail: `key_id=${req.keyId}`,
    });
    return issued;
  }

  // ── verify (for downstream guards / federation experiments) ──────────

  async verifyJwt(token: string): Promise<AcdpBearerClaims> {
    let decoded: AcdpBearerClaims;
    try {
      decoded = verifyJwt(token, {
        algorithms: [this.signing.material.algorithm],
        key: this.signing.material.verifyKey,
        issuer: this.config.jwtAuthority,
        audience: this.config.jwtAudience,
      }) as unknown as AcdpBearerClaims;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new UnauthorizedException(`JWT verification failed: ${msg}`);
    }

    // Revocation check — short-circuits even when the JWT's own `exp`
    // hasn't passed. Optional dep: in the tiny config that disables
    // the revocation repository, we skip the check (and accept the
    // V1 behavior of "tokens are valid until they expire").
    if (this.revocations) {
      const revoked = await this.revocations.isRevoked(decoded.jti);
      if (revoked) {
        throw new UnauthorizedException(`token jti=${decoded.jti} has been revoked`);
      }
    }

    return decoded;
  }

  /**
   * Decode a JWT without verifying — used by the revoke endpoint to
   * extract `jti`/`sub`/`exp` so we can persist the revocation even
   * if the token has already expired (operators may want the audit
   * trail). Callers MUST verify separately before trusting claims.
   */
  decodeJwt(token: string): AcdpBearerClaims | null {
    try {
      const decoded = jwt.decode(token);
      if (decoded && typeof decoded === 'object') {
        return decoded as AcdpBearerClaims;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ── internals ────────────────────────────────────────────────────────

  /**
   * Resolve a `did:web` agent's public key via the DID document.
   *
   * Returns a `PinnedKey`-shaped record so the dispatch / verify
   * path below stays uniform with the pinned-key case. Returns
   * `undefined` (after logging + recording the ledger row) when
   * resolution fails — caller treats that as the same final
   * `reject_unpinned` outcome.
   *
   * Uses the request's `algorithm` to pick the verification method,
   * which the resolver's binding-backed key extraction enforces against
   * `assertionMethod` and the method's key type (downgrade defense).
   */
  private async resolveDidWebKey(
    req: { agentDid: string; keyId: string; algorithm: string },
    ctx: IssueTokenContext,
  ): Promise<PinnedKey | undefined> {
    if (!this.didWebResolver) return undefined;
    try {
      const resolved = await this.didWebResolver.resolveKey(
        req.keyId.startsWith(req.agentDid) ? req.keyId : `${req.agentDid}#${req.keyId}`,
        req.algorithm as 'ed25519' | 'ecdsa-p256',
      );
      this.logger.log(
        `did:web fallback resolved ${req.agentDid} via ${resolved.keyId} (${resolved.algorithm})`,
      );
      return {
        agentDid: req.agentDid,
        algorithm: resolved.algorithm,
        rawB64: resolved.publicKeyB64,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`did:web resolution failed for ${req.agentDid}: ${msg}`);
      this.ledger?.record({
        sub: req.agentDid,
        iss: this.config.jwtAuthority,
        signerIp: ctx.signerIp,
        decision: 'reject_unpinned',
        decisionDetail: `did:web resolution failed: ${msg}`,
      });
      return undefined;
    }
  }

  private mintJwt(agentDid: string, keyId: string): IssuedToken {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + this.config.jwtTtlSeconds;
    // `nbf` (not-before) added for federation hygiene (#2): when a
    // cross-issuer consumer has a slightly skewed clock, `nbf == iat`
    // bounds the acceptable window without admitting future-dated
    // tokens. `jsonwebtoken` enforces it automatically on verify.
    if (this.agentTenantLookup === null) {
      this.agentTenantLookup = buildAgentTenantLookup(
        parseTenantAgents(this.config.tenantAgentsRaw),
      );
    }
    const tenant = tenantForAgent(this.agentTenantLookup, agentDid);
    const claims: AcdpBearerClaims & { nbf: number } = {
      iss: this.config.jwtAuthority,
      sub: agentDid,
      aud: this.config.jwtAudience,
      jti: randomBytes(12).toString('base64url'),
      iat: now,
      nbf: now,
      exp,
      acdp: {
        registry: this.config.jwtAuthority,
        key_id: keyId,
      },
    };
    // Only stamp a `tenant` claim for an explicitly-mapped agent. An unmapped
    // agent resolves to the reserved `default` sentinel, which the AuthGuard
    // REJECTS when asserted (parity with the registry's reject_reserved_tenant)
    // — so stamping it here would make our own token unusable. Untenanted
    // access is reachable only through the ABSENCE of the claim.
    if (tenant !== DEFAULT_TENANT_ID) {
      claims.tenant = tenant;
    }
    const token = signJwt(claims as unknown as Record<string, unknown>, {
      algorithm: this.signing.material.algorithm,
      key: this.signing.material.signingKey,
      // `kid` lets verifiers (local + federated) pick the right key during
      // rotation. EdDSA publishes the matching kid in /.well-known/jwks.json.
      keyid: this.signing.material.kid,
    });
    return { token, tokenType: 'Bearer', expiresAt: exp };
  }
}

function isDidWeb(did: string): boolean {
  return did.startsWith('did:web:');
}
