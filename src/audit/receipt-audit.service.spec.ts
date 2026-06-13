/**
 * Structural verdicts of the receipt-audit sweep — the checks that run even
 * when the installed `acdp` SDK predates the receipt API. The SDK wrapper is
 * mocked as "no receipt support" so these tests are deterministic across
 * dependency versions; the crypto path is covered in
 * receipt-audit.service.crypto.spec.ts.
 */
jest.mock('./receipt-verify', () => ({
  sdkSupportsReceipts: jest.fn().mockReturnValue(false),
  verifyContentHash: jest.fn(),
  verifyReceipt: jest.fn(),
  fingerprintEd25519B64: jest.fn(),
  verifyBodyOffline: jest.fn(),
  explainHashMismatch: jest.fn().mockReturnValue(null),
}));

import { ReceiptAuditService } from './receipt-audit.service';
import { ContextEvent } from '../db/schema';

const FP = 'sha256:' + 'b'.repeat(64);
const AUTHORITY = 'reg.example';
const CTX = 'acdp://reg.example/c1';

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
  let svc: ReceiptAuditService;

  beforeEach(() => {
    config = {
      receiptAuditEnabled: true,
      receiptAuditIntervalSeconds: 300,
      receiptAuditBatchSize: 50,
      receiptAuditLookbackHours: 24,
    };
    database = {
      tryAdvisoryLock: jest.fn().mockResolvedValue(true),
      advisoryUnlock: jest.fn().mockResolvedValue(undefined),
    };
    auditRepo = {
      findUnauditedPublishes: jest.fn().mockResolvedValue([]),
      record: jest.fn().mockResolvedValue({}),
    };
    registryRepo = { findByAuthority: jest.fn().mockResolvedValue(null) };
    profiles = { advertisesReceipts: jest.fn().mockResolvedValue(null) };
    federationClient = { get: jest.fn() };
    didResolver = { resolveKey: jest.fn() };
    instrumentation = { receiptAuditsTotal: { inc: jest.fn() } };
    svc = new ReceiptAuditService(
      config,
      database,
      auditRepo,
      registryRepo,
      profiles,
      federationClient,
      didResolver,
      instrumentation,
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
});
