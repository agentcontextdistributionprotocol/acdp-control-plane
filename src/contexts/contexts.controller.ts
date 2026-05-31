import {
  BadGatewayException,
  BadRequestException,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CheckPolicy } from '../policy/check-policy.decorator';
import { RegistryRepository } from '../storage/registry.repository';
import { tenantOf, TenantedRequest } from '../tenant/request-tenant';
import { FederationFetchError, SafeFederationClient } from './safe-federation-client';

@ApiTags('contexts')
@Controller('contexts')
export class ContextsController {
  private readonly logger = new Logger(ContextsController.name);

  constructor(
    private readonly registryRepo: RegistryRepository,
    private readonly federationClient: SafeFederationClient,
  ) {}

  // Catch-all path parameter. NestJS 11 / path-to-regexp v6+ uses the
  // `*name` syntax for "match everything under this prefix" (the older
  // `:ctxId(.*)` regex syntax is gone). The `ctxId` param arrives as a
  // string[] of decoded path segments.
  @Get('*ctxId')
  @CheckPolicy('context.retrieve')
  @ApiOperation({
    summary:
      'Federated context retrieval — proxied to the registry that authored it. ctx_id format: acdp://<authority>/<uuid>',
  })
  async getContext(
    @Param('ctxId') ctxIdParts: string[] | string,
    @Req() req: TenantedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const tenantId = tenantOf(req);
    const ctxId = Array.isArray(ctxIdParts) ? ctxIdParts.join('/') : ctxIdParts;

    // Strict ctx_id parse — reject anything that isn't acdp://<authority>/<id>
    // before touching the registry table or making an outbound request.
    const parsed = parseAcdpCtxId(ctxId);
    if (!parsed) {
      throw new BadRequestException(`Invalid ctx_id format: ${ctxId}`);
    }

    // Resolve the registry within the caller's tenant only.
    const registry = await this.registryRepo.findByAuthority(parsed.authority, tenantId);
    if (!registry?.baseUrl) {
      throw new NotFoundException(`Unknown registry authority: ${parsed.authority}`);
    }

    const upstream = `${registry.baseUrl.replace(/\/$/, '')}/contexts/${encodeURIComponent(ctxId)}`;

    // Credential strategy (Phase 3.4): PUBLIC-ONLY proxy. We forward no
    // caller credentials upstream, so the registry enforces its own
    // visibility rules and we relay whatever status it returns — a
    // restricted/private context surfaces the registry's 401/403/404
    // verbatim rather than us attempting (and leaking) access.
    try {
      const response = await this.federationClient.get(upstream);
      res
        .status(response.status)
        .set('Content-Type', response.contentType ?? 'application/json')
        .send(response.body);
    } catch (err) {
      // SSRF / transport / oversize failures are upstream problems, not
      // "context not found" — surface 502 so the caller can tell them apart.
      if (err instanceof FederationFetchError) {
        this.logger.warn(
          `federation proxy GET ${upstream} failed [${err.code}]: ${err.message}`,
        );
        throw new BadGatewayException(
          `Upstream registry ${parsed.authority} unreachable for ${ctxId}`,
        );
      }
      throw err;
    }
  }
}

/**
 * Strictly parse an ACDP context URI into its authority + id. Returns
 * null for anything not shaped like `acdp://<authority>/<id>` with a
 * hostname-shaped authority (no path traversal, no embedded scheme).
 */
function parseAcdpCtxId(raw: string): { authority: string; id: string } | null {
  if (typeof raw !== 'string' || !raw.startsWith('acdp://')) return null;
  const rest = raw.slice('acdp://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const authority = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  if (!authority || !id) return null;
  // Authority must look like a host[:port] — letters, digits, dot, dash, colon.
  if (!/^[a-zA-Z0-9.:-]+$/.test(authority)) return null;
  return { authority, id };
}
