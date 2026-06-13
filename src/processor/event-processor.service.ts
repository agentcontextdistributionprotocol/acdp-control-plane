import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AcdpStreamEvent, AcdpWebhookEvent } from '../contracts/acdp';
import { StreamHubService } from '../events/stream-hub.service';
import { AgentRepository } from '../storage/agent.repository';
import { ContextEventRepository } from '../storage/context-event.repository';
import { LineageEdgeRepository } from '../storage/lineage-edge.repository';
import { RegistryRepository } from '../storage/registry.repository';
import { RunRepository } from '../storage/run.repository';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { WebhookService } from '../webhooks/webhook.service';

@Injectable()
export class EventProcessorService {
  private readonly logger = new Logger(EventProcessorService.name);

  constructor(
    private readonly contextEventRepo: ContextEventRepository,
    private readonly runRepo: RunRepository,
    private readonly lineageRepo: LineageEdgeRepository,
    private readonly agentRepo: AgentRepository,
    private readonly registryRepo: RegistryRepository,
    private readonly streamHub: StreamHubService,
    private readonly instrumentation: InstrumentationService,
    private readonly webhookService: WebhookService,
  ) {}

  async process(
    payload: AcdpWebhookEvent,
    runIdOverride?: string,
    tenantId: string = DEFAULT_TENANT_ID,
    originHeader?: string,
    eventId?: string,
  ): Promise<void> {
    const eventType = String(payload.type ?? 'unknown');
    const ctxId = payload.ctx_id;
    const lineageId = payload.lineage_id;
    const agentId = String(payload.agent_id ?? '');
    const contextType = payload.context_type;
    const visibility = payload.visibility;
    const version = payload.version;
    const derivedFrom = payload.derived_from ?? [];
    const registryAuthority = String(payload.registry_authority ?? '');
    const scenarioId = this.extractScenarioId(payload);
    const eventTs = String(payload.created_at ?? new Date().toISOString());
    const runId = runIdOverride ?? payload.run_id;
    const fingerprint = this.dedupKey(payload, runId, eventId);
    // ACDP 0.2.0 trust metadata (RFC-ACDP-0010) — additive, absent on 0.1.0
    // traffic. The full receipt object stays verbatim in rawPayload; only the
    // two queryable signals are lifted into columns.
    const keyFingerprint =
      typeof payload.key_fingerprint === 'string' ? payload.key_fingerprint : undefined;
    const receiptPresent =
      payload.registry_receipt !== null &&
      typeof payload.registry_receipt === 'object';

    // 1. Persist raw event. Idempotent: a registry retry with the same
    //    fingerprint is skipped (create() returns null on conflict) so we
    //    don't double-insert lineage nodes or double-fire SSE/webhooks.
    const created = await this.contextEventRepo.create({
      tenantId,
      eventType,
      eventTs,
      runId: runId ?? null,
      ctxId: ctxId ?? null,
      lineageId: lineageId ?? null,
      agentId,
      contextType: contextType ?? null,
      visibility: visibility ?? null,
      version: version ?? null,
      derivedFrom,
      registryAuthority,
      scenarioId: scenarioId ?? null,
      fingerprint,
      keyFingerprint: keyFingerprint ?? null,
      receiptPresent,
      rawPayload: payload as unknown as Record<string, unknown>,
    });
    if (created === null) {
      this.logger.debug(`duplicate event skipped fingerprint=${fingerprint}`);
      return;
    }

    this.instrumentation.eventsIngestedTotal.inc({ event_type: eventType });

    // Trust-signal metrics (ACDP 0.2.0): receipt coverage per registry and
    // the producer DID-method mix, both scoped to publish events.
    if (eventType === 'context_published') {
      this.instrumentation.publishReceiptsTotal.inc({
        registry_authority: registryAuthority || 'unknown',
        receipt: receiptPresent ? 'present' : 'absent',
      });
      this.instrumentation.producerDidMethodTotal.inc({
        method: didMethodOf(agentId),
      });
    }

    // 2. Run correlation — upsert run record
    if (runId) {
      await this.runRepo.upsertFromEvent(
        runId,
        scenarioId ?? 'unknown',
        registryAuthority,
        tenantId,
      );
    }

    // 3. Lineage edges — one per derived_from entry on context_published
    if (eventType === 'context_published' && ctxId && derivedFrom.length > 0) {
      for (const fromCtxId of derivedFrom) {
        await this.lineageRepo.upsert({ fromCtxId, toCtxId: ctxId, runId, tenantId });
      }
    }

    // 4. Agent registry
    if (agentId) {
      await this.agentRepo.upsert(agentId, registryAuthority, tenantId);
    }

    // 5. Registry registry. Capture the base URL so the federation proxy
    //    can reach this registry later: prefer the explicit payload field,
    //    fall back to the request Origin header (BUG-CP-07 / FEAT-CP-04).
    if (registryAuthority) {
      const baseUrl =
        (typeof payload.registry_base_url === 'string'
          ? payload.registry_base_url
          : undefined) ?? originHeader;
      await this.registryRepo.upsert(registryAuthority, baseUrl, tenantId);
    }

    // 6. Pub/sub — emit to SSE subscribers (per run + global)
    const streamEvent: AcdpStreamEvent = {
      type: eventType,
      ts: eventTs,
      runId,
      ctxId,
      agentId,
      contextType,
      registryAuthority,
      derivedFrom,
      // ACDP 0.2.0 trust signals pass through unchanged (additive — SSE
      // consumers tolerate unknown members). receiptPresent only carries
      // meaning on publishes, so it is omitted elsewhere.
      ...(keyFingerprint ? { keyFingerprint } : {}),
      ...(eventType === 'context_published' ? { receiptPresent } : {}),
    };
    if (runId) this.streamHub.publishToRun(runId, streamEvent, tenantId);
    this.streamHub.publishGlobal(streamEvent, tenantId);

    // 7. Outbound webhooks — fire-and-forget, scoped to the event's tenant
    void this.webhookService.fireEvent(
      {
        event: eventType,
        runId: runId ?? '',
        timestamp: eventTs,
        data: streamEvent as unknown as Record<string, unknown>,
      },
      tenantId,
    );
  }

