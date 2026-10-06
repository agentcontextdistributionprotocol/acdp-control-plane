/**
 * Token revocation — RFC 7009-style endpoint.
 *
 * POST /auth/token/revoke
 *   Body: { token: "<jwt>", reason?: "<one of RevocationReason>" }
 *
 * Behavior:
 *   - Caller must present a valid bearer token (AuthGuard).
 *   - Authorization: a caller may revoke a token IFF
 *       (a) the caller is an admin (api key listed in
 *           `AUTH_ADMIN_API_KEYS`), or
 *       (b) the caller authenticated via JWT AND the token's `sub`
 *           claim matches the caller's DID (`request.actorDid`).
 *     Everyone else gets 403. Mirrors the registry's
 *     `acdp-registry-auth::service::revoke_token` semantics
 *     (`owner_of(jti) == caller_did`).
 *   - The endpoint returns 200 OK even for tokens that aren't valid
 *     under our key (RFC 7009 §2.2 — "unrecognized" must still
 *     succeed) to avoid an oracle that confirms token validity.
 *   - The endpoint is throttled separately from the main auth path:
 *     a flood of revoke requests must not exhaust the rate limiter
 *     for the rest of the auth surface.
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
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { BEARER_TOKEN_MAX_LENGTH } from './dto/auth.dto';
import { ApiProperty } from '@nestjs/swagger';
import type { Request } from 'express';
import { Inject } from '@nestjs/common';
import {
  REVOCATION_REPOSITORY,
  RevocationReason,
  RevocationRepository,
} from './revocation-repository';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { TokenIssuer } from './token-issuer.service';

const REASONS: RevocationReason[] = [
  'user_logout',
  'admin_revoke',
  'key_rotation',
  'security_incident',
  'unspecified',
];

export class RevokeRequestDto {
  @ApiProperty({
    description: 'The JWT to revoke. Pass the raw token value, not the Bearer header.',
    example: 'eyJhbGciOi...',
    maxLength: BEARER_TOKEN_MAX_LENGTH,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(BEARER_TOKEN_MAX_LENGTH)
  token!: string;

  @ApiProperty({
    description: 'Why the token is being revoked (audited).',
    enum: REASONS,
    required: false,
    default: 'unspecified',
  })
  @IsOptional()
  @IsString()
  @IsIn(REASONS)
  reason?: RevocationReason;
}

export class RevokeResponseDto {
  @ApiProperty({
    description:
      'Whether this call newly added the token to the revocation list. ' +
      '`false` means it was already revoked, or the token did not need to be revoked ' +
      '(e.g. already expired, signature did not validate under our key).',
    example: true,
  })
  revoked!: boolean;
}

@ApiTags('auth')
@Controller('auth/token')
export class RevokeController {
  private readonly logger = new Logger(RevokeController.name);

  constructor(
    private readonly issuer: TokenIssuer,
    @Inject(REVOCATION_REPOSITORY)
    private readonly revocations: RevocationRepository,
  ) {}

  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Revoke a previously-issued bearer JWT',
    description:
      'Adds the token to the deny-list consulted by `verifyJwt`. ' +
      'Idempotent — repeated calls with the same token return `revoked=false`. ' +
      'Per RFC 7009 §2.2, tokens that do not validate under our key are still ' +
      'reported as a no-op success rather than leaking validity information.',
  })
  @ApiBody({ type: RevokeRequestDto })
  @ApiOkResponse({ type: RevokeResponseDto })
  async revoke(
    @Body() body: RevokeRequestDto,
    @Req()
    req: Request & {
      actorId?: string;
      actorType?: 'api-key' | 'jwt';
      actorIsAdmin?: boolean;
      actorDid?: string;
    },
  ): Promise<RevokeResponseDto> {
    // Try the full verify path first so we can record the canonical
    // claims (iss/exp from a valid token). If verification fails (bad
    // sig, expired, wrong issuer, already revoked), fall back to a
    // best-effort decode so we still capture the jti for audit. RFC
    // 7009 says revocation MUST succeed even for unrecognized tokens.
    let claims = null as Awaited<ReturnType<TokenIssuer['verifyJwt']>> | null;
    try {
      claims = await this.issuer.verifyJwt(body.token);
    } catch {
      claims = null;
    }
    if (!claims) {
      const decoded = this.issuer.decodeJwt(body.token);
      if (!decoded) {
        // Token didn't even decode — no jti to deny-list. Per RFC 7009,
        // still return success. (Authorization gate is irrelevant when
        // there's nothing identifiable to revoke.)
        this.logger.warn({
          msg: 'revoke called with un-decodable token',
          actorId: req.actorId ?? 'unknown',
        });
        return { revoked: false };
      }
      claims = decoded;
    }

    // Authorization gate: admin OR self-revoke (JWT-authenticated caller
    // whose DID matches claims.sub). Anything else is 403.
    const isAdmin = req.actorIsAdmin === true;
    const isSelfRevoke =
      req.actorType === 'jwt' &&
      typeof req.actorDid === 'string' &&
      req.actorDid.length > 0 &&
      req.actorDid === claims.sub;
    if (!isAdmin && !isSelfRevoke) {
      this.logger.warn({
        msg: 'revoke 403',
        actorId: req.actorId ?? 'unknown',
        actorType: req.actorType ?? '?',
        targetSub: claims.sub,
      });
      // Generic FORBIDDEN, not ADMIN_REQUIRED: a JWT self-revoke passes
      // this gate without admin, so "admin-only" would misdirect (#182).
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'caller is not authorized to revoke this token',
        HttpStatus.FORBIDDEN,
      );
    }

    const reason: RevocationReason = body.reason ?? 'unspecified';
    const newlyRevoked = await this.revocations.revoke({
      jti: claims.jti,
      sub: claims.sub,
      iss: claims.iss,
      exp: claims.exp,
      revokedBy: req.actorId ?? 'unknown',
      reason,
    });

    if (newlyRevoked) {
      this.logger.log({
        msg: 'token revoked',
        jti: claims.jti,
        sub: claims.sub,
        reason,
        by: req.actorId ?? 'unknown',
      });
    }
    return { revoked: newlyRevoked };
  }
}
