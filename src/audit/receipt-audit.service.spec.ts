/**
 * Structural verdicts of the receipt-audit sweep — the checks that run even
 * when the installed `acdp` SDK predates the receipt API. The SDK wrapper is
 * mocked as "no receipt support" so these tests are deterministic across
 * dependency versions; the crypto path is covered in
 * receipt-audit.service.crypto.spec.ts.
 */
jest.mock('./receipt-verify', () => ({
  ...jest.requireActual<typeof import('./receipt-verify')>('./receipt-verify'),
  sdkSupportsReceipts: jest.fn().mockReturnValue(false),
  verifyContentHash: jest.fn(),
  verifyReceipt: jest.fn(),
  fingerprintEd25519B64: jest.fn(),
  verifyBodyOffline: jest.fn(),
  explainHashMismatch: jest.fn().mockReturnValue(null),
}));

import { classifyKeyRevocation } from './receipt-audit.service';
import { ReceiptAuditService } from './receipt-audit.service';
import { ContextEvent, KeyRevocation } from '../db/schema';

const FP = 'sha256:' + 'b'.repeat(64);
const AUTHORITY = 'reg.example';
const CTX = 'acdp://reg.example/abcdef01-2345-4678-9abc-def012345678';

function makeReceipt(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    registry_did: `did:web:${AUTHORITY}`,
    ctx_id: CTX,
    lineage_id: 'lin-1',
    origin_registry: AUTHORITY,
    created_at: '2026-01-01T00:00:00.000Z',
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

function makeEvent(overrides: Partial<ContextEvent> = {}): ContextEvent {
  const receipt = makeReceipt();
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: 'default',
    eventType: 'context_published',
    eventTs: '2026-01-01T00:00:00.000Z',
    runId: 'run-1',
    ctxId: CTX,
    lineageId: 'lin-1',
    agentId: 'did:web:agent.example',
    contextType: 'analysis',
    visibility: 'public',
    version: 1,
    derivedFrom: [],
    registryAuthority: AUTHORITY,
    scenarioId: null,
    fingerprint: 'evt:x',
    keyFingerprint: FP,
    receiptPresent: true,
    rawPayload: { type: 'context_published', registry_receipt: receipt },
    createdAt: '2026-01-01T00:00:05.000Z',
    ...overrides,
  } as ContextEvent;
}

