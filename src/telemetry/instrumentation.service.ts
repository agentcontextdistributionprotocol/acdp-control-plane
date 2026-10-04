import { Injectable, OnModuleInit } from '@nestjs/common';
import * as client from 'prom-client';

/** The pg pool counters `acdp_db_pool_connections` reports (a `pg.Pool` satisfies it). */
export interface DbPoolCounts {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

/** A report-only dependency's state; `n/a` = not in use in this deployment. */
export type DependencyStatus = 'up' | 'down' | 'n/a';

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

  /** Live since #192: inc on SSE subscribe, dec on teardown (src/events/sse-drain.ts). */
  readonly activeSseConnections = new client.Gauge({
    name: 'active_sse_connections',
    help: 'Number of active SSE connections',
  });

  readonly sseStreamsTerminatedTotal = new client.Counter({
    name: 'acdp_sse_streams_terminated_total',
    help: 'SSE streams ended by the server, by reason (shutdown = graceful drain, issue #192)',
    labelNames: ['reason'] as const,
  });

  /** #192: new requests answered 503 SERVICE_DRAINING by the drain gate.
   *  Best effort — a dying process is rarely scraped; the shutdown summary log
   *  line is the primary signal. */
  readonly shutdownDrainRejectionsTotal = new client.Counter({
    name: 'acdp_shutdown_drain_rejections_total',
    help: 'New requests rejected with 503 SERVICE_DRAINING during a shutdown drain (issue #192)',
  });

  /** #192: sockets still open when a graceful close overran SHUTDOWN_TIMEOUT_MS
   *  and was forced (incremented by the count, just before closeAllConnections). */
  readonly shutdownForcedConnectionsTotal = new client.Counter({
    name: 'acdp_shutdown_forced_connections_total',
    help: 'Connections force-closed when a graceful shutdown overran SHUTDOWN_TIMEOUT_MS (issue #192)',
  });

  /** #210: REAL readiness probe executions (cache hits and joins of an
   *  in-flight probe are not counted), by dependency and result
   *  (`ok` | `error` | `timeout`). */
  readonly readinessChecksTotal = new client.Counter({
    name: 'acdp_readiness_checks_total',
    help: 'Readiness dependency probes actually executed (not cache hits), by dependency and result (ok|error|timeout) (issue #210)',
    labelNames: ['dependency', 'result'] as const,
  });

  /** #210 Phase 3: scrape-time sources for the NON-required (report-only)
   *  dependencies, keyed by the `dependency` label. Registered by
   *  `ReadinessService`; `'n/a'` reports nothing for that label. */
  private readonly dependencySources = new Map<string, () => DependencyStatus>();

  /** #210 Phase 3: scrape-time source for the pg pool counters (D12 — the
   *  pool's owner `DatabaseService` cannot inject this service, so
   *  `ReadinessService` registers it). */
  private dbPoolSource: (() => DbPoolCounts) | undefined;

  /** #210: 1 when the dependency is up, else 0. `database` is set on every
   *  REAL readiness probe; the report-only dependencies (e.g.
   *  `redis_stream_hub`, Phase 3) are read at scrape time from their source. */
  readonly dependencyUp = new client.Gauge({
    name: 'acdp_dependency_up',
    help: 'Whether a dependency is up (1) or not (0): database = its last real readiness probe; report-only dependencies (redis_stream_hub, redis_quota_store) are read at scrape time (issue #210)',
    labelNames: ['dependency'] as const,
    collect: () => {
      for (const [dependency, source] of this.dependencySources) {
        const status = source();
        if (status === 'n/a') this.dependencyUp.remove({ dependency });
        else this.dependencyUp.set({ dependency }, status === 'up' ? 1 : 0);
      }
    },
  });

  /** #210 Phase 2 (D12): pool `'error'` events — an IDLE pooled client lost
   *  its socket (e.g. a Postgres restart or failover). pg-pool already drops
   *  that client and reconnects on demand; a persistent outage shows up on
   *  the readiness probe instead. */
  readonly dbPoolErrorsTotal = new client.Counter({
    name: 'acdp_db_pool_errors_total',
    help: "pg pool 'error' events: an idle pooled client lost its connection (recoverable; issue #210)",
  });

  /** #210 Phase 3: pg pool clients by state, read at scrape time. `waiting`
   *  > 0 means requests are queued for a connection (saturation). Reports
   *  nothing (not zeros) until a source is registered. */
  readonly dbPoolConnections = new client.Gauge({
    name: 'acdp_db_pool_connections',
    help: 'pg pool clients by state at scrape time: total, idle, waiting (queued checkouts) (issue #210)',
    labelNames: ['state'] as const,
    collect: () => {
      const pool = this.dbPoolSource?.();
      if (!pool) return;
      this.dbPoolConnections.set({ state: 'total' }, pool.totalCount);
      this.dbPoolConnections.set({ state: 'idle' }, pool.idleCount);
      this.dbPoolConnections.set({ state: 'waiting' }, pool.waitingCount);
    },
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

  // RFC-ACDP-0014 §7 lineage walk (issue #173) — a DISTINCT metric from the
  // one above, deliberately not folded into it: that counter is the
  // webhook-CANDIDATE verification sweep's own outcomes; this one is the
  // per-MEMBER outcomes discovered only by walking a lineage
  // (`walkRevocationLineage`). Both use the identical 'verified' | 'invalid'
  // | 'unavailable' | 'unsupported' status vocabulary (so no conflation risk
  // the way Phase 14's counter had to avoid — see ASSUMPTIONS.md), but a
  // member found only via the lineage walk was never itself a webhook
  // candidate, so folding the two into one counter would silently
  // double-count exactly the members #173 exists to make visible, and would
  // make "how many candidates did we see" and "how many lineage members did
  // we see" impossible to tell apart from the metric alone. Counted per
  // observation, re-counted on every re-walk of an unresolved lineage — read
  // as a rate, not a census (see docs/ARCHITECTURE.md).
  readonly keyRevocationLineageMembersTotal = new client.Counter({
    name: 'acdp_key_revocation_lineage_members_total',
    help: 'RFC-ACDP-0014 §7 lineage-walk per-member verification verdicts, by status',
    labelNames: ['status'] as const,
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

  /** #210 Phase 3: read `acdp_db_pool_connections` from `source` at scrape time. */
  registerDbPoolSource(source: () => DbPoolCounts): void {
    this.dbPoolSource = source;
  }

  /** #210 Phase 3: read `acdp_dependency_up{dependency}` from `source` at
   *  scrape time (report-only dependencies; `database` is probe-driven). */
  registerDependencySource(dependency: string, source: () => DependencyStatus): void {
    this.dependencySources.set(dependency, source);
  }

  async getMetrics(): Promise<string> {
    return client.register.metrics();
  }

  getContentType(): string {
    return client.register.contentType;
  }
}
