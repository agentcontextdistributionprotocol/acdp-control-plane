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
    // Bound the parse-DoS surface on this @Public() route: reject an
    // oversized body before decoding, and pre-scan for excessive JSON
    // nesting depth before JSON.parse builds the object graph.
    if (body.length > this.config.ingestMaxBodyBytes) {
      throw new BadRequestException(
        `Payload exceeds ${this.config.ingestMaxBodyBytes}-byte limit`,
      );
    }
    const text = body.toString('utf8');
    if (exceedsJsonDepth(text, this.config.ingestMaxJsonDepth)) {
      throw new BadRequestException(
        `Payload JSON nesting exceeds depth limit (${this.config.ingestMaxJsonDepth})`,
      );
    }

    // Peek the payload to find the claimed authority. We don't ACT on it
    // until HMAC is verified below — it only selects the per-registry
    // secret + tenant (the standard multi-tenant webhook pattern: an
    // attacker can claim any authority but can't forge its HMAC).
    let payload: AcdpWebhookEvent;
    try {
      payload = JSON.parse(text) as AcdpWebhookEvent;
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
    } else if (this.config.ingestStrictTenant && tenantId !== DEFAULT_TENANT_ID) {
      // Strict mode: no enrollment binds this authority to a tenant, so a
      // caller-supplied X-Tenant-Id must not let an unenrolled authority
      // write into an arbitrary tenant. Only a server-side enrollment may
      // target a NON-default tenant — fall back to the default bucket.
      // (Off by default: header attribution is the documented V0 fallback.)
      this.logger.warn(
        `ingest: unenrolled authority '${claimedAuthority ?? '(unknown)'}' ` +
          `asserted X-Tenant-Id='${tenantId}'; INGEST_STRICT_TENANT is on, ` +
          `ignoring and using '${DEFAULT_TENANT_ID}'`,
      );
      tenantId = DEFAULT_TENANT_ID;
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
 * Cheap structural pre-scan: returns true if the JSON text nests `{`/`[`
 * deeper than `maxDepth`. Runs in O(n) over the raw string WITHOUT building
 * an object graph, so it rejects a malicious deeply-nested body before
 * `JSON.parse` does the expensive (and potentially stack-blowing) work.
 * String contents (incl. escaped quotes) are skipped so brackets inside
 * string literals don't count.
 */
export function exceedsJsonDepth(text: string, maxDepth: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === '{' || c === '[') {
      depth++;
      if (depth > maxDepth) return true;
    } else if (c === '}' || c === ']') {
      if (depth > 0) depth--;
    }
  }
  return false;
}

/**
 * Pull the authority out of an ACDP context URI. Returns undefined if the
 * input isn't shaped like `acdp://<authority>/<id>`.
 */
export function extractAuthorityFromCtxId(ctxId: unknown): string | undefined {
  if (typeof ctxId !== 'string' || !ctxId.startsWith('acdp://')) return undefined;
  const [authority] = ctxId.slice('acdp://'.length).split('/');
  return authority || undefined;
}
