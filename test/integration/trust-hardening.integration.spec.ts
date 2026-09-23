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
 *      real host, so by default the crypto phase ends at the federation
 *      fetch with an `error` verdict; the last two cases stub ONLY the two
 *      network edges (the SSRF-gated fetch and DID resolution) so a receipt
 *      genuinely minted against the pinned `acdp` binding runs the whole
 *      pipeline through the real `verifyReceipt` and lands as `verified`.
 *      The SDK-level positives and negatives live in
 *      src/audit/receipt-verify.spec.ts, and the orchestration in
 *      src/audit/receipt-audit.service.crypto.spec.ts.
 *
 * ctx_ids here are CANONICAL (`acdp://<lowercase DNS authority>/<lowercase v4
 * UUID>`) because the SDK parses `expectedCtxId` with `CtxId::parse`; the
 * audit pre-checks the same grammar and reports a non-canonical stored id as
 * an `unverified:` note, which the last case pins.
 */
import {
  AcdpCanonicalizer,
  AcdpProducer,
  AcdpVerifier,
} from '@agentcontextdistributionprotocol/acdp';
import { DidWebResolverService } from '../../src/auth/did-web/did-web-resolver.service';
import { ReceiptAuditService } from '../../src/audit/receipt-audit.service';
import { SafeFederationClient } from '../../src/contexts/safe-federation-client';
import { createTestApp, TestAppContext } from '../helpers/test-app';

