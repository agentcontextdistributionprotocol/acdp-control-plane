import { Injectable, OnModuleInit } from '@nestjs/common';
import * as client from 'prom-client';

@Injectable()
export class InstrumentationService implements OnModuleInit {
  readonly httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'path', 'status_code'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  });

  readonly httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'path', 'status_code'] as const,
  });

  readonly activeSseConnections = new client.Gauge({
    name: 'active_sse_connections',
    help: 'Number of active SSE connections',
  });

  readonly eventsIngestedTotal = new client.Counter({
    name: 'acdp_events_ingested_total',
    help: 'Total ACDP webhook events ingested',
    labelNames: ['event_type'] as const,
  });

  readonly webhookDeliveriesTotal = new client.Counter({
    name: 'acdp_webhook_deliveries_total',
    help: 'Total outbound webhook deliveries by status',
    labelNames: ['status'] as const,
  });

  readonly ingestRejectedTotal = new client.Counter({
    name: 'acdp_ingest_rejected_total',
    help: 'Total inbound webhook events rejected at the ingest boundary, by reason',
    labelNames: ['reason'] as const,
  });

  // ── ACDP 0.2.0 trust signals (RFC-ACDP-0010) ──────────────────────────

  readonly publishReceiptsTotal = new client.Counter({
    name: 'acdp_publish_receipts_total',
    help: 'context_published events by registry and registry-receipt presence',
    labelNames: ['registry_authority', 'receipt'] as const,
  });

  readonly producerDidMethodTotal = new client.Counter({
    name: 'acdp_producer_did_method_total',
    help: 'context_published events by producer DID method (did:web / did:key / other)',
    labelNames: ['method'] as const,
  });

  readonly receiptAuditsTotal = new client.Counter({
    name: 'acdp_receipt_audits_total',
    help: 'Receipt-audit verdicts by status (second-observer mode)',
    labelNames: ['status'] as const,
  });

  // ── ACDP 0.3.0 Tier 3 transparency-log witness (RFC-ACDP-0012) ────────

  readonly logWitnessChecksTotal = new client.Counter({
    name: 'acdp_log_witness_checks_total',
    help: 'Checkpoint-witness passes by result (witnessed / alert / error)',
    labelNames: ['result'] as const,
  });

  readonly logWitnessAlertsTotal = new client.Counter({
    name: 'acdp_log_witness_alerts_total',
    help: 'Transparency-log witness alerts by reason (root rewrite, split view, ...)',
    labelNames: ['reason'] as const,
  });

  readonly logInclusionAuditsTotal = new client.Counter({
    name: 'acdp_log_inclusion_audits_total',
    help: 'Receipt-vs-log inclusion cross-check verdicts by status',
    labelNames: ['status'] as const,
  });

  readonly logCosignaturesTotal = new client.Counter({
    name: 'acdp_log_cosignatures_total',
    help: 'Witness cosignatures minted by result (minted / duplicate / error) (RFC-ACDP-0015)',
    labelNames: ['result'] as const,
  });

  readonly logWitnessQuorumTotal = new client.Counter({
    name: 'acdp_log_witness_quorum_total',
    help: 'Witness quorum evaluations over aggregated cosignatures by meets-quorum (RFC-ACDP-0015 §8)',
    labelNames: ['meets'] as const,
  });

  // ── ACDP 0.3.0 producer key-revocation (RFC-ACDP-0014) ────────────────

  readonly keyRevocationChecksTotal = new client.Counter({
    name: 'acdp_key_revocation_checks_total',
    help: 'Producer key-revocation verification sweep outcomes by status and trust class',
    labelNames: ['status', 'trust_class'] as const,
  });

  // RFC-ACDP-0014 §7 consumer classification (Phase 14) — a DISTINCT metric
  // from the one above, deliberately not folded into it: that counter is
  // the revocation-AUDIT sweep's own body-verification outcomes ('verified'
  // | 'invalid' | 'unavailable' | 'unsupported' — the last a capability gap,
  // e.g. an ecdsa-p256 signer, never a verification failure — over a
  // revocation CONTEXT'S signature), this
  // one is the receipt-audit sweep's §7 boundary classification of an
  // ORDINARY audited event ('none' | 'pre_compromise' |
  // 'revoked_at_or_after' | 'revoked_time_unverifiable'). Sharing one
  // counter across both would silently conflate two unrelated status
  // vocabularies under the same label values.
  readonly receiptAuditKeyRevocationsTotal = new client.Counter({
    name: 'acdp_receipt_audit_key_revocation_total',
    help: 'RFC-ACDP-0014 §7 compromise-boundary classification outcomes for audited receipts, by status',
    labelNames: ['status'] as const,
  });

  // RFC-ACDP-0014 §7 retroactive re-audit (Phase 15) — a DISTINCT metric
  // from the one above, deliberately not folded into it: that counter is
  // the LIVE classification of a freshly-audited event; this one is the
  // FAN-OUT amendment of an ALREADY-sealed row, driven by a revocation
  // fact recorded after the fact. Conflating them would hide the
  // retroactive-correction signal inside ordinary sweep traffic — the
  // progress metric the plan's Scale edge case calls for.
  readonly receiptAuditRevocationReauditsTotal = new client.Counter({
    name: 'acdp_receipt_audit_revocation_reaudits_total',
    help: 'RFC-ACDP-0014 §7 retroactive amendments to already-sealed receipt_audits rows, by resulting status (including the pseudo-status "error" for a row that threw during re-classification)',
    labelNames: ['status'] as const,
  });

  onModuleInit(): void {
    client.collectDefaultMetrics();
  }

  async getMetrics(): Promise<string> {
    return client.register.metrics();
  }

  getContentType(): string {
    return client.register.contentType;
  }
}