describe('ReceiptAuditService (structural checks, pre-receipt SDK)', () => {
  let config: any;
  let database: any;
  let auditRepo: any;
  let registryRepo: any;
  let profiles: any;
  let federationClient: any;
  let didResolver: any;
  let instrumentation: any;
  let keyRevocationRepo: any;
  let svc: ReceiptAuditService;

  beforeEach(() => {
    config = {
      receiptAuditEnabled: true,
      receiptAuditIntervalSeconds: 300,
      receiptAuditBatchSize: 50,
      receiptAuditLookbackHours: 24,
      keyRevocationCheckEnabled: false,
      keyRevocationIgnoreFingerprints: [],
      keyRevocationAttestedScope: 'same_registry',
    };
    database = {
      tryAdvisoryLock: jest.fn().mockResolvedValue(true),
      advisoryUnlock: jest.fn().mockResolvedValue(undefined),
    };
    auditRepo = {
      findUnauditedPublishes: jest.fn().mockResolvedValue([]),
      record: jest.fn().mockResolvedValue({}),
      findRevocationAmendmentCandidates: jest.fn().mockResolvedValue([]),
      amendKeyRevocation: jest.fn().mockResolvedValue(true),
    };
    registryRepo = { findByAuthority: jest.fn().mockResolvedValue(null) };
    profiles = { advertisesReceipts: jest.fn().mockResolvedValue(null) };
    federationClient = { get: jest.fn() };
    didResolver = { resolveKey: jest.fn() };
    instrumentation = {
      receiptAuditsTotal: { inc: jest.fn() },
      receiptAuditKeyRevocationsTotal: { inc: jest.fn() },
      receiptAuditRevocationReauditsTotal: { inc: jest.fn() },
    };
    keyRevocationRepo = { findByFingerprint: jest.fn().mockResolvedValue([]) };
    svc = new ReceiptAuditService(
      config,
      database,
      auditRepo,
      registryRepo,
      profiles,
      federationClient,
      didResolver,
      instrumentation,
      keyRevocationRepo,
    );
  });

  it('passes a clean receipt as `structural` when crypto is unavailable', async () => {
    const verdict = await svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('structural');
    expect(verdict.discrepancies).toEqual([]);
    expect(verdict.receiptCreatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(verdict.skewMs).toBe(5000); // arrived 5s after the claimed mint
  });

  it('flags a missing receipt when the registry advertises acdp-registry-receipts', async () => {
    profiles.advertisesReceipts.mockResolvedValue(true);
    const ev = makeEvent({
      receiptPresent: false,
      rawPayload: { type: 'context_published' },
    });
    const verdict = await svc.auditEvent(ev);
    expect(verdict.status).toBe('discrepancy');
    expect(verdict.discrepancies[0]).toContain('missing_receipt');
    expect(profiles.advertisesReceipts).toHaveBeenCalledWith(AUTHORITY, 'default');
  });

  it('treats a missing receipt as informational when the profile is absent or unknown', async () => {
    const ev = makeEvent({
      receiptPresent: false,
      rawPayload: { type: 'context_published' },
    });
    profiles.advertisesReceipts.mockResolvedValue(false);
    expect((await svc.auditEvent(ev)).status).toBe('no_receipt');
    profiles.advertisesReceipts.mockResolvedValue(null); // probe failed — never flag on a guess
    expect((await svc.auditEvent(ev)).status).toBe('no_receipt');
  });

  it('flags receipt fields that disagree with the event (ctx_id / fingerprint / origin)', async () => {
    const ev = makeEvent({
      rawPayload: {
        type: 'context_published',
        registry_receipt: makeReceipt({
          ctx_id: 'acdp://reg.example/OTHER',
          key_fingerprint: 'sha256:' + 'f'.repeat(64),
          origin_registry: 'evil.example',
        }),
      },
    });
    const verdict = await svc.auditEvent(ev);
    expect(verdict.status).toBe('discrepancy');
    const joined = verdict.discrepancies.join('\n');
    expect(joined).toContain('ctx_id_mismatch');
    expect(joined).toContain('key_fingerprint_mismatch');
    expect(joined).toContain('origin_registry_mismatch');
  });

  it('flags a receipt claiming a foreign registry identity', async () => {
    const ev = makeEvent({
      rawPayload: {
        type: 'context_published',
        registry_receipt: makeReceipt({ registry_did: 'did:web:evil.example' }),
      },
    });
    const verdict = await svc.auditEvent(ev);
    expect(verdict.status).toBe('discrepancy');
    expect(verdict.discrepancies.join('\n')).toContain('registry_did_mismatch');
  });

  // ── B10: the canonical `authority → did:web` encoding ──────────────────
  //
  // `:` is a structural delimiter in did:web, so a `host:port` authority is
  // `did:web:host%3Aport`. A conformant registry reachable at localhost:8443
  // mints `registry_did: "did:web:localhost%3A8443"`; the naive
  // `did:web:localhost:8443` this service used to build flagged it as
  // dishonest on every sweep.
  it('B10: accepts the CANONICAL did:web of a port-bearing authority (no mismatch flag)', async () => {
    const ev = makeEvent({
      registryAuthority: 'localhost:8443',
      rawPayload: {
        type: 'context_published',
        registry_receipt: makeReceipt({
          registry_did: 'did:web:localhost%3A8443',
          origin_registry: 'localhost:8443',
          signature: {
            algorithm: 'ed25519',
            key_id: 'did:web:localhost%3A8443#receipt-key-1',
            value: 'c2ln',
          },
        }),
      },
    });
    const verdict = await svc.auditEvent(ev);
    expect(verdict.discrepancies.join('\n')).not.toContain('registry_did_mismatch');
    expect(verdict.status).toBe('structural');
  });

  it('B10: still flags a GENUINELY foreign DID on a port-bearing authority', async () => {
    // The fix must not disable the source-authority binding it corrects.
    const ev = makeEvent({
      registryAuthority: 'localhost:8443',
      rawPayload: {
        type: 'context_published',
        registry_receipt: makeReceipt({
          registry_did: 'did:web:evil.example',
          origin_registry: 'localhost:8443',
        }),
      },
    });
    const verdict = await svc.auditEvent(ev);
    expect(verdict.status).toBe('discrepancy');
    expect(verdict.discrepancies.join('\n')).toContain(
      "registry_did_mismatch: receipt 'did:web:evil.example' != 'did:web:localhost%3A8443'",
    );
  });

  it('B10: an already-percent-encoded stored authority is an `unverified` note, never a flag', async () => {
    const ev = makeEvent({
      registryAuthority: 'localhost%3A8443',
      rawPayload: {
        type: 'context_published',
        registry_receipt: makeReceipt({
          registry_did: 'did:web:localhost%3A8443',
          origin_registry: 'localhost%3A8443',
        }),
      },
    });
    const verdict = await svc.auditEvent(ev);
    // `error`, not `discrepancy`: a data-entry error in OUR row is not
    // evidence against the registry.
    expect(verdict.status).toBe('error');
    const joined = verdict.discrepancies.join('\n');
    expect(joined).not.toContain('registry_did_mismatch');
    expect(joined).toContain('unverified:');
    expect(joined).toContain('percent-encoded already');
  });

  it('flags a receipt minted AFTER the control plane observed the event', async () => {
    const ev = makeEvent({
      rawPayload: {
        type: 'context_published',
        // Claimed mint is 1h after our arrival — beyond clock-skew tolerance.
        registry_receipt: makeReceipt({ created_at: '2026-01-01T01:00:05.000Z' }),
      },
    });
    const verdict = await svc.auditEvent(ev);
    expect(verdict.status).toBe('discrepancy');
    expect(verdict.discrepancies.join('\n')).toContain('created_at_after_observation');
    expect(verdict.skewMs).toBeLessThan(0);
  });

  it('audits a did:key producer event without parsing the DID', async () => {
    const didKey = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    const verdict = await svc.auditEvent(makeEvent({ agentId: didKey }));
    expect(verdict.status).toBe('structural');
  });

  it('never throws — a crashing audit becomes an error verdict', async () => {
    profiles.advertisesReceipts.mockRejectedValue(new Error('boom'));
    const ev = makeEvent({
      receiptPresent: false,
      rawPayload: { type: 'context_published' },
    });
    const verdict = await svc.auditEvent(ev);
    expect(verdict.status).toBe('error');
    expect(verdict.discrepancies[0]).toContain('audit crashed');
  });

  // ── AC5: the ev.keyFingerprint fallback for no-receipt-verified paths ──
  //
  // `producerFp` is null on every path in THIS file (the SDK is mocked as
  // receipt-unavailable, so `verifyCryptographically` always returns
  // `notRun()` before resolving one) — exactly the situation
  // `withRevocationClassification` falls back to `ev.keyFingerprint` for.
  // Verified by a fresh-Opus review to have ZERO prior coverage: deleting
  // the `?? ev.keyFingerprint` fallback entirely left the whole audit suite
  // green with no other test catching it.
  describe('AC5: ev.keyFingerprint fallback classifies revocations with no verified receipt', () => {
    beforeEach(() => {
      config.keyRevocationCheckEnabled = true;
    });

    it('a no_receipt event whose registry-supplied key_fingerprint names a revoked key fails closed', async () => {
      profiles.advertisesReceipts.mockResolvedValue(false);
      keyRevocationRepo.findByFingerprint.mockResolvedValue([
        {
          tenantId: 'default',
          ctxId: 'acdp://reg.example/aaaaaaaa-1111-4111-8111-111111111111',
          revokedKeyFingerprint: FP,
          compromisedSince: '2026-01-01T00:00:00.000Z',
          revokedKeyController: 'did:web:agent.example',
          publisher: 'did:web:agent.example',
          trustClass: 'producer_signed',
          revokedKeyId: null,
          reason: null,
          lineageId: 'lin-rev-1',
          originAuthority: AUTHORITY,
          contextType: 'key-revocation',
          verifiedAt: '2026-01-01T00:00:01.000Z',
        },
      ]);
      const ev = makeEvent({ receiptPresent: false, rawPayload: { type: 'context_published' } });
      const verdict = await svc.auditEvent(ev);
      expect(verdict.status).toBe('no_receipt');
      expect(verdict.keyRevocationStatus).toBe('revoked_time_unverifiable');
      expect(verdict.keyRevocationStatus).not.toBe('none');
      expect(keyRevocationRepo.findByFingerprint).toHaveBeenCalledWith(FP, 'default');
    });

    it('a missing_receipt discrepancy event still classifies via the same fallback', async () => {
      profiles.advertisesReceipts.mockResolvedValue(true); // registry advertises receipts -> flag
      keyRevocationRepo.findByFingerprint.mockResolvedValue([
        {
          tenantId: 'default',
          ctxId: 'acdp://reg.example/aaaaaaaa-1111-4111-8111-111111111111',
          revokedKeyFingerprint: FP,
          compromisedSince: '2026-01-01T00:00:00.000Z',
          revokedKeyController: 'did:web:agent.example',
          publisher: 'did:web:agent.example',
          trustClass: 'producer_signed',
          revokedKeyId: null,
          reason: null,
          lineageId: 'lin-rev-1',
          originAuthority: AUTHORITY,
          contextType: 'key-revocation',
          verifiedAt: '2026-01-01T00:00:01.000Z',
        },
      ]);
      const ev = makeEvent({ receiptPresent: false, rawPayload: { type: 'context_published' } });
      const verdict = await svc.auditEvent(ev);
      expect(verdict.status).toBe('discrepancy'); // registry dishonesty, independent axis
      expect(verdict.keyRevocationStatus).toBe('revoked_time_unverifiable');
    });

    it('an event with no key_fingerprint at all and no producerFp classifies none, not a crash', async () => {
      profiles.advertisesReceipts.mockResolvedValue(false);
      const ev = makeEvent({
        keyFingerprint: null,
        receiptPresent: false,
        rawPayload: { type: 'context_published' },
      });
      const verdict = await svc.auditEvent(ev);
      expect(verdict.status).toBe('no_receipt');
      expect(verdict.keyRevocationStatus).toBe('none');
      expect(keyRevocationRepo.findByFingerprint).not.toHaveBeenCalled();
    });
  });

  describe('sweep', () => {
    it('records a verdict per unaudited publish and counts it', async () => {
      auditRepo.findUnauditedPublishes.mockResolvedValue([makeEvent()]);
      const n = await svc.sweep();
      expect(n).toBe(1);
      expect(auditRepo.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: '11111111-1111-4111-8111-111111111111',
          runId: 'run-1',
          status: 'structural',
          eventArrivedAt: '2026-01-01T00:00:05.000Z',
        }),
      );
      expect(instrumentation.receiptAuditsTotal.inc).toHaveBeenCalledWith({
        status: 'structural',
      });
      expect(database.advisoryUnlock).toHaveBeenCalled();
    });

    it('skips the pass when another instance holds the advisory lock', async () => {
      database.tryAdvisoryLock.mockResolvedValue(false);
      const n = await svc.sweep();
      expect(n).toBe(0);
      expect(auditRepo.findUnauditedPublishes).not.toHaveBeenCalled();
    });
  });

  // ── RFC-ACDP-0014 §7 retroactive re-audit (Phase 15) ─────────────────────
  describe('reauditForFingerprint', () => {
    const T_EARLY = '2026-01-01T00:00:00.000Z';
    const RECEIPT_AT = '2026-06-01T00:00:00.000Z'; // after T_EARLY → fails closed

    function revocation(overrides: Partial<KeyRevocation> = {}): KeyRevocation {
      return {
        tenantId: 'default',
        ctxId: 'acdp://reg.example/rev-1',
        revokedKeyFingerprint: FP,
        compromisedSince: T_EARLY,
        revokedKeyController: 'did:web:agent.example',
        publisher: 'did:web:agent.example',
        trustClass: 'producer_signed',
        revokedKeyId: null,
        reason: null,
        lineageId: 'lin-rev-1',
        originAuthority: AUTHORITY,
        contextType: 'key-revocation',
        verifiedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
      } as KeyRevocation;
    }

    it('does nothing when KEY_REVOCATION_CHECK_ENABLED is off (AC7)', async () => {
      config.keyRevocationCheckEnabled = false;
      const n = await svc.reauditForFingerprint('default', FP);
      expect(n).toBe(0);
      expect(keyRevocationRepo.findByFingerprint).not.toHaveBeenCalled();
      expect(auditRepo.findRevocationAmendmentCandidates).not.toHaveBeenCalled();
    });

    it('does nothing for an ignore-listed fingerprint', async () => {
      config.keyRevocationCheckEnabled = true;
      config.keyRevocationIgnoreFingerprints = [FP];
      const n = await svc.reauditForFingerprint('default', FP);
      expect(n).toBe(0);
      expect(keyRevocationRepo.findByFingerprint).not.toHaveBeenCalled();
      expect(auditRepo.findRevocationAmendmentCandidates).not.toHaveBeenCalled();
    });

    it('does nothing when this fingerprint has no verified facts at all', async () => {
      config.keyRevocationCheckEnabled = true;
      keyRevocationRepo.findByFingerprint.mockResolvedValue([]);
      const n = await svc.reauditForFingerprint('default', FP);
      expect(n).toBe(0);
      expect(auditRepo.findRevocationAmendmentCandidates).not.toHaveBeenCalled();
    });

    it('does nothing when there are no candidate rows', async () => {
      config.keyRevocationCheckEnabled = true;
      keyRevocationRepo.findByFingerprint.mockResolvedValue([revocation()]);
      auditRepo.findRevocationAmendmentCandidates.mockResolvedValue([]);
      const n = await svc.reauditForFingerprint('default', FP);
      expect(n).toBe(0);
      expect(auditRepo.amendKeyRevocation).not.toHaveBeenCalled();
    });

    it('computes globalMinBoundaryIso as the min compromisedSince across the full fact set, normalized', async () => {
      config.keyRevocationCheckEnabled = true;
      keyRevocationRepo.findByFingerprint.mockResolvedValue([
        revocation({ ctxId: 'acdp://reg.example/rev-late', compromisedSince: '2026-03-01T00:00:00.000Z' }),
        // Postgres-rendered form of an EARLIER instant — must still win the min()
        // despite sorting later as a raw string (no leading zero-padding issue
        // here, but this is what the normalize-before-compare fix protects).
        revocation({ ctxId: 'acdp://reg.example/rev-early', compromisedSince: '2026-01-01 00:00:00+00' }),
      ]);
      auditRepo.findRevocationAmendmentCandidates.mockResolvedValue([]);

      await svc.reauditForFingerprint('default', FP);

      expect(auditRepo.findRevocationAmendmentCandidates).toHaveBeenCalledWith(
        'default',
        FP,
        '2026-01-01T00:00:00.000Z',
        config.receiptAuditBatchSize,
      );
    });

    it('continues past a row that throws during re-classification, counting it as an error', async () => {
      config.keyRevocationCheckEnabled = true;
      auditRepo.findRevocationAmendmentCandidates.mockResolvedValue([
        { eventId: 'evt-bad', status: 'verified', receiptCreatedAt: RECEIPT_AT, registryAuthority: AUTHORITY },
        { eventId: 'evt-good', status: 'verified', receiptCreatedAt: RECEIPT_AT, registryAuthority: AUTHORITY },
      ]);
      keyRevocationRepo.findByFingerprint.mockResolvedValue([revocation()]);
      auditRepo.amendKeyRevocation
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(true);

      const n = await svc.reauditForFingerprint('default', FP);

      expect(n).toBe(1); // evt-bad's throw didn't abort evt-good
      expect(auditRepo.amendKeyRevocation).toHaveBeenCalledTimes(2);
      expect(instrumentation.receiptAuditRevocationReauditsTotal.inc).toHaveBeenCalledWith({
        status: 'error',
      });
      expect(instrumentation.receiptAuditRevocationReauditsTotal.inc).toHaveBeenCalledWith({
        status: 'revoked_at_or_after',
      });
    });

    it('amends a candidate row whose verified receipt lands at/after the boundary', async () => {
      config.keyRevocationCheckEnabled = true;
      auditRepo.findRevocationAmendmentCandidates.mockResolvedValue([
        { eventId: 'evt-1', status: 'verified', receiptCreatedAt: RECEIPT_AT, registryAuthority: AUTHORITY },
      ]);
      keyRevocationRepo.findByFingerprint.mockResolvedValue([revocation()]);

      const n = await svc.reauditForFingerprint('default', FP);

      expect(n).toBe(1);
      expect(auditRepo.amendKeyRevocation).toHaveBeenCalledWith(
        'default',
        'evt-1',
        expect.objectContaining({ status: 'revoked_at_or_after', trustClass: 'producer_signed' }),
      );
      expect(instrumentation.receiptAuditRevocationReauditsTotal.inc).toHaveBeenCalledWith({
        status: 'revoked_at_or_after',
      });
    });

    it(
      'survives a candidate row.receiptCreatedAt in the Postgres rendering, not just strict RFC3339 ' +
        '(the SDK throws outright on the un-normalized form — caught by this phase\'s own integration test)',
      async () => {
        config.keyRevocationCheckEnabled = true;
        auditRepo.findRevocationAmendmentCandidates.mockResolvedValue([
          {
            eventId: 'evt-1',
            status: 'verified',
            receiptCreatedAt: '2026-06-01 00:00:00+00', // space + '+00', not '.000Z'
            registryAuthority: AUTHORITY,
          },
        ]);
        keyRevocationRepo.findByFingerprint.mockResolvedValue([revocation()]);

        const n = await svc.reauditForFingerprint('default', FP);

        expect(n).toBe(1);
        expect(auditRepo.amendKeyRevocation).toHaveBeenCalledWith(
          'default',
          'evt-1',
          expect.objectContaining({ status: 'revoked_at_or_after' }),
        );
      },
    );

    it('never counts a row the repository reports as already amended by a racing sweep', async () => {
      config.keyRevocationCheckEnabled = true;
      auditRepo.findRevocationAmendmentCandidates.mockResolvedValue([
        { eventId: 'evt-1', status: 'verified', receiptCreatedAt: RECEIPT_AT, registryAuthority: AUTHORITY },
      ]);
      keyRevocationRepo.findByFingerprint.mockResolvedValue([revocation()]);
      auditRepo.amendKeyRevocation.mockResolvedValue(false); // WHERE clause matched 0 rows

      const n = await svc.reauditForFingerprint('default', FP);

      expect(n).toBe(0);
      expect(instrumentation.receiptAuditRevocationReauditsTotal.inc).not.toHaveBeenCalled();
    });

    it('applies KEY_REVOCATION_ATTESTED_SCOPE per row, not fingerprint-wide', async () => {
      config.keyRevocationCheckEnabled = true;
      config.keyRevocationAttestedScope = 'same_registry';
      auditRepo.findRevocationAmendmentCandidates.mockResolvedValue([
        { eventId: 'evt-foreign', status: 'verified', receiptCreatedAt: RECEIPT_AT, registryAuthority: 'other.example' },
      ]);
      // registry_attested, originAuthority = AUTHORITY — does not cover a row
      // whose OWN event came from 'other.example' under same_registry scope.
      keyRevocationRepo.findByFingerprint.mockResolvedValue([
        revocation({ trustClass: 'registry_attested', originAuthority: AUTHORITY }),
      ]);

      const n = await svc.reauditForFingerprint('default', FP);

      expect(n).toBe(0);
      expect(auditRepo.amendKeyRevocation).not.toHaveBeenCalled();
    });

    it('never derives receiptCreatedAt from a row whose original status was not verified/verified_historical', async () => {
      config.keyRevocationCheckEnabled = true;
      auditRepo.findRevocationAmendmentCandidates.mockResolvedValue([
        { eventId: 'evt-1', status: 'no_receipt', receiptCreatedAt: null, registryAuthority: AUTHORITY },
      ]);
      keyRevocationRepo.findByFingerprint.mockResolvedValue([revocation()]);

      const n = await svc.reauditForFingerprint('default', FP);

      expect(n).toBe(1);
      expect(auditRepo.amendKeyRevocation).toHaveBeenCalledWith(
        'default',
        'evt-1',
        expect.objectContaining({ status: 'revoked_time_unverifiable' }),
      );
    });
  });
});

