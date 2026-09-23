/**
 * Cryptographic path of the receipt-audit sweep, with the SDK wrapper mocked
 * as a receipt-capable binding (> 0.3.0). Exercises the full second-observer
 * pipeline: federation fetch → independent hash recomputation → producer +
 * registry key resolution → SDK verifyReceipt — including the tampered-
 * receipt negative the 0.2.0 acceptance criteria call for.
 */
jest.mock('./receipt-verify', () => ({
  // `isCanonicalCtxId` stays REAL: the ctx_id pre-check is one of the
  // behaviours under test, and mocking it would let a fixture with a
  // non-canonical ctx_id pass silently.
  ...jest.requireActual<typeof import('./receipt-verify')>('./receipt-verify'),
  sdkSupportsReceipts: jest.fn().mockReturnValue(true),
  verifyContentHash: jest.fn().mockReturnValue({ ok: true }),
  verifyReceipt: jest.fn().mockReturnValue({ ok: true }),
  fingerprintEd25519B64: jest.fn(),
  verifyBodyOffline: jest.fn().mockReturnValue({ ok: true }),
  explainHashMismatch: jest.fn().mockReturnValue(null),
}));

import { Logger } from '@nestjs/common';
import { ReceiptAuditService } from './receipt-audit.service';
import {
  explainHashMismatch,
  fingerprintEd25519B64,
  verifyBodyOffline,
  verifyContentHash,
  verifyReceipt,
} from './receipt-verify';
import { ContextEvent } from '../db/schema';

const FP = 'sha256:' + 'b'.repeat(64);
const AUTHORITY = 'reg.example';
// Canonical under the SDK's `CtxId::parse`: `acdp://` + lowercase DNS
// authority + lowercase v4 UUID. Anything else is pre-rejected by the host
// before `verifyReceipt` is reached — see the dedicated case below.
const CTX = 'acdp://reg.example/abcdef01-2345-4678-9abc-def012345678';
const BODY_HASH = 'sha256:' + 'a'.repeat(64);

function makeReceipt(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    registry_did: `did:web:${AUTHORITY}`,
    ctx_id: CTX,
    lineage_id: 'lin-1',
    origin_registry: AUTHORITY,
    created_at: '2026-01-01T00:00:00.000Z',
    content_hash: BODY_HASH,
    key_fingerprint: FP,
    signature: {
      algorithm: 'ed25519',
      key_id: `did:web:${AUTHORITY}#receipt-key-1`,
      value: 'c2ln',
    },
    ...overrides,
  };
}

function makeBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ctx_id: CTX,
    agent_id: 'did:web:agent.example',
    content_hash: BODY_HASH,
    signature: {
      algorithm: 'ed25519',
      key_id: 'did:web:agent.example#key-1',
      value: 'cHJvZHNpZw==',
    },
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ContextEvent> = {}): ContextEvent {
  return {
    id: '22222222-2222-4222-8222-222222222222',
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
    rawPayload: { type: 'context_published', registry_receipt: makeReceipt() },
    createdAt: '2026-01-01T00:00:05.000Z',
    ...overrides,
  } as ContextEvent;
}

