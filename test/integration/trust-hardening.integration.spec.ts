/**
 * ACDP 0.2.0 trust & hardening (RFC-ACDP-0010) — integration coverage for
 * the plan's acceptance criteria:
 *
 *   1. 0.2.0 traffic (key_fingerprint + registry_receipt) ingests cleanly,
 *      is persisted to the new columns, and survives verbatim in the raw
 *      payload (open-schema regression — the RFC openness map).
 *   2. A did:key-producer run renders end-to-end (events, run detail,
 *      lineage) with no parsing errors — did:key agent ids are opaque.
 *   3. The receipt-audit sweep produces verdicts that surface on the run's
 *      `trust` member. The harness registry (registry-a.example) is not a
 *      real host, so the crypto phase ends at the federation fetch with an
 *      `error` verdict — real cryptographic verification (genuine + tampered
 *      receipts against the acdp 0.4.0 binding) is covered in
 *      src/audit/receipt-verify.spec.ts, and the full orchestration in
 *      src/audit/receipt-audit.service.crypto.spec.ts.
 */
import { ReceiptAuditService } from '../../src/audit/receipt-audit.service';
import { createTestApp, TestAppContext } from '../helpers/test-app';

const SECRET = 'integration-test-secret';
const AUTHORITY = 'registry-a.example';
const FP = 'sha256:' + 'b'.repeat(64);
const DID_KEY = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

function makeReceipt(ctxId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    registry_did: `did:web:${AUTHORITY}`,
    ctx_id: ctxId,
    lineage_id: 'lineage-001',
    origin_registry: AUTHORITY,
    created_at: '2026-06-12T00:00:00.000Z',
    content_hash: 'sha256:' + 'a'.repeat(64),
    key_fingerprint: FP,
    signature: {
      algorithm: 'ed25519',
      key_id: `did:web:${AUTHORITY}#receipt-key-1`,
      value: 'c2ln',
    },
    ...overrides,
  };
}

function makeEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: 'context_published',
    ctx_id: `acdp://${AUTHORITY}/ctx-001`,
    lineage_id: 'lineage-001',
    agent_id: 'did:web:agent-1.example',
    context_type: 'analysis',
    visibility: 'public',
    version: 1,
    derived_from: [],
    registry_authority: AUTHORITY,
    registry_base_url: `https://${AUTHORITY}`,
    scenario_id: 'scenario-trust',
    created_at: '2026-06-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('ACDP 0.2.0 trust hardening (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp({ webhookSecret: SECRET });
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('ingests a 0.2.0 publish event and persists + exposes the trust fields', async () => {
    const ctxId = `acdp://${AUTHORITY}/ctx-receipt-1`;
    const payload = makeEvent({
      ctx_id: ctxId,
      event_id: 'evt-trust-1',
      key_fingerprint: FP,
      registry_receipt: makeReceipt(ctxId),
    });

    const res = await ctx.client.ingest(payload, { runId: 'run-trust-1', secret: SECRET });
    expect(res.status).toBe(204);

    const events = (await ctx.client.listEvents()) as { data: Array<Record<string, unknown>> };
    expect(events.data).toHaveLength(1);
    const row = events.data[0]!;
    expect(row.keyFingerprint).toBe(FP);
    expect(row.receiptPresent).toBe(true);
    // Open-schema regression: the receipt survives verbatim in raw_payload.
    expect((row.rawPayload as Record<string, unknown>).registry_receipt).toEqual(
      makeReceipt(ctxId),
    );
  });

  it('still ingests 0.1.0 events with no trust fields (receipt-less)', async () => {
    const res = await ctx.client.ingest(makeEvent(), { runId: 'run-legacy', secret: SECRET });
    expect(res.status).toBe(204);

    const events = (await ctx.client.listEvents()) as { data: Array<Record<string, unknown>> };
    expect(events.data[0]!.keyFingerprint).toBeNull();
    expect(events.data[0]!.receiptPresent).toBe(false);
  });

  it('renders a did:key-producer run end-to-end without parsing errors', async () => {
    const runId = 'run-didkey-1';
    const c1 = `acdp://${AUTHORITY}/ctx-dk-1`;
    const c2 = `acdp://${AUTHORITY}/ctx-dk-2`;
    await ctx.client.ingest(
      makeEvent({ ctx_id: c1, agent_id: DID_KEY, event_id: 'evt-dk-1' }),
      { runId, secret: SECRET },
    );
    await ctx.client.ingest(
      makeEvent({
        ctx_id: c2,
        agent_id: DID_KEY,
        derived_from: [c1],
        event_id: 'evt-dk-2',
      }),
      { runId, secret: SECRET },
    );

    const run = (await ctx.client.getRun(runId)) as Record<string, unknown>;
    expect(run.runId).toBe(runId);
    expect(run.contextsCount).toBe(2);
    expect(run.trust).toBeNull(); // unaudited

    const agents = (await ctx.client.listAgents()) as { data: Array<Record<string, unknown>> };
    expect(agents.data.map((a) => a.agentDid)).toEqual([DID_KEY]);

    const dag = (await ctx.client.getLineage(runId)) as {
      nodes: Array<{ agentId: string }>;
      edges: Array<{ from: string; to: string }>;
    };
    expect(dag.nodes.map((n) => n.agentId)).toEqual([DID_KEY, DID_KEY]);
    expect(dag.edges).toEqual([{ from: c1, to: c2 }]);
  });

  it('audit sweep produces verdicts that surface on the run trust summary', async () => {
    const runId = 'run-audit-1';
    const ctxId = `acdp://${AUTHORITY}/ctx-audit-1`;
    await ctx.client.ingest(
      makeEvent({
        ctx_id: ctxId,
        event_id: 'evt-audit-1',
        key_fingerprint: FP,
        registry_receipt: makeReceipt(ctxId),
      }),
      { runId, secret: SECRET },
    );

    const auditor = ctx.module.get(ReceiptAuditService);
    const audited = await auditor.sweep();
    expect(audited).toBe(1);
    // A second pass finds nothing new (verdicts are idempotent by event id).
    expect(await auditor.sweep()).toBe(0);

    const run = (await ctx.client.getRun(runId)) as {
      trust: {
        audited: number;
        errors: number;
        flagged: unknown[];
      } | null;
    };
    expect(run.trust).not.toBeNull();
    expect(run.trust!.audited).toBe(1);
    // Structural checks pass; the crypto phase can't reach the (fake)
    // registry → error verdict, and environmental failures are never
    // surfaced as trust flags.
    expect(run.trust!.errors).toBe(1);
    expect(run.trust!.flagged).toEqual([]);
  });

  it('audit sweep flags a receipt that contradicts the event it arrived with', async () => {
    const runId = 'run-audit-2';
    const ctxId = `acdp://${AUTHORITY}/ctx-audit-2`;
    await ctx.client.ingest(
      makeEvent({
        ctx_id: ctxId,
        event_id: 'evt-audit-2',
        key_fingerprint: FP,
        // Receipt claims a different ctx_id AND a foreign registry identity.
        registry_receipt: makeReceipt(`acdp://${AUTHORITY}/SOMETHING-ELSE`, {
          registry_did: 'did:web:evil.example',
        }),
      }),
      { runId, secret: SECRET },
    );

    const auditor = ctx.module.get(ReceiptAuditService);
    await auditor.sweep();

    const run = (await ctx.client.getRun(runId)) as {
      trust: { flagged: Array<{ status: string; discrepancies: string[] }> } | null;
    };
    expect(run.trust!.flagged).toHaveLength(1);
    expect(run.trust!.flagged[0]!.status).toBe('discrepancy');
    const joined = run.trust!.flagged[0]!.discrepancies.join('\n');
    expect(joined).toContain('ctx_id_mismatch');
    expect(joined).toContain('registry_did_mismatch');
  });
});