// ── RFC-ACDP-0014 §7: classifyKeyRevocation (pure, real SDK) ───────────────
//
// This is the "single highest-value test" the plan calls out: the SDK's
// fail-closed shape is `{"authorization":"none","boundary":…,"error":…}` —
// IDENTICAL `authorization` value to "no revocation applies at all". Every
// disambiguation here must key on the presence of `boundary`, never on
// `authorization` alone.
describe('classifyKeyRevocation (RFC-ACDP-0014 §7 boundary matrix)', () => {
  const FP2 = 'sha256:' + 'c'.repeat(64);
  const T = '2026-05-01T00:00:00.000Z'; // rev-002 conformance fixture's T
  const BEFORE = '2026-04-16T10:30:15.123Z'; // rev-002 scenario A
  const AFTER = '2026-05-03T09:00:00.000Z'; // rev-002 scenario B

  function revocation(overrides: Partial<KeyRevocation> = {}): KeyRevocation {
    return {
      tenantId: 'default',
      ctxId: 'acdp://reg.example/aaaaaaaa-1111-4111-8111-111111111111',
      revokedKeyFingerprint: FP2,
      compromisedSince: T,
      revokedKeyController: 'did:web:agent.example',
      publisher: 'did:web:agent.example',
      trustClass: 'producer_signed',
      revokedKeyId: null,
      reason: null,
      lineageId: 'lin-rev-1',
      originAuthority: AUTHORITY,
      contextType: 'key-revocation',
      verifiedAt: '2026-05-01T00:00:01.000Z',
      ...overrides,
    } as KeyRevocation;
  }

  it('THE guard test: fail-closed (receiptCreatedAt present, at/after T) is never "none"', () => {
    const result = classifyKeyRevocation([revocation()], FP2, AFTER);
    expect(result.status).not.toBe('none');
    expect(result.status).toBe('revoked_at_or_after');
  });

  it('scenario A (rev-002): receipt strictly BEFORE T → pre_compromise', () => {
    const result = classifyKeyRevocation([revocation()], FP2, BEFORE);
    expect(result.status).toBe('pre_compromise');
    expect(result.status === 'pre_compromise' && result.boundary).toBe(T);
  });

  it('scenario B (rev-002): receipt AFTER T → revoked_at_or_after', () => {
    const result = classifyKeyRevocation([revocation()], FP2, AFTER);
    expect(result.status).toBe('revoked_at_or_after');
  });

  it('boundary equality (receiptCreatedAt === T) fails closed, not pre_compromise', () => {
    const result = classifyKeyRevocation([revocation()], FP2, T);
    expect(result.status).toBe('revoked_at_or_after');
  });

  it('scenario C (rev-002): no verified receipt time (null) → revoked_time_unverifiable', () => {
    const result = classifyKeyRevocation([revocation()], FP2, null);
    expect(result.status).toBe('revoked_time_unverifiable');
  });

  it('no revocation row at all → none, with no SDK call needed', () => {
    const result = classifyKeyRevocation([], FP2, BEFORE);
    expect(result).toEqual({ status: 'none' });
  });

  it('trust-class propagation: producer_signed-only vs registry_attested-only at the same boundary differ only in trustClass', () => {
    const producerOnly = classifyKeyRevocation(
      [revocation({ trustClass: 'producer_signed' })],
      FP2,
      AFTER,
    );
    const attestedOnly = classifyKeyRevocation(
      [revocation({ trustClass: 'registry_attested', publisher: `did:web:${AUTHORITY}` })],
      FP2,
      AFTER,
    );
    expect(producerOnly.status).toBe('revoked_at_or_after');
    expect(attestedOnly.status).toBe('revoked_at_or_after');
    expect(producerOnly.status === 'revoked_at_or_after' && producerOnly.trustClass).toBe(
      'producer_signed',
    );
    expect(attestedOnly.status === 'revoked_at_or_after' && attestedOnly.trustClass).toBe(
      'registry_attested',
    );
  });

  it('tie-break: two revocations sharing the exact same effective boundary prefer producer_signed', () => {
    const result = classifyKeyRevocation(
      [
        revocation({ trustClass: 'registry_attested', publisher: `did:web:${AUTHORITY}` }),
        revocation({ trustClass: 'producer_signed' }),
      ],
      FP2,
      AFTER,
    );
    expect(result.status === 'revoked_at_or_after' && result.trustClass).toBe('producer_signed');
  });

  it('provenance: sources include every revocation row fed in, not just the boundary winner', () => {
    const earlier = revocation({
      ctxId: 'acdp://reg.example/bbbbbbbb-2222-4222-8222-222222222222',
      compromisedSince: '2026-04-01T00:00:00.000Z',
    });
    const later = revocation({
      ctxId: 'acdp://reg.example/cccccccc-3333-4333-8333-333333333333',
      compromisedSince: T,
    });
    const result = classifyKeyRevocation([earlier, later], FP2, AFTER);
    expect(result.status).not.toBe('none');
    if (result.status !== 'none') {
      expect(result.boundary).toBe(earlier.compromisedSince); // the min() fold wins
      expect(result.sources).toEqual(
        expect.arrayContaining([
          { ctxId: earlier.ctxId, publisher: earlier.publisher },
          { ctxId: later.ctxId, publisher: later.publisher },
        ]),
      );
      expect(result.sources).toHaveLength(2);
    }
  });

  // ── Postgres round-trip normalization must govern BOTH the SDK payload
  // AND the boundary-equality trust-class match, or one half silently wins
  // by default. `compromisedSince` below is deliberately in Postgres's own
  // `timestamp with time zone` text rendering (a space, `+00`, no
  // milliseconds) — exactly what `key_revocations` rows look like when read
  // back through Drizzle (`mode: 'string'`), never what a unit test would
  // hand-write otherwise. A regression that normalizes only the JSON payload
  // (feeding the SDK a valid array) but filters the RAW `revocations` for
  // the boundary-equality match would never find a match (Postgres-format
  // strings never equal the SDK's RFC3339 `boundary`), fall back to
  // `winners = revocations` (the whole array), and then ALWAYS prefer
  // `producer_signed` via the tie-break — silently overstating provenance
  // strength regardless of which revocation actually set the boundary. This
  // test seeds an EARLIER registry_attested row and a LATER producer_signed
  // one so the two failure modes disagree: correct code reports
  // `registry_attested` (the earlier, boundary-setting row); the broken
  // half-fix reports `producer_signed`.
  it('boundary-equality match survives the Postgres timestamp rendering, not just the SDK payload', () => {
    const earlierAttested = revocation({
      ctxId: 'acdp://reg.example/dddddddd-4444-4444-8444-444444444444',
      compromisedSince: '2026-04-20 00:00:00+00', // Postgres rendering, EARLIER
      trustClass: 'registry_attested',
      publisher: `did:web:${AUTHORITY}`,
    });
    const laterProducer = revocation({
      ctxId: 'acdp://reg.example/eeeeeeee-5555-4555-8555-555555555555',
      compromisedSince: '2026-04-25 00:00:00+00', // Postgres rendering, LATER
      trustClass: 'producer_signed',
    });
    const result = classifyKeyRevocation([earlierAttested, laterProducer], FP2, AFTER);
    expect(result.status).not.toBe('none');
    if (result.status !== 'none') {
      // The min() fold must pick the EARLIER row's boundary...
      expect(new Date(result.boundary).toISOString()).toBe(
        new Date(earlierAttested.compromisedSince).toISOString(),
      );
      // ...and report ITS trust class, not default to producer_signed just
      // because a producer_signed row exists somewhere in the fed set.
      expect(result.trustClass).toBe('registry_attested');
    }
  });

  it(
    'receiptCreatedAt survives the Postgres timestamp rendering too — not only the revocations array ' +
      '(Phase 15: this argument is DB-sourced at retroactive re-audit time, unlike the live-audit path)',
    () => {
      const rev = revocation({ compromisedSince: BEFORE }); // 2026-04-16T10:30:15.123Z
      // The exact rendering `receipt_audits.receipt_created_at` comes back
      // as after a round trip through Postgres — the SDK's strict RFC3339
      // parser throws outright on this form (confirmed against the pinned
      // binding); classifyKeyRevocation must normalize it before the call,
      // the same way it already normalizes `compromised_since`. April 20 is
      // after the April 16 boundary, so this must fail closed, not throw.
      const result = classifyKeyRevocation([rev], FP2, '2026-04-20 00:00:00+00');
      expect(result.status).toBe('revoked_at_or_after');
    },
  );
});
