import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

// Raw ACDP webhook events ingested from registries.
export const contextEvents = pgTable(
  'context_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Tenant boundary. Defaults to 'default' for backward compat with
    // single-tenant deployments; the migration backfills existing rows.
    tenantId: varchar('tenant_id', { length: 255 }).notNull().default('default'),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    eventTs: timestamp('event_ts', { withTimezone: true, mode: 'string' }).notNull(),
    runId: varchar('run_id', { length: 255 }),
    ctxId: text('ctx_id'),
    lineageId: text('lineage_id'),
    agentId: text('agent_id').notNull(),
    contextType: varchar('context_type', { length: 128 }),
    visibility: varchar('visibility', { length: 32 }),
    version: integer('version'),
    derivedFrom: jsonb('derived_from').$type<string[]>().notNull().default([]),
    registryAuthority: varchar('registry_authority', { length: 255 }).notNull(),
    scenarioId: varchar('scenario_id', { length: 128 }),
    // Dedup key for ingest idempotency. A partial unique index on
    // (tenant_id, fingerprint) (migration 0009) dedupes registry retries.
    // Holds either the registry's `evt:<event_id>` (REG-P2-6, retry-stable)
    // or a 32-char content-hash fallback; widened to 80 in migration 0011.
    fingerprint: varchar('fingerprint', { length: 80 }),
    // ACDP 0.2.0 trust metadata (RFC-ACDP-0010, migration 0014). Both are
    // additive: 0.1.0 registries simply never set them. `keyFingerprint` is
    // the "sha256:<64-hex>" of the producer key the registry verified at
    // publish time; `receiptPresent` records whether the event carried a
    // `registry_receipt` (the receipt itself stays in rawPayload verbatim).
    keyFingerprint: varchar('key_fingerprint', { length: 80 }),
    receiptPresent: boolean('receipt_present').notNull().default(false),
    rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index('ce_tenant_idx').on(t.tenantId),
    runIdx: index('ce_run_idx').on(t.runId),
    ctxIdx: index('ce_ctx_idx').on(t.ctxId),
    tsIdx: index('ce_ts_idx').on(t.eventTs),
    agentIdx: index('ce_agent_idx').on(t.agentId),
    lineageIdx: index('ce_lineage_idx').on(t.lineageId),
    typeIdx: index('ce_type_idx').on(t.eventType),
  }),
);

// Playground run records (correlated by X-Run-Id).
export const runs = pgTable(
  'runs',
  {
    runId: varchar('run_id', { length: 255 }).notNull(),
    tenantId: varchar('tenant_id', { length: 255 }).notNull().default('default'),
    scenarioId: varchar('scenario_id', { length: 128 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
    inputs: jsonb('inputs').$type<Record<string, unknown>>(),
    result: jsonb('result').$type<Record<string, unknown>>(),
    contextsCount: integer('contexts_count').notNull().default(0),
    registries: jsonb('registries').$type<string[]>().notNull().default([]),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Composite PK: the same run_id can exist under different tenants.
    pk: primaryKey({ columns: [t.tenantId, t.runId] }),
    tenantIdx: index('runs_tenant_idx').on(t.tenantId),
    statusIdx: index('runs_status_idx').on(t.status),
    scenarioIdx: index('runs_scenario_idx').on(t.scenarioId),
    startedIdx: index('runs_started_idx').on(t.startedAt),
  }),
);

// Per-context lifecycle projection (ACDP 0.3.0, RFC-ACDP-0013 retract /
// republish; migration 0015). There is no contexts table — lineage DAG nodes
// are derived at query time from the append-only context_events log — so the
// CURRENT retraction state gets its own keyed projection instead of mutating
// event rows (which may not even exist: a retract can arrive for a context
// whose publish this control plane never saw, or that retention already
// swept). One row per (tenant, ctx_id); transitions are last-write-wins by
// the lifecycle event's own timestamp (`last_event_at`) so replays and
// out-of-order deliveries are idempotent.
export const contextLifecycle = pgTable(
  'context_lifecycle',
  {
    ctxId: text('ctx_id').notNull(),
    tenantId: varchar('tenant_id', { length: 255 }).notNull().default('default'),
    lineageId: text('lineage_id'),
    // Current state: true between a retract and a subsequent republish.
    retracted: boolean('retracted').notNull().default(false),
    // Most recent transition timestamps (history lives in context_events /
    // the registry's registry_state.lifecycle_events, not here).
    retractedAt: timestamp('retracted_at', { withTimezone: true, mode: 'string' }),
    republishedAt: timestamp('republished_at', { withTimezone: true, mode: 'string' }),
    // DID + optional reason of the LAST applied transition (console tooltips).
    actor: text('actor'),
    reason: text('reason'),
    // Event-time of the last applied transition — the idempotence guard.
    lastEventAt: timestamp('last_event_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.ctxId] }),
    retractedIdx: index('cl_retracted_idx').on(t.retracted),
    lineageIdx: index('cl_lineage_idx').on(t.lineageId),
  }),
);

// Lineage adjacency: to_ctx_id DERIVES FROM from_ctx_id.
export const lineageEdges = pgTable(
  'lineage_edges',
  {
    fromCtxId: text('from_ctx_id').notNull(),
    toCtxId: text('to_ctx_id').notNull(),
    runId: varchar('run_id', { length: 255 }),
    tenantId: varchar('tenant_id', { length: 255 }).notNull().default('default'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.fromCtxId, t.toCtxId] }),
    toIdx: index('le_to_idx').on(t.toCtxId),
    fromIdx: index('le_from_idx').on(t.fromCtxId),
    runIdx: index('le_run_idx').on(t.runId),
    tenantIdx: index('le_tenant_idx').on(t.tenantId),
  }),
);