  /**
   * Dedup key for ingest idempotency.
   *
   * Prefer the registry-minted `event_id` (REG-P2-6): it is minted once at
   * emit and reused across retries, so it dedupes even if the registry
   * reshapes a payload field, and — unlike a content hash — never falsely
   * collapses two genuinely distinct events that share (type, agent,
   * created_at), e.g. the ctx_id-less context_retrieved / search_executed
   * variants. Namespaced `evt:` so it can never collide with the hex content
   * hash below.
   *
   * Fall back to a stable content fingerprint for registries not yet sending
   * an event_id. The fallback hash shape is unchanged from migration 0009 so
   * pre-existing rows keep deduping across the upgrade.
   */
  private dedupKey(payload: AcdpWebhookEvent, runId?: string, eventId?: string): string {
    if (eventId) return `evt:${eventId}`;
    const key = [
      payload.type ?? '',
      payload.ctx_id ?? '',
      payload.agent_id ?? '',
      payload.created_at ?? '',
      runId ?? '',
      payload.version ?? '',
    ].join(':');
    return createHash('sha256').update(key).digest('hex').slice(0, 32);
  }

  private extractScenarioId(payload: AcdpWebhookEvent): string | undefined {
    const meta = payload.metadata as Record<string, unknown> | undefined;
    return (meta?.['scenario_id'] ?? payload.scenario_id) as string | undefined;
  }
}

/**
 * Classify an agent DID by method for the producer-mix metric. did:key agent
 * ids (ACDP 0.2.0 workstream C) are long opaque strings with no domain — they
 * are never parsed beyond this prefix check anywhere in the control plane.
 */
function didMethodOf(agentId: string): 'did:web' | 'did:key' | 'other' {
  if (agentId.startsWith('did:web:')) return 'did:web';
  if (agentId.startsWith('did:key:')) return 'did:key';
  return 'other';
}
