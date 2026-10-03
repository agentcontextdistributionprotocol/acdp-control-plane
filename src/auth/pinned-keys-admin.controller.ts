/**
 * Admin-only reload endpoint for the pinned-key directory (plan §2).
 *
 *   POST /admin/pinned-keys/reload
 *
 * Re-reads `CONTROL_PLANE_PINNED_KEYS` from the current process
 * environment and atomically swaps the in-memory directory. Operators
 * use this to roll a new key in (or out) without restarting the CP —
 * useful during a planned rotation where the new key is staged with
 * a `validFrom` in the near future and the old key has a `validUntil`
 * that overlaps.
 *
 * Authorization mirrors the revocation feed (`AUTH_ADMIN_API_KEYS`):
 * an admin api key sets `req.actorIsAdmin = true` via the `AuthGuard`.
 * JWT-authenticated requests can NOT trigger reload — admin actions
 * stay api-key-gated until `AUTH_ADMIN_DIDS` is wired (out of scope
 * for §2).
 */
import {
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { PinnedKeysService } from './pinned-keys.service';
import { assertAdmin } from './admin';

class PinnedKeysReloadResponseDto {
  @ApiProperty({ description: 'True when the reload succeeded.' })
  ok!: boolean;

  @ApiProperty({
    description:
      'Number of entries currently in the directory after the reload.',
  })
  count!: number;
}

@ApiTags('admin')
@Controller('admin/pinned-keys')
export class PinnedKeysAdminController {
  private readonly logger = new Logger(PinnedKeysAdminController.name);

  constructor(private readonly pinned: PinnedKeysService) {}

  @Post('reload')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Reload the pinned-key directory from environment',
    description:
      'Admin-only. Re-reads CONTROL_PLANE_PINNED_KEYS from the current ' +
      'process environment and atomically replaces the in-memory ' +
      'directory. Returns the post-reload entry count.',
  })
  @ApiOkResponse({ type: PinnedKeysReloadResponseDto })
  reload(
    @Req() req: Request & { actorIsAdmin?: boolean },
  ): PinnedKeysReloadResponseDto {
    assertAdmin(req, 'pinned-keys reload is admin-only');
    const raw = process.env.CONTROL_PLANE_PINNED_KEYS ?? '';
    const count = this.pinned.load(raw);
    this.logger.log(`pinned-keys reloaded; count=${count}`);
    return { ok: true, count };
  }
}