// Known agent DIDs observed through events.
export const agents = pgTable(
  'agents',
  {
    agentDid: text('agent_did').notNull(),
    tenantId: varchar('tenant_id', { length: 255 }).notNull().default('default'),
    firstSeen: timestamp('first_seen', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    lastSeen: timestamp('last_seen', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    registryAuthority: varchar('registry_authority', { length: 255 }),
    contextCount: integer('context_count').notNull().default(0),
  },
  (t) => ({
    // Composite PK: the same agent_did can be seen under different tenants.
    pk: primaryKey({ columns: [t.tenantId, t.agentDid] }),
  }),
);

// Known registries observed through events.
export const registries = pgTable(
  'registries',
  {
    authority: varchar('authority', { length: 255 }).notNull(),
    tenantId: varchar('tenant_id', { length: 255 }).notNull().default('default'),
    baseUrl: text('base_url'),
    firstSeen: timestamp('first_seen', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    lastSeen: timestamp('last_seen', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    eventCount: integer('event_count').notNull().default(0),
  },
  (t) => ({
    // Composite PK: the same authority can be enrolled under different tenants.
    pk: primaryKey({ columns: [t.tenantId, t.authority] }),
  }),
);

// Registry enrollment — the ingest trust anchor (CP-3.1). One row per
// authority (PK), binding it to a single tenant with an optional
// per-registry webhook secret + base URL.
export const registryEnrollments = pgTable(
  'registry_enrollments',
  {
    authority: varchar('authority', { length: 255 }).primaryKey(),
    tenantId: varchar('tenant_id', { length: 255 }).notNull().default('default'),
    baseUrl: text('base_url'),
    registryDid: text('registry_did'),
    webhookSecret: varchar('webhook_secret', { length: 255 }),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index('registry_enrollments_tenant_idx').on(t.tenantId),
  }),
);

// Outbound webhook subscriptions.
export const webhooks = pgTable('webhooks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: varchar('tenant_id', { length: 255 }).notNull().default('default'),
  url: text('url').notNull(),
  events: jsonb('events').$type<string[]>().notNull().default([]),
  secret: varchar('secret', { length: 255 }).notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: varchar('tenant_id', { length: 255 }).notNull().default('default'),
  webhookId: uuid('webhook_id')
    .notNull()
    .references(() => webhooks.id, { onDelete: 'cascade' }),
  event: varchar('event', { length: 128 }).notNull(),
  runId: varchar('run_id', { length: 255 }).notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: varchar('status', { length: 32 }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'string' }),
  responseStatus: integer('response_status'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'string' }),
  // Earliest time the retry sweep may re-attempt this delivery. NULL =
  // eligible immediately. Set from a 429 `Retry-After` to defer the row.
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'string' }),
});

