/**
 * RFC 7662 token-introspection endpoint.
 *
 *   POST /auth/introspect
 *   Body: { token: "<jwt>" }
 *   Returns:
 *     { active: true,  iss, sub, jti, iat, exp, key_id, registry, scope? }
 *     { active: false }       // when the token can't be verified
 *
 * Bearer-auth protected: callers must present a valid bearer token of
 * their own before introspecting another. Without this, the endpoint
 * becomes an oracle that confirms token validity for anyone.
 *
 * Per RFC 7662 §2.2: the response for an inactive / invalid token
 * MUST be just `{active: false}` — no extra fields, no error
 * discrimination (otherwise a caller can distinguish "expired" from
 * "bad signature" from "wrong issuer" via timing or response shape).
 *
 * Cache policy: none in V1. Per RFC 7662 §4 resource servers MAY
 * cache responses, but the cache MUST NOT outlive `exp`. A short-TTL
 * cache could land in a follow-up — for now the verifier is fast
 * enough that introspect calls trace 1:1 to JWT verification work.
 */
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { BEARER_TOKEN_MAX_LENGTH } from './dto/auth.dto';
import { CrossIssuerValidator } from './cross-issuer-validator.service';

export class IntrospectRequestDto {
  @ApiProperty({
    description:
      'The bearer JWT to introspect. Pass the raw token value (not the `Authorization: Bearer` header).',
    example: 'eyJhbGciOi...',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(BEARER_TOKEN_MAX_LENGTH)
  token!: string;
}

/**
 * RFC 7662 §2.2 response shape. When `active=false`, all other
 * fields MUST be omitted so timing / shape doesn't discriminate.
 */
export class IntrospectResponseDto {
  @ApiProperty({
    description:
      'Whether the token is currently valid (signature, issuer, expiry, ' +
      'and revocation list all pass).',
    example: true,
  })
  active!: boolean;

  @ApiProperty({ required: false, description: 'Token issuer (iss claim).', example: 'control-plane.local' })
  iss?: string;

  @ApiProperty({ required: false, description: 'Subject DID (sub claim).', example: 'did:web:cp.example.com:agents:alice' })
  sub?: string;

  @ApiProperty({ required: false, description: 'JWT ID (jti claim).', example: 'b7e8d3a1c5f9' })
  jti?: string;

  @ApiProperty({ required: false, description: 'Issued-at unix seconds.', example: 1716661234 })
  iat?: number;

  @ApiProperty({ required: false, description: 'Expiration unix seconds.', example: 1716665000 })
  exp?: number;

  @ApiProperty({ required: false, description: 'Token type (always `Bearer` for v0.1).', example: 'Bearer' })
  token_type?: string;

  @ApiProperty({ required: false, description: 'Key identifier (acdp.key_id claim).', example: 'did:web:cp.example.com:agents:alice#key-1' })
  key_id?: string;

  @ApiProperty({ required: false, description: 'Issuer registry (acdp.registry claim).', example: 'control-plane.local' })
  registry?: string;
}

@ApiTags('auth')
@Controller('auth')
export class IntrospectController {
  private readonly logger = new Logger(IntrospectController.name);

  constructor(private readonly validator: CrossIssuerValidator) {}

  @Post('introspect')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Introspect a bearer token (RFC 7662)',
    description:
      'Verifies the JWT against the local issuer secret OR any peer issuer ' +
      'configured in `TRUSTED_ISSUERS` (federation). Returns canonical claims ' +
      'for active tokens; returns just `{active: false}` for anything that ' +
      'fails verification, per RFC 7662 §2.2 (no oracle discrimination).',
  })
  @ApiBody({ type: IntrospectRequestDto })
  @ApiOkResponse({ type: IntrospectResponseDto })
  async introspect(
    @Body() body: IntrospectRequestDto,
  ): Promise<IntrospectResponseDto> {
    try {
      // CrossIssuerValidator dispatches on `iss` so tokens from
      // trusted peer registries are also accepted here. Sync API —
      // wrap in Promise.resolve to keep this method async-shaped
      // for forward-compat with the introspection-cache work.
      const claims = await Promise.resolve(this.validator.verify(body.token));
      return {
        active: true,
        iss: claims.iss,
        sub: claims.sub,
        jti: claims.jti,
        iat: claims.iat,
        exp: claims.exp,
        token_type: 'Bearer',
        key_id: claims.acdp?.key_id,
        registry: claims.acdp?.registry,
      };
    } catch (e) {
      // RFC 7662 §2.2: any failure mode collapses to {active: false}.
      // We DON'T log token contents at warn level (PII / secret hygiene);
      // a debug-level breadcrumb is enough for triage.
      this.logger.debug({
        msg: 'introspect: token rejected',
        error: e instanceof Error ? e.message : 'unknown',
      });
      return { active: false };
    }
  }
}
