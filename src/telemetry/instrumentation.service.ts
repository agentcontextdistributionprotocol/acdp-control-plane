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
