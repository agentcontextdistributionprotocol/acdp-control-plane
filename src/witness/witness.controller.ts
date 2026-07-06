/**
 * Transparency-log WITNESS endpoints (RFC-ACDP-0015 §6.2, §9).
 *
 * These serve this control plane's witness identity and the cosignatures it has
 * minted — the direct-from-witness path that removes the registry from the
 * trust path entirely (§6.2): a consumer learns what the witness saw without the
 * registry able to withhold or filter it.
 *
 *   - GET /log/witness[?log_id=…&tree_size=…]     — this witness's cosignatures,
 *     most-recent first (§6.2).
 *   - GET /.well-known/acdp-witness.json          — witness capabilities (§9).
 *   - GET /.well-known/did.json                   — the witness DID document,
 *     whose `assertionMethod` key a consumer resolves `signature.key_id` to (§8
 *     step 2), so the witness's own key is resolvable.
 *
 * All are @Public() — they carry only public attestations and public key
 * material. When cosigning is disabled (no witness key configured) they 404:
 * there is no witness identity to advertise.
 */
import {
  Controller,
  Get,
  Header,
  HttpStatus,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { LogCosignatureRepository } from '../storage/log-cosignature.repository';
import { WitnessSigningService } from './witness-signing.service';

const LOG_ID_RE = /^did:web:[A-Za-z0-9._%:-]+\/log\/[a-z0-9-]{1,32}$/;

@ApiTags('witness')
@Controller()
export class WitnessController {
  constructor(
    private readonly witnessSigning: WitnessSigningService,
    private readonly cosignatureRepo: LogCosignatureRepository,
  ) {}

  @Get('log/witness')
  @Public()
  @Header('Content-Type', 'application/acdp+json')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      "This witness's transparency-log cosignatures (RFC-ACDP-0015 §6.2), " +
      'most-recent first, optionally filtered by ?log_id= and ?tree_size=.',
  })
  async cosignatures(
    @Query('log_id') logId?: string,
    @Query('tree_size') treeSize?: string,
  ): Promise<{ witness_id: string; witness_signatures: Record<string, unknown>[] }> {
    this.requireEnabled();

    // Out-of-range or malformed parameters → schema_violation (§6.2).
    if (logId !== undefined && !LOG_ID_RE.test(logId)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        `malformed log_id '${logId}' (schema_violation)`,
        HttpStatus.BAD_REQUEST,
      );
    }
    let sizeNum: number | undefined;
    if (treeSize !== undefined) {
      sizeNum = Number(treeSize);
      if (!Number.isInteger(sizeNum) || sizeNum < 0) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          `malformed tree_size '${treeSize}' (schema_violation)`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const rows = await this.cosignatureRepo.list({
      witnessId: this.witnessSigning.witnessId,
      logId,
      treeSize: sizeNum,
      limit: 50,
    });
    return {
      witness_id: this.witnessSigning.witnessId,
      // Serve the signed objects verbatim (§4/§6.2).
      witness_signatures: rows.map((r) => r.cosignature),
    };
  }

  @Get('.well-known/acdp-witness.json')
  @Public()
  @Header('Content-Type', 'application/json')
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOperation({ summary: 'Witness capabilities document (RFC-ACDP-0015 §9).' })
  async capabilities(): Promise<Record<string, unknown>> {
    this.requireEnabled();
    const coveredLogs = await this.cosignatureRepo.coveredLogs(this.witnessSigning.witnessId);
    return this.witnessSigning.capabilities(coveredLogs) as unknown as Record<string, unknown>;
  }

  @Get('.well-known/did.json')
  @Public()
  @Header('Content-Type', 'application/did+json')
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOperation({
    summary:
      'Witness DID document — the assertionMethod key a consumer resolves ' +
      'signature.key_id to when verifying cosignatures (RFC-ACDP-0015 §8/§9).',
  })
  didDocument(): Record<string, unknown> {
    this.requireEnabled();
    return this.witnessSigning.didDocument() as unknown as Record<string, unknown>;
  }

  private requireEnabled(): void {
    if (!this.witnessSigning.enabled) {
      throw new AppException(
        ErrorCode.REGISTRY_NOT_FOUND,
        'witness cosigning is not enabled on this control plane (WITNESS_COSIGNING_ENABLED=false)',
        HttpStatus.NOT_FOUND,
      );
    }
  }
}
