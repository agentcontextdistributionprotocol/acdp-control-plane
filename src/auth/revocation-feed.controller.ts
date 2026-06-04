/**
 * Cross-issuer revocation feed.
 *
 *   GET /auth/revocations?since=<unix-ms>&limit=<n>
 *
 * Federated peers poll this endpoint and apply each entry to their
 * local revocation store, so a token revoked at the issuer is rejected
 * at every consuming registry without shared state. This closes the
 * audit gap on plan §9 (cross-issuer revocation propagation).
 *
 * Authorization: admin-only (admin api key listed in
 * `AUTH_ADMIN_API_KEYS`). The feed isn't secret per se — every entry
 * lists an already-revoked token — but exposing it publicly lets any
 * scraper enumerate which agents had recent revocations, which is a
 * mild but real information leak.
 *
 * Pagination: cursor = unix-ms timestamp of the last entry in the
 * previous page. Stable secondary sort on `jti` makes pages
 * deterministic when multiple entries share a `revoked_at`.
 */
import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import {
  REVOCATION_REPOSITORY,
  RevocationRepository,
} from './revocation-repository';

class FeedEntryDto {
  @ApiProperty({ description: 'JWT identifier (jti claim).' })
  jti!: string;

  @ApiProperty({ description: 'Subject DID (sub claim of the revoked token).' })
  sub!: string;

  @ApiProperty({ description: 'Issuer (iss claim of the revoked token).' })
  iss!: string;

  @ApiProperty({ description: 'Original expiry (unix seconds).' })
  exp!: number;

  @ApiProperty({ description: 'Unix ms timestamp of when the token was revoked.' })
  revoked_at_ms!: number;
}

export class RevocationFeedResponseDto {
  @ApiProperty({ type: [FeedEntryDto], description: 'Revoked tokens since the cursor.' })
  entries!: FeedEntryDto[];

  @ApiProperty({
    description:
      'Pass this back as `since` on the next request. `null` when there are no more entries.',
    required: false,
    nullable: true,
  })
  next_cursor!: number | null;
}

@ApiTags('auth')
@Controller('auth/revocations')
export class RevocationFeedController {
  private readonly logger = new Logger(RevocationFeedController.name);

  constructor(
    @Inject(REVOCATION_REPOSITORY)
    private readonly revocations: RevocationRepository,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  // RFC-ACDP-0007 §4: ACDP protocol responses carry application/acdp+json.
  // The registry's revocation poller consumes this feed cross-process, so
  // we mirror the registry's media type here.
  @Header('Content-Type', 'application/acdp+json')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Federated revocation feed',
    description:
      'Returns revocations since a timestamp cursor. Peers poll this ' +
      'to propagate revocations into their local stores. Admin-only.',
  })
  @ApiQuery({
    name: 'since',
    required: false,
    description: 'Unix-ms cursor from a previous page. Default 0 (full feed).',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max entries to return. Capped at 500.',
  })
  @ApiOkResponse({ type: RevocationFeedResponseDto })
  async feed(
    @Req() req: Request & { actorIsAdmin?: boolean },
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ): Promise<RevocationFeedResponseDto> {
    if (!req.actorIsAdmin) {
      throw new ForbiddenException('revocation feed is admin-only');
    }
    const sinceMs = Number.parseInt(since ?? '0', 10);
    const cap = Number.parseInt(limit ?? '200', 10);
    const { entries, nextCursor } = await this.revocations.listSince(
      Number.isFinite(sinceMs) ? sinceMs : 0,
      Number.isFinite(cap) ? cap : 200,
    );
    return {
      entries: entries.map((r) => ({
        jti: r.jti,
        sub: r.sub,
        iss: r.iss,
        exp: r.exp,
        revoked_at_ms: r.revokedAt?.getTime() ?? 0,
      })),
      next_cursor: nextCursor,
    };
  }
}
