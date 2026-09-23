import {
  BadGatewayException,
  BadRequestException,
  Controller,
  Get,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { isCanonicalCtxId, verifyCtxIdBinding } from '../audit/receipt-verify';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { CheckPolicy } from '../policy/check-policy.decorator';
import { RegistryRepository } from '../storage/registry.repository';
import { tenantOf, TenantedRequest } from '../tenant/request-tenant';
import {
  FederationFetchError,
  FederationResponse,
  SafeFederationClient,
} from './safe-federation-client';

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
      'Federated context retrieval — proxied to the registry that authored it, then bound to the ' +
      'requested identity (RFC-ACDP-0006 §4.1 step 7). ctx_id format: ' +
      'acdp://<lowercase DNS authority>/<lowercase v4 UUID>',
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
    let response: FederationResponse;
    try {
      response = await this.federationClient.get(upstream);
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

    // RFC-ACDP-0006 §4.1 step 7 — bind the SERVED identity to the REQUESTED
    // one before relaying. Only on a success: a 4xx problem document is not a
    // context, and gating it would break the public-only relay semantics that
    // let a caller see the registry's own 401/403/404 verbatim.
    if (response.status >= 200 && response.status < 300) {
      this.assertCtxIdBinding(response, ctxId, parsed.authority);
    }

    res
      .status(response.status)
      .set('Content-Type', response.contentType ?? 'application/json')
      .send(response.body);
  }

  /**
   * Throw unless the served body's `ctx_id` is the one that was requested.
   *
   * `ctx_id` is registry-assigned and excluded from both `content_hash` and
   * the producer signature (RFC-ACDP-0001 §5.7), so a compromised or confused
   * registry can serve a *different, validly signed* body under this URL and
   * every other check in the path still passes. This is the only comparison
   * that catches it, and it fails CLOSED: detecting a substitution and
   * relaying it anyway is worse than never looking, because the caller would
   * then hold a false assurance that the proxy checked.
   *
   * The host parses the envelope LOOSELY — it reads exactly one member
   * (`body`) and re-stringifies it. It must never become a schema gate:
   * `FullContext` is `additionalProperties: true` and grows members between
   * ACDP versions (`log_inclusion`, `lineage_head_receipt`, the 0.14.x
   * `data_refs[].embedded.content_hash`), and the SDK is the only component
   * entitled to decide whether a body is well-formed.
   *
   * Caller-facing messages are deliberately fixed strings that never embed the
   * upstream payload or the underlying parse error — a `JSON.parse` failure
   * message echoes a fragment of the input it choked on, and the body we are
   * refusing to relay must not leak back through the error we relay instead.
   * The full reason goes to the log.
   */
  private assertCtxIdBinding(
    response: FederationResponse,
    ctxId: string,
    authority: string,
  ): void {
    const contentType = response.contentType ?? '<none>';

    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch (e) {
      throw this.bindingUnverifiable(ctxId, authority, {
        bindingCause: 'response_not_json',
        contentType,
        detail: e instanceof Error ? e.message : String(e),
      });
    }

    const body = (payload as { body?: unknown } | null)?.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw this.bindingUnverifiable(ctxId, authority, {
        bindingCause: 'response_has_no_body_member',
        contentType,
        detail: 'a 2xx retrieval must be a FullContext with an object `body` member',
      });
    }

    const outcome = verifyCtxIdBinding(JSON.stringify(body), ctxId);
    if (outcome.ok) return;

    if (outcome.kind === 'mismatch') {
      // The loudest thing this controller can say: the registry served a
      // context we did not ask for.
      this.logger.warn({
        msg:
          `federation proxy refusing to relay: registry '${authority}' served a ` +
          `different context than requested for '${ctxId}' — ${outcome.reason}`,
        bindingCause: 'ctx_id_mismatch',
        registryAuthority: authority,
        ctxId,
        contentType,
      });
      throw new AppException(
        ErrorCode.CONTEXT_ID_MISMATCH,
        `Upstream registry ${authority} served a different context than requested for ${ctxId}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    // Not a mismatch — we could not establish the binding at all. Most often
    // a body the SDK's strict `Body` parse rejects, or a ctx_id the SDK's
    // grammar refuses where the route's own (deliberately bounded) mirror of
    // it let the request through. Fail closed, but never call it substitution.
    throw this.bindingUnverifiable(ctxId, authority, {
      bindingCause: 'sdk_could_not_verify',
      contentType,
      detail: outcome.reason,
    });
  }

  /** Log the real cause, return the body-free 502 to throw. */
  private bindingUnverifiable(
    ctxId: string,
    authority: string,
    fields: { bindingCause: string; contentType: string; detail: string },
  ): AppException {
    this.logger.warn({
      msg:
        `federation proxy refusing to relay: cannot verify the ctx_id binding of ` +
        `registry '${authority}'s response for '${ctxId}' (${fields.bindingCause}) — ${fields.detail}`,
      registryAuthority: authority,
      ctxId,
      ...fields,
    });
    return new AppException(
      ErrorCode.CONTEXT_BINDING_UNVERIFIABLE,
      `Cannot verify that upstream registry ${authority} served the requested context ${ctxId}`,
      HttpStatus.BAD_GATEWAY,
    );
  }
}

/**
 * Parse an ACDP context URI into its authority + id under the SDK's own
 * `CtxId::parse` grammar (`acdp-primitives/src/primitives.rs:29-48`):
 * `acdp://` + a lowercase DNS authority (so no port) + `/` + a lowercase v4
 * UUID. Returns null for anything else, which the route turns into a 400.
 *
 * **Why this matches the SDK rather than a looser host shape.** The binding
 * check below runs the requested ctx_id through the SDK, which parses it with
 * exactly this grammar — so a ctx_id accepted here but refused there could
 * only ever end in a 502, and 502 on this route must keep meaning one thing:
 * *the upstream served a different context than we asked for.* This is also
 * not a contract change for any conformant caller: the reference registry
 * parses the path ctx_id through the same `CtxId::parse` in its own retrieve
 * handler (`acdp-registry-core/src/handlers/context.rs:899`), so such a
 * request already comes back as a `schema_violation` 400 that this proxy
 * relays today. Tightening turns an upstream 400 into a local one and saves
 * the round trip.
 *
 * `isCanonicalCtxId` is the same mirror the receipt auditor uses, including
 * its one documented gap (it does not enforce the 63-character DNS-label
 * limit that `CtxId::parse` does). A ctx_id that slips through that gap is
 * caught by the SDK at the binding check and lands as
 * `CONTEXT_BINDING_UNVERIFIABLE` — fail-closed, and never miscalled a
 * substitution.
 */
function parseAcdpCtxId(raw: string): { authority: string; id: string } | null {
  if (typeof raw !== 'string' || !isCanonicalCtxId(raw)) return null;
  // Guaranteed well-formed by the check above: prefix present, exactly one
  // authority/uuid split, both halves non-empty.
  const rest = raw.slice('acdp://'.length);
  const slash = rest.indexOf('/');
  return { authority: rest.slice(0, slash), id: rest.slice(slash + 1) };
}
