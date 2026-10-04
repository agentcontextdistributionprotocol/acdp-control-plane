/**
 * Auth endpoints — Phase-5: the control plane as IdP.
 *
 *   POST /auth/challenge   request a one-shot signing input
 *   POST /auth/token       exchange a signed challenge for a JWT
 *
 * Both are marked `@Public()` — the AuthGuard skips them so an agent
 * doesn't need a bearer token to ask for a bearer token. The endpoints
 * are mounted only when `TOKEN_ISSUANCE_ENABLED=true` (see auth.module).
 *
 * ## Throttling
 *
 * Both endpoints carry a tighter `@Throttle` override (20/min/IP) than
 * the global default (200/min). Defends against:
 *   - Nonce-grinding: brute-forcing the 24-byte nonce space — already
 *     intractable, but capping the rate makes opportunistic abuse cheap
 *     to ignore.
 *   - Credential-stuffing: an attacker who scraped a list of (agent_id,
 *     stolen signature) pairs can't pump them at 200/min.
 *   - Resource exhaustion: each `/auth/token` triggers a did:web fetch,
 *     a signature verify, a DB write — limiting the rate protects the
 *     resolver + DB from being a DoS lever.
 *
 * The tracker comes from ThrottleByUserGuard: `req.actorId`, else the
 * normalized `req.ip`. Since these routes are `@Public()`, actorId is unset
 * and the bucket keys on caller IP — an IPv6 caller on its `/64` network
 * (`THROTTLE_IPV6_SUBNET_PREFIX`, issue #187), so rotating addresses inside
 * one allocation does not reset the 20/min budget. Operators behind a proxy
 * MUST set `TRUST_PROXY` (a hop count or the proxies' CIDRs; `true` is
 * rejected at startup) so the bucket keys on the real client, not the proxy.
 */
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import {
  AuthErrorDto,
  ChallengeRequestDto,
  ChallengeResponseDto,
  TokenRequestDto,
  TokenResponseDto,
} from './dto/auth.dto';
import { Public } from './public.decorator';
import { TokenIssuer } from './token-issuer.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly issuer: TokenIssuer) {}

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post('challenge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a one-shot signing input',
    description:
      'Returns a server-generated nonce + canonical signing input. The agent signs it with ' +
      'its declared key and exchanges the signature for a bearer JWT via `POST /auth/token`. ' +
      'Endpoint is publicly reachable — the AuthGuard skips it so an agent doesn’t need a ' +
      'bearer to ask for one.',
  })
  @ApiBody({ type: ChallengeRequestDto })
  @ApiOkResponse({ type: ChallengeResponseDto, description: 'Fresh challenge record.' })
  @ApiBadRequestResponse({ type: AuthErrorDto, description: 'Malformed agent_id.' })
  async challenge(@Body() body: ChallengeRequestDto): Promise<ChallengeResponseDto> {
    const rec = await this.issuer.issueChallenge(body.agent_id);
    return {
      nonce: rec.nonce,
      registry_authority: rec.registryAuthority,
      expires_at: rec.expiresAt,
      signing_input: rec.signingInput,
    };
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post('token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a signed challenge for a bearer JWT',
    description:
      'Verifies the signature against the agent’s pinned public key (V1) or did:web ' +
      'verificationMethod (V2). On success, issues an HS256 JWT carrying `acdp` claims. ' +
      'Tokens are short-lived; clients should refresh proactively (see TokenManager).',
  })
  @ApiBody({ type: TokenRequestDto })
  @ApiOkResponse({ type: TokenResponseDto, description: 'Freshly minted JWT + expiry.' })
  @ApiBadRequestResponse({
    type: AuthErrorDto,
    description: 'Unsupported algorithm or malformed signature.',
  })
  @ApiUnauthorizedResponse({
    type: AuthErrorDto,
    description:
      'Unknown nonce, expired challenge, agent_id mismatch, missing pinned key, or bad signature.',
  })
  async token(
    @Body() body: TokenRequestDto,
    @Req() req: Request,
  ): Promise<TokenResponseDto> {
    const out = await this.issuer.issueToken(
      {
        agentDid: body.agent_id,
        keyId: body.key_id,
        nonce: body.nonce,
        expiresAt: body.expires_at,
        algorithm: body.algorithm,
        signature: body.signature,
      },
      { signerIp: extractIp(req) },
    );
    return {
      token: out.token,
      token_type: out.tokenType,
      expires_at: out.expiresAt,
    };
  }
}

/**
 * Caller IP for the issuance-ledger audit field: Express's `req.ip`, which is
 * the real client only when `TRUST_PROXY` names the proxies in front of the
 * control plane (see `src/common/trust-proxy.ts`). `X-Forwarded-For` is
 * deliberately NOT read here: its leftmost entry is whatever the client
 * wrote — spoofable with or without a proxy — and unbounded, while
 * `signer_ip` is `varchar(64)`.
 */
export function extractIp(req: Pick<Request, 'ip'>): string | undefined {
  return typeof req.ip === 'string' && req.ip.length > 0 ? req.ip : undefined;
}
