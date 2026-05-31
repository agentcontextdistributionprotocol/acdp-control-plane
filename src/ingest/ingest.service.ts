import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { AcdpWebhookEvent } from '../contracts/acdp';
import { DomainPackRegistry } from '../domain-packs/domain-pack';
import { EventProcessorService } from '../processor/event-processor.service';
import { RegistryEnrollmentRepository } from '../storage/registry-enrollment.repository';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';
import { verifyWebhookSignature } from './hmac';

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly processor: EventProcessorService,
    private readonly domainPacks: DomainPackRegistry,
    private readonly enrollmentRepo: RegistryEnrollmentRepository,
    private readonly instrumentation: InstrumentationService,
  ) {}

  async handle(
    body: Buffer,
    signatureHeader: string,
    headerRunId?: string,
    headerTenantId: string = DEFAULT_TENANT_ID,
    originHeader?: string,
    eventIdHeader?: string,
  ): Promise<void> {
    // Peek the payload to find the claimed authority. We don't ACT on it
    // until HMAC is verified below — it only selects the per-registry
    // secret + tenant (the standard multi-tenant webhook pattern: an
    // attacker can claim any authority but can't forge its HMAC).
    let payload: AcdpWebhookEvent;
    try {
      payload = JSON.parse(body.toString('utf8')) as AcdpWebhookEvent;
    } catch {
      throw new BadRequestException('Invalid JSON payload');
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new BadRequestException('Payload must be an object');
    }

    const claimedAuthority =
      payload.registry_authority || extractAuthorityFromCtxId(payload.ctx_id);

    // Resolve enrollment to choose the HMAC secret + tenant + base URL.
    const enrollment = claimedAuthority
      ? await this.enrollmentRepo.findByAuthority(claimedAuthority)
      : null;

    let secret = this.config.webhookSecret;
    let tenantId = headerTenantId;
    let enrolledBaseUrl: string | undefined;

    if (enrollment) {
      if (!enrollment.enabled) {
        throw new ForbiddenException(`Registry '${claimedAuthority}' is disabled`);
      }
      tenantId = enrollment.tenantId; // tenant comes from enrollment, not the header
      if (enrollment.webhookSecret) secret = enrollment.webhookSecret;
      enrolledBaseUrl = enrollment.baseUrl ?? undefined;
    } else if (this.config.ingestRequireEnrollment) {
      throw new ForbiddenException(
        `Registry '${claimedAuthority ?? '(unknown)'}' is not enrolled`,
      );
    }

    if (!verifyWebhookSignature(body, signatureHeader ?? '', secret)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    if (!payload.type) {
      throw new BadRequestException('Missing required field: type');
    }
    // Only context_published carries an agent_id. The registry's
    // context_retrieved / search_executed variants are agent-less by design
    // (acdp-registry event.rs: they carry only an optional requester_did), and
    // the processor tolerates an empty agent_id — so don't reject them at the
    // boundary. The webhook worker treats a 4xx as permanent and gives up, so
    // an over-eager guard here drops retrieve/search events permanently.
    if (payload.type === 'context_published' && !payload.agent_id) {
      throw new BadRequestException('Missing required field: agent_id');
    }
    // Domain-pack context-type gate (plan §1). Only active when at least
    // one pack is registered — keeps deployments without DOMAIN_PACKS set
    // behaving exactly as before. The union of every pack's
    // `contextTypes[].contextType` is the allowlist.
    //
    // Base ACDP types (RFC-ACDP-0001) are NEVER pack-gated: the gate is
    // for the *additional* vertical types a pack introduces, not the
    // baseline types any agent may publish (FEAT-CP-07).
    const packs = this.domainPacks.list();
    if (
      packs.length > 0 &&
      payload.context_type !== undefined &&
      payload.context_type !== null &&
      !ACDP_BASE_TYPES.has(String(payload.context_type))
    ) {
      const allowed = new Set<string>();
      for (const p of packs) {
        for (const ct of p.contextTypes) allowed.add(ct.contextType);
      }
      const requested = String(payload.context_type);
      if (!allowed.has(requested)) {
        // Make the silent drop observable: the registry's webhook worker logs
        // `webhook_4xx` and gives up, so without a CP-side counterpart this
        // rejection is invisible to operators. Warn + counter, then reject.
        this.logger.warn(
          `ingest rejected: context_type '${requested}' not declared by any ` +
            `active domain pack (${packs.map((p) => p.id).join(', ')})`,
        );
        this.instrumentation.ingestRejectedTotal.inc({ reason: 'pack_gate' });
        throw new BadRequestException(
          `context_type '${requested}' not declared by any active domain pack ` +
            `(${packs.map((p) => p.id).join(', ')})`,
        );
      }
    }
    // registry_authority is required, but the ACDP registry's WebhookEvent
    // doesn't include it explicitly — fall back to extracting it from
    // ctx_id (format: `acdp://<authority>/<id>`) so the event still flows.
    if (!payload.registry_authority) {
      const extracted = extractAuthorityFromCtxId(payload.ctx_id);
      if (!extracted) {
        throw new BadRequestException(
          'Missing required field: registry_authority (and ctx_id has no authority)',
        );
      }
      payload.registry_authority = extracted;
    }

    const runId = headerRunId ?? payload.run_id;
    // Base URL preference for the federation proxy: explicit Origin header,
    // then the enrolled base URL (payload.registry_base_url is applied in
    // the processor as a further fallback).
    const baseUrl = originHeader ?? enrolledBaseUrl;
    // Dedup id preference: the X-ACDP-Event-Id header (REG-P2-6 echo), then
    // the envelope's flattened event_id field. Undefined for legacy
    // registries — the processor then falls back to a content fingerprint.
    const eventId = eventIdHeader?.trim() || payload.event_id;
    await this.processor.process(payload, runId, tenantId, baseUrl, eventId);
  }
}

/**
 * Base ACDP context types (RFC-ACDP-0001). These are always accepted and
 * never subject to the domain-pack gate, which only governs the additional
 * vertical-specific types a pack introduces.
 */
const ACDP_BASE_TYPES = new Set<string>([
  'data_snapshot',
  'analysis',
  'prediction',
  'alert',
]);

/**
 * Pull the authority out of an ACDP context URI. Returns undefined if the
 * input isn't shaped like `acdp://<authority>/<id>`.
 */
export function extractAuthorityFromCtxId(ctxId: unknown): string | undefined {
  if (typeof ctxId !== 'string' || !ctxId.startsWith('acdp://')) return undefined;
  const [authority] = ctxId.slice('acdp://'.length).split('/');
  return authority || undefined;
}