// One-shot challenge nonces issued by /auth/challenge.
// Take is atomic via DELETE..RETURNING so two concurrent /auth/token
// callers cannot both consume the same nonce.
export const authChallenges = pgTable(
  'auth_challenges',
  {
    nonce: varchar('nonce', { length: 64 }).primaryKey(),
    agentDid: text('agent_did').notNull(),
    registryAuthority: varchar('registry_authority', { length: 255 }).notNull(),
    signingInput: text('signing_input').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    expiresIdx: index('auth_challenges_expires_idx').on(t.expiresAt),
    agentIdx: index('auth_challenges_agent_idx').on(t.agentDid),
  }),
);

// Revoked-token list. A JWT `jti` in this table is treated as invalid
// by verifyJwt() until its `exp` passes, after which the sweeper drops
// the row (the JWT is already expired by ordinary verification anyway).
export const revokedTokens = pgTable(
  'revoked_tokens',
  {
    jti: varchar('jti', { length: 64 }).primaryKey(),
    sub: text('sub').notNull(),
    iss: text('iss').notNull(),
    exp: bigint('exp', { mode: 'number' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    revokedBy: text('revoked_by').notNull(),
    reason: varchar('reason', { length: 64 }),
  },
  (t) => ({
    expIdx: index('revoked_tokens_exp_idx').on(t.exp),
    subIdx: index('revoked_tokens_sub_idx').on(t.sub),
  }),
);

// Durable per-issuer cursor for the cross-issuer revocation poller
// (`RevocationPollerService`). `cursor_ms` is the unix-ms `revoked_at` of the
// last applied entry from `issuer`'s feed; the poller resumes here on restart
// so it doesn't re-fetch the whole feed from since=0. Mirrors the registry's
// per-issuer revocation cursor.
export const revocationCursors = pgTable('revocation_cursors', {
  issuer: text('issuer').primaryKey(),
  cursorMs: bigint('cursor_ms', { mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

// Self-declared agent capabilities (#4). Signature gates the write so
// a third party can't claim capabilities for an agent they don't control.
export const agentCapabilities = pgTable(
  'agent_capabilities',
  {
    agentDid: text('agent_did').notNull(),
    capabilityUri: text('capability_uri').notNull(),
    tenantId: varchar('tenant_id', { length: 255 }).notNull().default('default'),
    declaredAt: timestamp('declared_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    signedBy: text('signed_by').notNull(),
    signature: text('signature').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.agentDid, t.capabilityUri] }),
    capabilityIdx: index('agent_capabilities_capability_idx').on(t.capabilityUri),
    tenantIdx: index('agent_capabilities_tenant_idx').on(t.tenantId),
  }),
);

// Append-only audit ledger of token-issuance attempts. Decisions are
// recorded for both `mint` (successful JWT) and `reject_*` (each
// validation failure point) so operators can answer compliance
// questions like "how many tokens were issued for sub=X today" or
// "show me all unauthorized attempts from agent Y last hour".
//
// `prev_hash` / `entry_hash` build a SHA-256 hash chain across rows
// in `id` order so post-hoc tampering with a row becomes detectable
// at audit time (the read path can recompute the chain). Not
// Merkle-grade tamper proof; protects against surgical edits, not
// full-tail rewrite.
export const issuanceLedger = pgTable(
  'issuance_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jti: varchar('jti', { length: 64 }),
    sub: text('sub'),
    iss: text('iss'),
    iat: bigint('iat', { mode: 'number' }),
    exp: bigint('exp', { mode: 'number' }),
    signerIp: varchar('signer_ip', { length: 64 }),
    decision: varchar('decision', { length: 32 }).notNull(),
    decisionDetail: text('decision_detail'),
    prevHash: varchar('prev_hash', { length: 64 }),
    entryHash: varchar('entry_hash', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    subIdx: index('issuance_ledger_sub_idx').on(t.sub),
    jtiIdx: index('issuance_ledger_jti_idx').on(t.jti),
    decisionIdx: index('issuance_ledger_decision_idx').on(t.decision),
    createdIdx: index('issuance_ledger_created_idx').on(t.createdAt),
  }),
);

// Receipt-audit verdicts (ACDP 0.2.0 second-observer mode, migration 0014).
// One row per audited context_published event. `eventArrivedAt` (when this
// control plane first persisted the event) vs the receipt's claimed
// `receiptCreatedAt` is the backdating-detection window.
export const receiptAudits = pgTable(
  'receipt_audits',
  {
    eventId: uuid('event_id').primaryKey(),
    tenantId: varchar('tenant_id', { length: 255 }).notNull().default('default'),
    runId: varchar('run_id', { length: 255 }),
    ctxId: text('ctx_id'),
    registryAuthority: varchar('registry_authority', { length: 255 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    discrepancies: jsonb('discrepancies').$type<string[]>().notNull().default([]),
    receiptCreatedAt: timestamp('receipt_created_at', {
      withTimezone: true,
      mode: 'string',
    }),
    eventArrivedAt: timestamp('event_arrived_at', {
      withTimezone: true,
      mode: 'string',
    }),
    skewMs: bigint('skew_ms', { mode: 'number' }),
    checkedAt: timestamp('checked_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    runIdx: index('ra_run_idx').on(t.runId),
    statusIdx: index('ra_status_idx').on(t.status),
    tenantIdx: index('ra_tenant_idx').on(t.tenantId),
    registryIdx: index('ra_registry_idx').on(t.registryAuthority),
  }),
);

// Transparency-log checkpoint witness (ACDP 0.3.0 Tier 3, RFC-ACDP-0012,
// migration 0016). Every checkpoint (signed tree head) this control plane has
// witnessed, verbatim — the forensic anchors §13/§15 call for. Witness/monitor
// role only: cosigning is the reserved RFC-ACDP-0009 §2.12 work.
export const logWitnessCheckpoints = pgTable(
  'log_witness_checkpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: varchar('tenant_id', { length: 255 }).notNull().default('default'),
    registryAuthority: varchar('registry_authority', { length: 255 }).notNull(),
    logId: text('log_id').notNull(),
    treeSize: bigint('tree_size', { mode: 'number' }).notNull(),
    rootHash: varchar('root_hash', { length: 80 }).notNull(),
    // Registry-asserted evaluation time from the checkpoint itself (§6).
    timestamp: timestamp('timestamp', { withTimezone: true, mode: 'string' }).notNull(),
    rawCheckpoint: jsonb('raw_checkpoint').$type<Record<string, unknown>>().notNull(),
    witnessedAt: timestamp('witnessed_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    signatureValid: boolean('signature_valid').notNull(),
    // §9.2 verdict vs the previously witnessed head of the same log_id;
    // NULL for the first witnessed checkpoint of a log.
    consistencyOk: boolean('consistency_ok'),
  },
  (t) => ({
    // Dedupes re-fetches of the same head; two rows sharing (log_id,
    // tree_size) with different root_hash are split-view evidence.
    uniqueHead: uniqueIndex('log_witness_checkpoints_log_id_tree_size_root_hash_key').on(
      t.logId,
      t.treeSize,
      t.rootHash,
    ),
    authorityIdx: index('lwc_authority_idx').on(t.registryAuthority),
    tenantIdx: index('lwc_tenant_idx').on(t.tenantId),
    logSizeIdx: index('lwc_log_size_idx').on(t.logId, t.treeSize),
  }),
);

// Per-registry witness cursor + alert state. The cursor advances ONLY on a
// fully verified sweep step; on any failure it holds so the retained root
// stays available as the §9.2 first_root for the next consistency demand.
export const logWitnessCursors = pgTable(
  'log_witness_cursors',
  {
    registryAuthority: varchar('registry_authority', { length: 255 }).notNull(),
    tenantId: varchar('tenant_id', { length: 255 }).notNull().default('default'),
    logId: text('log_id'),
    lastWitnessedSize: bigint('last_witnessed_size', { mode: 'number' }),
    lastRootHash: varchar('last_root_hash', { length: 80 }),
    // Environmental (transport/resolution) failures since the last success;
    // dishonesty signals set the alert fields instead.
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    alerted: boolean('alerted').notNull().default(false),
    lastAlertReason: varchar('last_alert_reason', { length: 64 }),
    lastAlertDetail: jsonb('last_alert_detail').$type<Record<string, unknown>>(),
    lastAlertAt: timestamp('last_alert_at', { withTimezone: true, mode: 'string' }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true, mode: 'string' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.registryAuthority] }),
    alertedIdx: index('lwcur_alerted_idx').on(t.alerted),
  }),
);

// Receipt ↔ log inclusion cross-check verdicts (RFC-ACDP-0012 §9.1). A
// PARALLEL table to receipt_audits (not new columns on it): audit rows are
// sealed once (PK = event id, on-conflict-do-nothing), and §9.3 requires the
// receipt verdict and log verdict to stay independent — a later log verdict
// must not mutate a sealed receipt verdict row.
export const logInclusionAudits = pgTable(
  'log_inclusion_audits',
  {
    eventId: uuid('event_id').primaryKey(),
    tenantId: varchar('tenant_id', { length: 255 }).notNull().default('default'),
    runId: varchar('run_id', { length: 255 }),
    ctxId: text('ctx_id'),
    registryAuthority: varchar('registry_authority', { length: 255 }).notNull(),
    logId: text('log_id'),
    leafIndex: bigint('leaf_index', { mode: 'number' }),
    treeSize: bigint('tree_size', { mode: 'number' }),
    // included | invalid_proof | not_logged | no_log | error
    status: varchar('status', { length: 32 }).notNull(),
    detail: jsonb('detail').$type<string[]>().notNull().default([]),
    checkedAt: timestamp('checked_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusIdx: index('lia_status_idx').on(t.status),
    tenantIdx: index('lia_tenant_idx').on(t.tenantId),
    registryIdx: index('lia_registry_idx').on(t.registryAuthority),
    runIdx: index('lia_run_idx').on(t.runId),
  }),
);

export type ContextEvent = typeof contextEvents.$inferSelect;
export type NewContextEvent = typeof contextEvents.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type LineageEdge = typeof lineageEdges.$inferSelect;
export type ContextLifecycle = typeof contextLifecycle.$inferSelect;
export type NewContextLifecycle = typeof contextLifecycle.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type Registry = typeof registries.$inferSelect;
export type RegistryEnrollment = typeof registryEnrollments.$inferSelect;
export type NewRegistryEnrollment = typeof registryEnrollments.$inferInsert;
export type Webhook = typeof webhooks.$inferSelect;
export type NewWebhook = typeof webhooks.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type AuthChallenge = typeof authChallenges.$inferSelect;
export type NewAuthChallenge = typeof authChallenges.$inferInsert;
export type RevokedToken = typeof revokedTokens.$inferSelect;
export type NewRevokedToken = typeof revokedTokens.$inferInsert;
export type RevocationCursor = typeof revocationCursors.$inferSelect;
export type NewRevocationCursor = typeof revocationCursors.$inferInsert;
export type AgentCapability = typeof agentCapabilities.$inferSelect;
export type NewAgentCapability = typeof agentCapabilities.$inferInsert;
export type IssuanceLedgerEntry = typeof issuanceLedger.$inferSelect;
export type NewIssuanceLedgerEntry = typeof issuanceLedger.$inferInsert;
export type ReceiptAudit = typeof receiptAudits.$inferSelect;
export type NewReceiptAudit = typeof receiptAudits.$inferInsert;
export type LogWitnessCheckpoint = typeof logWitnessCheckpoints.$inferSelect;
export type NewLogWitnessCheckpoint = typeof logWitnessCheckpoints.$inferInsert;
export type LogWitnessCursor = typeof logWitnessCursors.$inferSelect;
export type NewLogWitnessCursor = typeof logWitnessCursors.$inferInsert;
export type LogInclusionAudit = typeof logInclusionAudits.$inferSelect;
export type NewLogInclusionAudit = typeof logInclusionAudits.$inferInsert;