const SECRET = 'integration-test-secret';
const AUTHORITY = 'registry-a.example';
const FP = 'sha256:' + 'b'.repeat(64);
const DID_KEY = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
/** Canonical ctx_id ids — lowercase v4 UUIDs, one per fixture. */
const U = (n: string) => `abcdef01-2345-4678-9abc-def0123456${n}`;

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
    ctx_id: `acdp://${AUTHORITY}/${U('01')}`,
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
    const ctxId = `acdp://${AUTHORITY}/${U('10')}`;
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
    const c1 = `acdp://${AUTHORITY}/${U('21')}`;
    const c2 = `acdp://${AUTHORITY}/${U('22')}`;
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
    const ctxId = `acdp://${AUTHORITY}/${U('31')}`;
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
    const ctxId = `acdp://${AUTHORITY}/${U('32')}`;
    await ctx.client.ingest(
      makeEvent({
        ctx_id: ctxId,
        event_id: 'evt-audit-2',
        key_fingerprint: FP,
        // Receipt claims a different ctx_id AND a foreign registry identity.
        registry_receipt: makeReceipt(`acdp://${AUTHORITY}/${U('99')}`, {
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

  // ── Full crypto path against the pinned SDK ────────────────────────────
  //
  // Everything below stubs exactly two things — the SSRF-gated retrieval and
  // did:web resolution — because neither can reach a real host from CI. The
  // receipt itself is genuinely minted and genuinely verified by the pinned
  // `acdp` binding's `verifyReceipt`, including its §8 step 3 body bindings.

  const LINEAGE_ID = 'lin:sha256:' + 'c'.repeat(64);
  const RECEIPT_AT = '2026-06-12T00:00:00.000Z';

  /** A retrieval `Body` whose `content_hash` is the SDK's own §5.7 digest. */
  function mintBody(ctxId: string, producer: AcdpProducer): Record<string, unknown> {
    const base: Record<string, unknown> = {
      ctx_id: ctxId,
      lineage_id: LINEAGE_ID,
      origin_registry: AUTHORITY,
      created_at: RECEIPT_AT,
      version: 1,
      agent_id: producer.agentDid,
      contributors: [],
      title: 'integration receipt fixture',
      type: 'analysis',
      data_refs: [],
      derived_from: [],
      visibility: 'public',
      signature: { algorithm: 'ed25519', key_id: producer.keyId, value: 'AAA' },
    };
    return {
      ...base,
      content_hash: AcdpCanonicalizer.contentHash(
        AcdpVerifier.canonicalPreimage(JSON.stringify(base)),
      ),
    };
  }

  /** The registry receipt a conformant 0.2.0 registry would mint for it. */
  function mintReceiptFor(
    ctxId: string,
    body: Record<string, unknown>,
    producerFp: string,
    registryKey: AcdpProducer,
  ): Record<string, unknown> {
    const unsigned: Record<string, unknown> = {
      registry_did: `did:web:${AUTHORITY}`,
      ctx_id: ctxId,
      lineage_id: LINEAGE_ID,
      origin_registry: AUTHORITY,
      created_at: RECEIPT_AT,
      content_hash: body.content_hash,
      key_fingerprint: producerFp,
    };
    return {
      ...unsigned,
      signature: {
        algorithm: 'ed25519',
        key_id: `did:web:${AUTHORITY}#receipt-key-1`,
        value: registryKey.signChallenge(
          AcdpCanonicalizer.contentHash(JSON.stringify(unsigned)),
        ),
      },
    };
  }

  /**
   * Replace the two network edges for one sweep. Returns the federation spy
   * so a test can assert it was (or was not) reached.
   */
  async function sweepWithStubbedNetwork(
    served: Record<string, unknown> | null,
    keys: { producer: AcdpProducer; registryKey: AcdpProducer },
  ): Promise<{ audited: number; fetches: number }> {
    const fed = jest
      .spyOn(ctx.module.get(SafeFederationClient), 'get')
      .mockResolvedValue({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ body: served }),
      });
    const resolver = ctx.module.get(DidWebResolverService);
    const resolveKey = jest.spyOn(resolver, 'resolveKey').mockResolvedValue({
      keyId: keys.producer.keyId,
      algorithm: 'ed25519',
      publicKeyB64: keys.producer.publicKeyB64,
    });
    const resolveReceiptKey = jest
      .spyOn(resolver, 'resolveReceiptKey')
      .mockResolvedValue({
        keyId: `did:web:${AUTHORITY}#receipt-key-1`,
        algorithm: 'ed25519',
        publicKeyB64: keys.registryKey.publicKeyB64,
        historical: false,
      });
    try {
      const audited = await ctx.module.get(ReceiptAuditService).sweep();
      return { audited, fetches: fed.mock.calls.length };
    } finally {
      fed.mockRestore();
      resolveKey.mockRestore();
      resolveReceiptKey.mockRestore();
    }
  }

  it('verifies a genuinely minted receipt end-to-end against the pinned SDK', async () => {
    const runId = 'run-audit-3';
    const ctxId = `acdp://${AUTHORITY}/${U('41')}`;
    const producer = AcdpProducer.generate(
      'did:web:agent-1.example',
      'did:web:agent-1.example#key-1',
    );
    const registryKey = AcdpProducer.generate(
      `did:web:${AUTHORITY}`,
      `did:web:${AUTHORITY}#receipt-key-1`,
    );
    const producerFp = AcdpVerifier.fingerprintEd25519B64(producer.publicKeyB64);
    const body = mintBody(ctxId, producer);

    await ctx.client.ingest(
      makeEvent({
        ctx_id: ctxId,
        lineage_id: LINEAGE_ID,
        event_id: 'evt-audit-3',
        key_fingerprint: producerFp,
        registry_receipt: mintReceiptFor(ctxId, body, producerFp, registryKey),
      }),
      { runId, secret: SECRET },
    );

    const { audited } = await sweepWithStubbedNetwork(body, { producer, registryKey });
    expect(audited).toBe(1);

    const run = (await ctx.client.getRun(runId)) as {
      trust: { verified: number; errors: number; flagged: unknown[] } | null;
    };
    expect(run.trust!.verified).toBe(1);
    expect(run.trust!.errors).toBe(0);
    expect(run.trust!.flagged).toEqual([]);
  });

  it('flags a registry that serves a body disagreeing with its own receipt (§8 step 3)', async () => {
    const runId = 'run-audit-4';
    const ctxId = `acdp://${AUTHORITY}/${U('42')}`;
    const producer = AcdpProducer.generate(
      'did:web:agent-1.example',
      'did:web:agent-1.example#key-1',
    );
    const registryKey = AcdpProducer.generate(
      `did:web:${AUTHORITY}`,
      `did:web:${AUTHORITY}#receipt-key-1`,
    );
    const producerFp = AcdpVerifier.fingerprintEd25519B64(producer.publicKeyB64);
    const body = mintBody(ctxId, producer);
    // The receipt is internally valid and correctly signed — but the body the
    // registry actually serves carries a different created_at. Only the new
    // §8 step 3 bindings catch this, and it IS dishonesty.
    const served = { ...body, created_at: '2026-06-13T00:00:00.000Z' };

    await ctx.client.ingest(
      makeEvent({
        ctx_id: ctxId,
        lineage_id: LINEAGE_ID,
        event_id: 'evt-audit-4',
        key_fingerprint: producerFp,
        registry_receipt: mintReceiptFor(ctxId, body, producerFp, registryKey),
      }),
      { runId, secret: SECRET },
    );

    await sweepWithStubbedNetwork(served, { producer, registryKey });

    const run = (await ctx.client.getRun(runId)) as {
      trust: { flagged: Array<{ status: string; discrepancies: string[] }> } | null;
    };
    expect(run.trust!.flagged).toHaveLength(1);
    expect(run.trust!.flagged[0]!.status).toBe('discrepancy');
    expect(run.trust!.flagged[0]!.discrepancies.join('\n')).toContain('receipt_invalid:');
  });

  it('reports a non-canonical stored ctx_id as unverified, never as a trust flag', async () => {
    const runId = 'run-audit-5';
    const ctxId = `acdp://${AUTHORITY}/ctx-legacy-1`; // pre-canonical opaque id
    const producer = AcdpProducer.generate(
      'did:web:agent-1.example',
      'did:web:agent-1.example#key-1',
    );
    const registryKey = AcdpProducer.generate(
      `did:web:${AUTHORITY}`,
      `did:web:${AUTHORITY}#receipt-key-1`,
    );
    const producerFp = AcdpVerifier.fingerprintEd25519B64(producer.publicKeyB64);
    const body = mintBody(ctxId, producer);

    await ctx.client.ingest(
      makeEvent({
        ctx_id: ctxId,
        lineage_id: LINEAGE_ID,
        event_id: 'evt-audit-5',
        key_fingerprint: producerFp,
        registry_receipt: mintReceiptFor(ctxId, body, producerFp, registryKey),
      }),
      { runId, secret: SECRET },
    );

    // The retrieval is stubbed to SUCCEED, so an `error` verdict here can
    // only have come from the host's ctx_id pre-check.
    const { fetches } = await sweepWithStubbedNetwork(body, { producer, registryKey });
    expect(fetches).toBe(0);

    const run = (await ctx.client.getRun(runId)) as {
      trust: { errors: number; verified: number; flagged: unknown[] } | null;
    };
    expect(run.trust!.errors).toBe(1);
    expect(run.trust!.verified).toBe(0);
    expect(run.trust!.flagged).toEqual([]);
  });
});