describe('ReceiptAuditService (cryptographic path, receipt-capable SDK)', () => {
  let registryRepo: any;
  let federationClient: any;
  let didResolver: any;
  let svc: ReceiptAuditService;

  beforeEach(() => {
    jest.clearAllMocks();
    (verifyContentHash as jest.Mock).mockReturnValue({ ok: true });
    (verifyReceipt as jest.Mock).mockReturnValue({ ok: true });
    (verifyBodyOffline as jest.Mock).mockReturnValue({ ok: true });
    (fingerprintEd25519B64 as jest.Mock).mockReturnValue(FP);
    (explainHashMismatch as jest.Mock).mockReturnValue(null);

    registryRepo = {
      findByAuthority: jest
        .fn()
        .mockResolvedValue({ authority: AUTHORITY, baseUrl: 'https://reg.example' }),
    };
    federationClient = {
      get: jest.fn().mockResolvedValue({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ body: makeBody(), registry_receipt: makeReceipt() }),
      }),
    };
    didResolver = {
      // Producer key (did:web): strict assertionMethod gate.
      resolveKey: jest.fn().mockResolvedValue({
        keyId: 'did:web:agent.example#key-1',
        algorithm: 'ed25519',
        publicKeyB64: 'cHJvZHVjZXJrZXk=',
      }),
      // Registry receipt key: RFC-ACDP-0010 §9 lifecycle, carries `historical`.
      resolveReceiptKey: jest.fn().mockResolvedValue({
        keyId: `did:web:${AUTHORITY}#receipt-key-1`,
        algorithm: 'ed25519',
        publicKeyB64: 'cmVnaXN0cnlrZXk=',
        historical: false,
      }),
    };
    svc = new ReceiptAuditService(
      {
        receiptAuditEnabled: true,
        receiptAuditIntervalSeconds: 300,
        receiptAuditBatchSize: 50,
        receiptAuditLookbackHours: 24,
      } as any,
      { tryAdvisoryLock: jest.fn(), advisoryUnlock: jest.fn() } as any,
      { findUnauditedPublishes: jest.fn(), record: jest.fn() } as any,
      registryRepo,
      { advertisesReceipts: jest.fn().mockResolvedValue(true) } as any,
      federationClient,
      didResolver,
      { receiptAuditsTotal: { inc: jest.fn() } } as any,
    );
  });

  it('verifies a clean receipt end-to-end (fetch → recompute → resolve → verifyReceipt)', async () => {
    const verdict = await svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('verified');
    expect(verdict.discrepancies).toEqual([]);

    // Context fetched through the SSRF-gated client from the registry base URL.
    expect(federationClient.get).toHaveBeenCalledWith(
      `https://reg.example/contexts/${encodeURIComponent(CTX)}`,
    );
    // Hash independently recomputed before the echoed string is trusted.
    expect(verifyContentHash).toHaveBeenCalledWith(JSON.stringify(makeBody()), BODY_HASH);
    // Producer key resolved from ITS did:web document (strict gate), fingerprinted.
    expect(didResolver.resolveKey).toHaveBeenCalledWith(
      'did:web:agent.example#key-1',
      'ed25519',
    );
    // Registry receipt key resolved through the §9 lifecycle path, NOT the
    // strict producer path.
    expect(didResolver.resolveReceiptKey).toHaveBeenCalledWith(
      `did:web:${AUTHORITY}#receipt-key-1`,
      'ed25519',
    );
    // Receipt verified against the registry key and the recomputed inputs.
    // `bodyJson` is argument TWO (acdp 0.14.0+) and is the very string
    // `verifyContentHash` was run against — a reorder of these arguments
    // must fail loudly here.
    expect(verifyReceipt).toHaveBeenCalledWith(
      JSON.stringify(makeReceipt()),
      JSON.stringify(makeBody()),
      'cmVnaXN0cnlrZXk=',
      CTX,
      BODY_HASH,
      FP,
    );
    const [, passedBody] = (verifyReceipt as jest.Mock).mock.calls[0]!;
    const [hashedBody] = (verifyContentHash as jest.Mock).mock.calls[0]!;
    expect(passedBody).toBe(hashedBody);
  });

  it('reports verified_historical when the receipt key is retired (§9 lifecycle)', async () => {
    didResolver.resolveReceiptKey.mockResolvedValue({
      keyId: `did:web:${AUTHORITY}#receipt-key-1`,
      algorithm: 'ed25519',
      publicKeyB64: 'cmVnaXN0cnlrZXk=',
      historical: true, // rotated out of assertionMethod, kept in verificationMethod
    });
    const verdict = await svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('verified_historical');
    expect(verdict.discrepancies).toEqual([]);
    // verifyReceipt still runs — the receipt is cryptographically valid.
    expect(verifyReceipt).toHaveBeenCalled();
  });

  it('records an error verdict when a retired key is gone from verificationMethod entirely', async () => {
    // The §9 helper fails closed (key_not_found) when full removal — the
    // registry's compromise-revocation signal — has happened.
    didResolver.resolveReceiptKey.mockRejectedValue(
      Object.assign(new Error('PICK: key_not_found: ...'), { code: 'key_not_found' }),
    );
    const verdict = await svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('error');
    expect(verdict.discrepancies.join('\n')).toContain(
      'unverified: registry receipt key resolution failed',
    );
    expect(verifyReceipt).not.toHaveBeenCalled();
  });

  it('flags a tampered receipt the SDK rejects (acceptance-criteria negative)', async () => {
    (verifyReceipt as jest.Mock).mockReturnValue({
      ok: false,
      reason: 'invalid_receipt: signature verification failed',
      kind: 'receipt_dishonest',
    });
    const verdict = await svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('discrepancy');
    expect(verdict.discrepancies.join('\n')).toContain('receipt_invalid');
  });

  // ── The 0.14.x tightenings: three new throw paths, three meanings ──────
  //
  // `verifyReceipt` now also parses `expectedCtxId` with `CtxId::parse`,
  // strictly deserializes the served body, and cross-checks the §8 step 3
  // body bindings. Two of those three failures are NOT registry dishonesty,
  // and mislabelling them destroys the signal in `RunTrustSummary.flagged`.

  it('never calls verifyReceipt when OUR OWN stored ctx_id is not canonical', async () => {
    const badCtx = `acdp://${AUTHORITY}/ctx-001`; // legacy opaque id, not a v4 UUID
    const ev = makeEvent({
      ctxId: badCtx,
      rawPayload: {
        type: 'context_published',
        registry_receipt: makeReceipt({ ctx_id: badCtx }),
      },
    });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const verdict = await svc.auditEvent(ev);
    expect(verdict.status).toBe('error');
    expect(verdict.discrepancies).toHaveLength(1);
    expect(verdict.discrepancies[0]!.startsWith('unverified:')).toBe(true);
    expect(verdict.discrepancies[0]).toContain('not canonical');
    // Not a dishonesty flag, and no wasted federation fetch.
    expect(verdict.discrepancies.some((d) => d.startsWith('receipt_invalid:'))).toBe(false);
    expect(verifyReceipt).not.toHaveBeenCalled();
    expect(federationClient.get).not.toHaveBeenCalled();
    // The operator-visible signal. `error` notes never reach an API response
    // and `acdp_receipt_audits_total{status="error"}` shares its label with
    // transport failures, so this flip is discoverable ONLY through a log
    // line carrying its own cause key — structured fields, not a string.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ auditCause: 'stored_ctx_id_not_canonical', ctxId: badCtx }),
    );
    warn.mockRestore();
  });

  it('rejects a port-bearing ctx_id authority the same way (no registry can mint one)', async () => {
    const portCtx = 'acdp://localhost:8443/abcdef01-2345-4678-9abc-def012345678';
    const ev = makeEvent({
      ctxId: portCtx,
      rawPayload: {
        type: 'context_published',
        registry_receipt: makeReceipt({ ctx_id: portCtx }),
      },
    });
    const verdict = await svc.auditEvent(ev);
    expect(verdict.status).toBe('error');
    expect(verdict.discrepancies[0]!.startsWith('unverified:')).toBe(true);
    expect(verifyReceipt).not.toHaveBeenCalled();
  });

  it('treats a body the SDK cannot deserialize as unverified, not as dishonesty', async () => {
    (verifyReceipt as jest.Mock).mockReturnValue({
      ok: false,
      reason: 'GenericFailure: invalid body JSON: missing field `contributors`',
      kind: 'malformed_body',
    });
    const verdict = await svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('error');
    expect(verdict.discrepancies).toHaveLength(1);
    expect(verdict.discrepancies[0]!.startsWith('unverified:')).toBe(true);
    expect(verdict.discrepancies[0]).toContain('cannot parse');
    expect(verdict.discrepancies.some((d) => d.startsWith('receipt_invalid:'))).toBe(false);
  });

  it('reports an SDK ctx_id rejection the host allowed as unverified, not as dishonesty', async () => {
    // Rare but reachable: `isCanonicalCtxId` is a deliberately bounded mirror
    // of CtxId::parse (it does not enforce the 63-character DNS-label limit),
    // so this path exists to read as OUR data problem, never the registry's.
    (verifyReceipt as jest.Mock).mockReturnValue({
      ok: false,
      reason: 'GenericFailure: invalid expectedCtxId: schema violation',
      kind: 'ctx_id_rejected',
    });
    const verdict = await svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('error');
    expect(verdict.discrepancies[0]!.startsWith('unverified:')).toBe(true);
    expect(verdict.discrepancies[0]).toContain('CtxId::parse rejected ctx_id');
    expect(verdict.discrepancies.some((d) => d.startsWith('receipt_invalid:'))).toBe(false);
  });

  it('flags a §8 step 3 body-binding mismatch as registry dishonesty', async () => {
    // A registry serving a body that disagrees with the receipt it signed.
    (verifyReceipt as jest.Mock).mockReturnValue({
      ok: false,
      reason: "invalid registry receipt: receipt lineage_id 'a' ≠ body lineage_id 'b'",
      kind: 'receipt_dishonest',
    });
    const verdict = await svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('discrepancy');
    expect(verdict.discrepancies[0]!.startsWith('receipt_invalid:')).toBe(true);
    expect(verdict.discrepancies[0]).toContain('body lineage_id');
  });

  it('falls through to a FLAG for an unrecognised verifyReceipt failure', async () => {
    // The conservative default, asserted explicitly so a later "tidy-up"
    // cannot invert it into a quiet `unverified:` note.
    (verifyReceipt as jest.Mock).mockReturnValue({
      ok: false,
      reason: 'something the SDK has never said before',
    });
    const verdict = await svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('discrepancy');
    expect(verdict.discrepancies[0]!.startsWith('receipt_invalid:')).toBe(true);
  });

  it('flags a served body whose content_hash does not recompute', async () => {
    (verifyContentHash as jest.Mock).mockReturnValue({
      ok: false,
      reason: 'content_hash mismatch',
    });
    const verdict = await svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('discrepancy');
    expect(verdict.discrepancies.join('\n')).toContain('content_hash_mismatch');
    expect(verifyReceipt).not.toHaveBeenCalled();
  });

  it('enriches a content_hash_mismatch with the SDK divergence diagnosis', async () => {
    (verifyContentHash as jest.Mock).mockReturnValue({
      ok: false,
      reason: 'content_hash mismatch',
    });
    (explainHashMismatch as jest.Mock).mockReturnValue(
      'acdp_version omitted-vs-explicit divergence',
    );
    const verdict = await svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('discrepancy');
    const flag = verdict.discrepancies.find((d) => d.startsWith('content_hash_mismatch'));
    expect(flag).toContain('acdp_version omitted-vs-explicit divergence');
  });

  it('rejects a receipt signed with a non-ed25519 algorithm as non-conformant', async () => {
    const ev = makeEvent({
      rawPayload: {
        type: 'context_published',
        registry_receipt: makeReceipt({
          signature: {
            algorithm: 'ecdsa-p256',
            key_id: `did:web:${AUTHORITY}#receipt-key-1`,
            value: 'c2ln',
          },
        }),
      },
    });
    const verdict = await svc.auditEvent(ev);
    // Non-conformance is environmental (can't verify), not a dishonesty flag.
    expect(verdict.status).toBe('error');
    expect(verdict.discrepancies.join('\n')).toContain(
      "receipt signature algorithm 'ecdsa-p256' is unsupported",
    );
    // We stop before resolving a key or calling verifyReceipt.
    expect(didResolver.resolveReceiptKey).not.toHaveBeenCalled();
    expect(verifyReceipt).not.toHaveBeenCalled();
  });

  it('flags a receipt signed by a key outside the source registry DID', async () => {
    const ev = makeEvent({
      rawPayload: {
        type: 'context_published',
        registry_receipt: makeReceipt({
          // Foreign key id, but registry_did still claims reg.example so the
          // structural check passes — only the key binding catches this.
          signature: {
            algorithm: 'ed25519',
            key_id: 'did:web:evil.example#receipt-key-1',
            value: 'c2ln',
          },
        }),
      },
    });
    const verdict = await svc.auditEvent(ev);
    expect(verdict.status).toBe('discrepancy');
    expect(verdict.discrepancies.join('\n')).toContain('receipt_key_foreign_did');
    expect(verifyReceipt).not.toHaveBeenCalled();
  });

  // ── B10: the receipt-key binding uses the CANONICAL did:web encoding ───
  it('B10: accepts a receipt key under the canonical did:web of a port-bearing authority', async () => {
    const PORT = 'localhost:8443';
    const PORT_KEY_ID = 'did:web:localhost%3A8443#receipt-key-1';
    const receipt = makeReceipt({
      registry_did: 'did:web:localhost%3A8443',
      origin_registry: PORT,
      signature: { algorithm: 'ed25519', key_id: PORT_KEY_ID, value: 'c2ln' },
    });
    registryRepo.findByAuthority.mockResolvedValue({
      authority: PORT,
      baseUrl: 'https://localhost:8443',
    });
    federationClient.get.mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ body: makeBody(), registry_receipt: receipt }),
    });
    didResolver.resolveReceiptKey.mockResolvedValue({
      keyId: PORT_KEY_ID,
      algorithm: 'ed25519',
      publicKeyB64: 'cmVnaXN0cnlrZXk=',
      historical: false,
    });

    const verdict = await svc.auditEvent(
      makeEvent({
        registryAuthority: PORT,
        rawPayload: { type: 'context_published', registry_receipt: receipt },
      }),
    );
    expect(verdict.discrepancies.join('\n')).not.toContain('receipt_key_foreign_did');
    expect(verdict.status).toBe('verified');
    expect(didResolver.resolveReceiptKey).toHaveBeenCalledWith(PORT_KEY_ID, 'ed25519');
  });

  it('B10: still flags a foreign receipt key on a port-bearing authority', async () => {
    const PORT = 'localhost:8443';
    const receipt = makeReceipt({
      registry_did: 'did:web:localhost%3A8443',
      origin_registry: PORT,
      signature: {
        algorithm: 'ed25519',
        key_id: 'did:web:evil.example#receipt-key-1',
        value: 'c2ln',
      },
    });
    registryRepo.findByAuthority.mockResolvedValue({
      authority: PORT,
      baseUrl: 'https://localhost:8443',
    });
    federationClient.get.mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ body: makeBody(), registry_receipt: receipt }),
    });

    const verdict = await svc.auditEvent(
      makeEvent({
        registryAuthority: PORT,
        rawPayload: { type: 'context_published', registry_receipt: receipt },
      }),
    );
    expect(verdict.status).toBe('discrepancy');
    expect(verdict.discrepancies.join('\n')).toContain(
      "receipt_key_foreign_did: 'did:web:evil.example#receipt-key-1' is not a key of 'did:web:localhost%3A8443'",
    );
    expect(verifyReceipt).not.toHaveBeenCalled();
  });

  it('verifies did:key producers offline instead of resolving a DID document', async () => {
    const didKey = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    const body = makeBody({
      agent_id: didKey,
      signature: { algorithm: 'ed25519', key_id: `${didKey}#z6Mkh`, value: 'cHJvZHNpZw==' },
    });
    federationClient.get.mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ body }),
    });
    const verdict = await svc.auditEvent(makeEvent({ agentId: didKey }));
    expect(verdict.status).toBe('verified');
    expect(verifyBodyOffline).toHaveBeenCalledWith(JSON.stringify(body));
    // did:key producer needs no DID-document resolution at all; only the
    // registry receipt key is resolved (via the §9 lifecycle path).
    expect(didResolver.resolveKey).not.toHaveBeenCalled();
    expect(didResolver.resolveReceiptKey).toHaveBeenCalledTimes(1);
    expect(didResolver.resolveReceiptKey).toHaveBeenCalledWith(
      `did:web:${AUTHORITY}#receipt-key-1`,
      'ed25519',
    );
  });

  it('flags a did:key body whose offline verification fails', async () => {
    (verifyBodyOffline as jest.Mock).mockReturnValue({ ok: false, reason: 'bad signature' });
    const didKey = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    const verdict = await svc.auditEvent(makeEvent({ agentId: didKey }));
    expect(verdict.status).toBe('discrepancy');
    expect(verdict.discrepancies.join('\n')).toContain('body_signature_invalid');
  });

  it('returns an error verdict (not a flag) when the context fetch fails', async () => {
    federationClient.get.mockRejectedValue(new Error('upstream unreachable'));
    const verdict = await svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('error');
    expect(verdict.discrepancies.join('\n')).toContain('unverified: context fetch failed');
  });

  it('returns an error verdict when the producer key cannot be resolved', async () => {
    didResolver.resolveKey.mockRejectedValue(new Error('agent did.json 404'));
    const verdict = await svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('error');
    expect(verdict.discrepancies.join('\n')).toContain('unverified: producer key resolution failed');
  });

  it('returns an error verdict when the registry receipt key cannot be resolved', async () => {
    didResolver.resolveReceiptKey.mockRejectedValue(new Error('registry did.json 404'));
    const verdict = await svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('error');
    expect(verdict.discrepancies.join('\n')).toContain(
      'unverified: registry receipt key resolution failed',
    );
  });
});
