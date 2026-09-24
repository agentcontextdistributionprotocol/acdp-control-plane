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
import { eq } from 'drizzle-orm';
import {
  AcdpCanonicalizer,
  AcdpProducer,
  AcdpVerifier,
} from '@agentcontextdistributionprotocol/acdp';
import { DidWebResolverService } from '../../src/auth/did-web/did-web-resolver.service';
import { ReceiptAuditService } from '../../src/audit/receipt-audit.service';
import { RevocationAuditService } from '../../src/audit/revocation-audit.service';
import { AppConfigService } from '../../src/config/app-config.service';
import { SafeFederationClient } from '../../src/contexts/safe-federation-client';
import { DatabaseService } from '../../src/db/database.service';
import { receiptAudits } from '../../src/db/schema';
import { KeyRevocationRepository } from '../../src/storage/key-revocation.repository';
import { ReceiptAuditRepository } from '../../src/storage/receipt-audit.repository';
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

  // ── RFC-ACDP-0014 §7 (Phase 14): consumer classification end-to-end ────
  //
  // publish event (genuinely minted receipt) -> a verified revocation fact
  // naming the producer's fingerprint -> sweep -> GET /runs/:runId surfaces
  // the boundary verdict on `trust`. The revocation FACT itself is seeded
  // directly via KeyRevocationRepository — Phase 12/13's own sweep already
  // covers discovering + verifying a `key-revocation` context end-to-end;
  // this test is about the CONSUMER side §7 adds on top.
  it('classifies a publish signed by an independently-revoked key and surfaces it on the run', async () => {
    const runId = 'run-audit-6';
    const ctxId = `acdp://${AUTHORITY}/${U('51')}`;
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
        event_id: 'evt-audit-6',
        key_fingerprint: producerFp,
        registry_receipt: mintReceiptFor(ctxId, body, producerFp, registryKey),
      }),
      { runId, secret: SECRET },
    );

    // T strictly BEFORE the receipt's verified created_at (RECEIPT_AT) —
    // the publish lands at/after the boundary, so §7 must fail closed.
    const T = '2026-06-01T00:00:00.000Z';
    // An EARLIER, registry-attested revocation over the same fingerprint —
    // §4's earliest-compromised_since fold must pick THIS boundary, and the
    // reported trustClass must be ITS class (registry_attested), not
    // default to producer_signed just because a producer_signed row also
    // exists. Both rows round-trip through the REAL database (Postgres's
    // own timestamptz text rendering, not the RFC3339 they were written
    // with), pinning `classifyKeyRevocation`'s normalization end-to-end —
    // the pure-function unit tests in receipt-audit.service.spec.ts cover
    // the same property with a hand-typed Postgres-format string; this is
    // the real round-trip proof.
    const EARLIER_T = '2026-05-20T00:00:00.000Z';
    const revocationRepo = ctx.module.get(KeyRevocationRepository);
    await revocationRepo.record({
      tenantId: 'default',
      ctxId: `acdp://${AUTHORITY}/${U('49')}`,
      revokedKeyFingerprint: producerFp,
      compromisedSince: EARLIER_T,
      revokedKeyController: producer.agentDid,
      publisher: `did:web:${AUTHORITY}`,
      trustClass: 'registry_attested',
      lineageId: 'lin:sha256:' + 'e'.repeat(64),
      originAuthority: AUTHORITY,
      contextType: 'key-revocation',
    });
    await revocationRepo.record({
      tenantId: 'default',
      ctxId: `acdp://${AUTHORITY}/${U('50')}`,
      revokedKeyFingerprint: producerFp,
      compromisedSince: T,
      revokedKeyController: producer.agentDid,
      publisher: producer.agentDid,
      trustClass: 'producer_signed',
      lineageId: 'lin:sha256:' + 'd'.repeat(64),
      originAuthority: AUTHORITY,
      contextType: 'key-revocation',
    });

    // `KEY_REVOCATION_CHECK_ENABLED` is a boot-time-validated config (it
    // requires RECEIPT_AUDIT_ENABLED, which the harness deliberately leaves
    // off — see test-app.ts — so the sweep is driven directly, not on a
    // timer). Flip the already-booted singleton for this one sweep, the same
    // way the rest of this suite drives ReceiptAuditService.sweep() directly
    // rather than via env + reboot.
    const config = ctx.module.get(AppConfigService) as unknown as {
      keyRevocationCheckEnabled: boolean;
    };
    config.keyRevocationCheckEnabled = true;
    try {
      const { audited } = await sweepWithStubbedNetwork(body, { producer, registryKey });
      expect(audited).toBe(1);
    } finally {
      config.keyRevocationCheckEnabled = false;
    }

    const run = (await ctx.client.getRun(runId)) as {
      trust: {
        verified: number;
        keyRevocationRevokedAtOrAfter: number;
        revoked: Array<{
          eventId: string;
          ctxId: string;
          status: string;
          boundary: string;
          trustClass: string;
          sources: Array<{ ctxId: string; publisher: string }>;
        }>;
      } | null;
    };
    expect(run.trust!.verified).toBe(1); // the receipt itself is honest
    expect(run.trust!.keyRevocationRevokedAtOrAfter).toBe(1);
    expect(run.trust!.revoked).toHaveLength(1);
    const revoked = run.trust!.revoked[0]!;
    expect(revoked.ctxId).toBe(ctxId);
    expect(revoked.status).toBe('revoked_at_or_after');
    // `compromise_boundary` is itself a `timestamp` column (migration 0023),
    // so what comes back is Postgres's own rendering
    // ("2026-05-20 00:00:00+00"), not the RFC3339 EARLIER_T seeded above —
    // compare by parsed instant, matching how every other DB-sourced
    // timestamp field in this API already has to be consumed.
    expect(new Date(revoked.boundary).toISOString()).toBe(EARLIER_T);
    // The EARLIER (registry_attested) row set the boundary — reporting
    // producer_signed here would mean the boundary-equality match silently
    // fell back to "any producer_signed row in the fed set" instead of the
    // row that actually established this boundary.
    expect(revoked.trustClass).toBe('registry_attested');
    expect(revoked.sources).toEqual(
      expect.arrayContaining([
        { ctxId: `acdp://${AUTHORITY}/${U('49')}`, publisher: `did:web:${AUTHORITY}` },
        { ctxId: `acdp://${AUTHORITY}/${U('50')}`, publisher: producer.agentDid },
      ]),
    );
    expect(revoked.sources).toHaveLength(2);
  });

  // ── RFC-ACDP-0014 §7 retroactive re-audit (Phase 15) ────────────────────
  //
  // A revocation whose compromised_since predates already-sealed history
  // must revise those verdicts in place, instead of leaving them reporting
  // `verified` forever. This is inherently multi-row SQL behaviour
  // (ReceiptAuditRepository.findRevocationAmendmentCandidates /
  // .amendKeyRevocation), so — per the plan — it is proven here against a
  // real database, not with mocked repositories.
  describe('RFC-ACDP-0014 §7 retroactive re-audit (Phase 15)', () => {
    async function fetchAuditRowByCtxId(ctxId: string) {
      const database = ctx.module.get(DatabaseService);
      const [row] = await database.db
        .select()
        .from(receiptAudits)
        .where(eq(receiptAudits.ctxId, ctxId));
      return row;
    }

    it(
      'amends already-sealed verified verdicts for a revocation recorded after the fact, ' +
        'touching only the 4 revocation columns (AC1/AC2/AC6)',
      async () => {
        const runId = 'run-audit-7';
        const producer = AcdpProducer.generate(
          'did:web:agent-1.example',
          'did:web:agent-1.example#key-1',
        );
        const registryKey = AcdpProducer.generate(
          `did:web:${AUTHORITY}`,
          `did:web:${AUTHORITY}#receipt-key-1`,
        );
        const producerFp = AcdpVerifier.fingerprintEd25519B64(producer.publicKeyB64);
        const ctxIds = ['70', '71', '72'].map((n) => `acdp://${AUTHORITY}/${U(n)}`);

        // Three publishes, independently audited to `verified`, one sweep
        // per event so each is checked against its OWN genuinely-minted
        // body (sweepWithStubbedNetwork's stub serves one fixed body for
        // whatever it fetches during that one call).
        for (let i = 0; i < ctxIds.length; i++) {
          const ctxId = ctxIds[i]!;
          const body = mintBody(ctxId, producer);
          await ctx.client.ingest(
            makeEvent({
              ctx_id: ctxId,
              lineage_id: LINEAGE_ID,
              event_id: `evt-audit-7${i}`,
              key_fingerprint: producerFp,
              registry_receipt: mintReceiptFor(ctxId, body, producerFp, registryKey),
            }),
            { runId, secret: SECRET },
          );
          const { audited } = await sweepWithStubbedNetwork(body, { producer, registryKey });
          expect(audited).toBe(1);
        }

        const before = await fetchAuditRowByCtxId(ctxIds[0]!);
        expect(before!.status).toBe('verified');
        expect(before!.keyRevocationStatus).toBe('none');

        // T strictly before RECEIPT_AT — every one of the 3 already-sealed
        // receipts now lands at/after the boundary.
        const T = '2026-01-01T00:00:00.000Z';
        const revocationCtxId = `acdp://${AUTHORITY}/${U('69')}`;
        const revocationRepo = ctx.module.get(KeyRevocationRepository);
        await revocationRepo.record({
          tenantId: 'default',
          ctxId: revocationCtxId,
          revokedKeyFingerprint: producerFp,
          compromisedSince: T,
          revokedKeyController: producer.agentDid,
          publisher: producer.agentDid,
          trustClass: 'producer_signed',
          lineageId: 'lin:sha256:' + '7'.repeat(64),
          originAuthority: AUTHORITY,
          contextType: 'key-revocation',
        });

        const config = ctx.module.get(AppConfigService) as unknown as {
          keyRevocationCheckEnabled: boolean;
        };
        config.keyRevocationCheckEnabled = true;
        try {
          await ctx.module.get(RevocationAuditService).sweep();
        } finally {
          config.keyRevocationCheckEnabled = false;
        }

        for (const ctxId of ctxIds) {
          const row = await fetchAuditRowByCtxId(ctxId);
          expect(row!.keyRevocationStatus).toBe('revoked_at_or_after');
          expect(row!.keyRevocationTrustClass).toBe('producer_signed');
          expect(row!.keyRevocationSources).toEqual([
            { ctxId: revocationCtxId, publisher: producer.agentDid },
          ]);
        }

        // Column-scoping (AC2): every field the amendment must never touch
        // is byte-identical to the pre-amendment snapshot.
        const after = await fetchAuditRowByCtxId(ctxIds[0]!);
        expect(after!.status).toBe(before!.status);
        expect(after!.discrepancies).toEqual(before!.discrepancies);
        expect(after!.skewMs).toBe(before!.skewMs);
        expect(after!.receiptCreatedAt).toBe(before!.receiptCreatedAt);
        expect(after!.eventArrivedAt).toBe(before!.eventArrivedAt);
        expect(after!.checkedAt).toBe(before!.checkedAt);
      },
    );

    it(
      'amendKeyRevocation only ever tightens — rejects a loosening, accepts a strictly ' +
        'earlier re-tightening, and is idempotent at its final state (AC3/AC4)',
      async () => {
        const repo = ctx.module.get(ReceiptAuditRepository);
        const eventId = '33333333-3333-4333-8333-333333333333';
        await repo.record({
          eventId,
          tenantId: 'default',
          runId: 'run-mono-1',
          ctxId: 'acdp://mono.example/ctx-1',
          registryAuthority: AUTHORITY,
          status: 'verified',
          discrepancies: [],
          receiptCreatedAt: '2026-06-01T00:00:00.000Z',
          eventArrivedAt: '2026-06-01T00:00:05.000Z',
          skewMs: 5000,
        });

        const first = await repo.amendKeyRevocation('default', eventId, {
          status: 'revoked_at_or_after',
          trustClass: 'producer_signed',
          boundary: '2026-01-01T00:00:00.000Z',
          sources: [{ ctxId: 'acdp://mono.example/rev-1', publisher: 'did:web:agent.example' }],
        });
        expect(first).toBe(true);

        // A LATER (less severe) boundary is a loosening — rejected outright
        // by the WHERE clause, never even applied.
        const loosening = await repo.amendKeyRevocation('default', eventId, {
          status: 'revoked_time_unverifiable',
          trustClass: 'registry_attested',
          boundary: '2026-06-01T00:00:00.000Z',
          sources: [{ ctxId: 'acdp://mono.example/rev-loosen', publisher: 'did:web:other.example' }],
        });
        expect(loosening).toBe(false);

        const afterLoosening = await fetchAuditRowByCtxId('acdp://mono.example/ctx-1');
        expect(afterLoosening!.keyRevocationStatus).toBe('revoked_at_or_after');
        expect(afterLoosening!.keyRevocationTrustClass).toBe('producer_signed');
        expect(new Date(afterLoosening!.compromiseBoundary!).toISOString()).toBe(
          '2026-01-01T00:00:00.000Z',
        );

        // A STRICTLY EARLIER boundary — a SECOND, earlier-dated revocation
        // discovered after the first amendment — is a genuine tightening and
        // MUST be applied, even though the row is no longer 'none' (this is
        // the fix for the verifier's gap: a row amended once is not fenced
        // off from ever being re-tightened by a stricter fact).
        const tighten = await repo.amendKeyRevocation('default', eventId, {
          status: 'revoked_time_unverifiable',
          trustClass: 'registry_attested',
          boundary: '2020-01-01T00:00:00.000Z',
          sources: [{ ctxId: 'acdp://mono.example/rev-tighten', publisher: 'did:web:other.example' }],
        });
        expect(tighten).toBe(true);

        const afterTighten = await fetchAuditRowByCtxId('acdp://mono.example/ctx-1');
        expect(afterTighten!.keyRevocationStatus).toBe('revoked_time_unverifiable');
        expect(afterTighten!.keyRevocationTrustClass).toBe('registry_attested');
        expect(new Date(afterTighten!.compromiseBoundary!).toISOString()).toBe(
          '2020-01-01T00:00:00.000Z',
        );

        // Idempotency: re-issuing the now-current amendment again matches
        // zero rows — the row is already at its final, tightest state.
        const idempotent = await repo.amendKeyRevocation('default', eventId, {
          status: 'revoked_time_unverifiable',
          trustClass: 'registry_attested',
          boundary: '2020-01-01T00:00:00.000Z',
          sources: [{ ctxId: 'acdp://mono.example/rev-tighten', publisher: 'did:web:other.example' }],
        });
        expect(idempotent).toBe(false);
      },
    );

    it(
      'bounds the fan-out per sweep and converges over a subsequent sweep, with no row skipped (AC5)',
      async () => {
        const runId = 'run-audit-8';
        const producer = AcdpProducer.generate(
          'did:web:agent-1.example',
          'did:web:agent-1.example#key-1',
        );
        const registryKey = AcdpProducer.generate(
          `did:web:${AUTHORITY}`,
          `did:web:${AUTHORITY}#receipt-key-1`,
        );
        const producerFp = AcdpVerifier.fingerprintEd25519B64(producer.publicKeyB64);
        const ctxIds = ['80', '81', '82'].map((n) => `acdp://${AUTHORITY}/${U(n)}`);

        for (let i = 0; i < ctxIds.length; i++) {
          const ctxId = ctxIds[i]!;
          const body = mintBody(ctxId, producer);
          await ctx.client.ingest(
            makeEvent({
              ctx_id: ctxId,
              lineage_id: LINEAGE_ID,
              event_id: `evt-audit-8${i}`,
              key_fingerprint: producerFp,
              registry_receipt: mintReceiptFor(ctxId, body, producerFp, registryKey),
            }),
            { runId, secret: SECRET },
          );
          const { audited } = await sweepWithStubbedNetwork(body, { producer, registryKey });
          expect(audited).toBe(1);
        }

        const revocationRepo = ctx.module.get(KeyRevocationRepository);
        await revocationRepo.record({
          tenantId: 'default',
          ctxId: `acdp://${AUTHORITY}/${U('79')}`,
          revokedKeyFingerprint: producerFp,
          compromisedSince: '2026-01-01T00:00:00.000Z',
          revokedKeyController: producer.agentDid,
          publisher: producer.agentDid,
          trustClass: 'producer_signed',
          lineageId: 'lin:sha256:' + '8'.repeat(64),
          originAuthority: AUTHORITY,
          contextType: 'key-revocation',
        });

        const config = ctx.module.get(AppConfigService) as unknown as {
          keyRevocationCheckEnabled: boolean;
          receiptAuditBatchSize: number;
        };
        config.keyRevocationCheckEnabled = true;
        const originalBatchSize = config.receiptAuditBatchSize;
        config.receiptAuditBatchSize = 2; // cap + 1 rows seeded above
        try {
          const revocationAuditor = ctx.module.get(RevocationAuditService);
          await revocationAuditor.sweep();
          const afterFirst = (await ctx.client.getRun(runId)) as {
            trust: { revoked: unknown[] } | null;
          };
          expect(afterFirst.trust!.revoked).toHaveLength(2);

          await revocationAuditor.sweep();
          const afterSecond = (await ctx.client.getRun(runId)) as {
            trust: { revoked: unknown[] } | null;
          };
          expect(afterSecond.trust!.revoked).toHaveLength(3);
        } finally {
          config.keyRevocationCheckEnabled = false;
          config.receiptAuditBatchSize = originalBatchSize;
        }
      },
    );

    it(
      'a SECOND, earlier-dated revocation re-tightens an already-amended row end to end, ' +
        'through the real sweep (not just the repository WHERE clause)',
      async () => {
        const runId = 'run-audit-10';
        const producer = AcdpProducer.generate(
          'did:web:agent-1.example',
          'did:web:agent-1.example#key-1',
        );
        const registryKey = AcdpProducer.generate(
          `did:web:${AUTHORITY}`,
          `did:web:${AUTHORITY}#receipt-key-1`,
        );
        const producerFp = AcdpVerifier.fingerprintEd25519B64(producer.publicKeyB64);
        const ctxId = `acdp://${AUTHORITY}/${U('91')}`;
        const body = mintBody(ctxId, producer);
        await ctx.client.ingest(
          makeEvent({
            ctx_id: ctxId,
            lineage_id: LINEAGE_ID,
            event_id: 'evt-audit-91',
            key_fingerprint: producerFp,
            registry_receipt: mintReceiptFor(ctxId, body, producerFp, registryKey),
          }),
          { runId, secret: SECRET },
        );
        const { audited } = await sweepWithStubbedNetwork(body, { producer, registryKey });
        expect(audited).toBe(1);

        const revocationRepo = ctx.module.get(KeyRevocationRepository);
        const config = ctx.module.get(AppConfigService) as unknown as {
          keyRevocationCheckEnabled: boolean;
        };
        const revocationAuditor = ctx.module.get(RevocationAuditService);
        config.keyRevocationCheckEnabled = true;
        try {
          const T1 = '2026-03-01T00:00:00.000Z'; // before RECEIPT_AT
          const rev1CtxId = `acdp://${AUTHORITY}/${U('92')}`;
          await revocationRepo.record({
            tenantId: 'default',
            ctxId: rev1CtxId,
            revokedKeyFingerprint: producerFp,
            compromisedSince: T1,
            revokedKeyController: producer.agentDid,
            publisher: producer.agentDid,
            trustClass: 'producer_signed',
            lineageId: 'lin:sha256:' + 'a'.repeat(64),
            originAuthority: AUTHORITY,
            contextType: 'key-revocation',
          });
          await revocationAuditor.sweep();

          const afterFirst = await fetchAuditRowByCtxId(ctxId);
          expect(afterFirst!.keyRevocationStatus).toBe('revoked_at_or_after');
          expect(new Date(afterFirst!.compromiseBoundary!).toISOString()).toBe(T1);
          expect(afterFirst!.keyRevocationSources).toEqual([
            { ctxId: rev1CtxId, publisher: producer.agentDid },
          ]);

          // A SECOND, independent revocation for the SAME fingerprint,
          // discovered later, dated strictly earlier than the first — must
          // tighten the row the first revocation already amended, not skip
          // it as already-handled.
          const T2 = '2026-01-01T00:00:00.000Z'; // strictly before T1
          const rev2CtxId = `acdp://${AUTHORITY}/${U('93')}`;
          await revocationRepo.record({
            tenantId: 'default',
            ctxId: rev2CtxId,
            revokedKeyFingerprint: producerFp,
            compromisedSince: T2,
            revokedKeyController: producer.agentDid,
            publisher: producer.agentDid,
            trustClass: 'producer_signed',
            lineageId: 'lin:sha256:' + 'b'.repeat(64),
            originAuthority: AUTHORITY,
            contextType: 'key-revocation',
          });
          await revocationAuditor.sweep();

          const afterSecond = await fetchAuditRowByCtxId(ctxId);
          expect(afterSecond!.keyRevocationStatus).toBe('revoked_at_or_after');
          expect(new Date(afterSecond!.compromiseBoundary!).toISOString()).toBe(T2);
          expect(afterSecond!.keyRevocationSources).toEqual(
            expect.arrayContaining([
              { ctxId: rev1CtxId, publisher: producer.agentDid },
              { ctxId: rev2CtxId, publisher: producer.agentDid },
            ]),
          );
          expect(afterSecond!.keyRevocationSources).toHaveLength(2);
        } finally {
          config.keyRevocationCheckEnabled = false;
        }
      },
    );

    it(
      'reaches a receipt_audits row whose checked_at is far outside RECEIPT_AUDIT_LOOKBACK_HOURS — ' +
        'findRevocationAmendmentCandidates carries no recency filter of its own',
      async () => {
        const runId = 'run-audit-11';
        const producer = AcdpProducer.generate(
          'did:web:agent-1.example',
          'did:web:agent-1.example#key-1',
        );
        const registryKey = AcdpProducer.generate(
          `did:web:${AUTHORITY}`,
          `did:web:${AUTHORITY}#receipt-key-1`,
        );
        const producerFp = AcdpVerifier.fingerprintEd25519B64(producer.publicKeyB64);
        const ctxId = `acdp://${AUTHORITY}/${U('94')}`;
        const body = mintBody(ctxId, producer);
        await ctx.client.ingest(
          makeEvent({
            ctx_id: ctxId,
            lineage_id: LINEAGE_ID,
            event_id: 'evt-audit-94',
            key_fingerprint: producerFp,
            registry_receipt: mintReceiptFor(ctxId, body, producerFp, registryKey),
          }),
          { runId, secret: SECRET },
        );
        const { audited } = await sweepWithStubbedNetwork(body, { producer, registryKey });
        expect(audited).toBe(1);

        const sealed = await fetchAuditRowByCtxId(ctxId);
        expect(sealed!.status).toBe('verified');

        // Push checked_at/event_arrived_at far outside the default 24h
        // RECEIPT_AUDIT_LOOKBACK_HOURS — this row would never reach a NORMAL
        // audit sweep again regardless (findUnauditedPublishes excludes
        // already-audited rows outright), so the point being proven is that
        // Phase 15's OWN candidate query has no independent recency filter
        // that would otherwise (re-)exclude a row this old.
        const ancientIso = new Date(Date.now() - 1000 * 3600 * 1000).toISOString();
        const database = ctx.module.get(DatabaseService);
        await database.db
          .update(receiptAudits)
          .set({ checkedAt: ancientIso, eventArrivedAt: ancientIso })
          .where(eq(receiptAudits.eventId, sealed!.eventId));

        const T = '2026-01-01T00:00:00.000Z'; // strictly before RECEIPT_AT
        const revocationRepo = ctx.module.get(KeyRevocationRepository);
        await revocationRepo.record({
          tenantId: 'default',
          ctxId: `acdp://${AUTHORITY}/${U('95')}`,
          revokedKeyFingerprint: producerFp,
          compromisedSince: T,
          revokedKeyController: producer.agentDid,
          publisher: producer.agentDid,
          trustClass: 'producer_signed',
          lineageId: 'lin:sha256:' + 'c'.repeat(64),
          originAuthority: AUTHORITY,
          contextType: 'key-revocation',
        });

        const config = ctx.module.get(AppConfigService) as unknown as {
          keyRevocationCheckEnabled: boolean;
        };
        config.keyRevocationCheckEnabled = true;
        try {
          await ctx.module.get(RevocationAuditService).sweep();
        } finally {
          config.keyRevocationCheckEnabled = false;
        }

        const amended = await fetchAuditRowByCtxId(ctxId);
        expect(amended!.keyRevocationStatus).toBe('revoked_at_or_after');
      },
    );
  });
});
