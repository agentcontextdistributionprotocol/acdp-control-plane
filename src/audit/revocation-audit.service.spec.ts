/**
 * Orchestration logic of the revocation sweep, with every pure-crypto/SDK
 * helper mocked (each is unit-tested independently in `receipt-verify.spec.ts`
 * / `revocation-verify.spec.ts`). This file proves `RevocationAuditService`
 * wires them together correctly: which branch runs for which producer DID
 * method, how each failure classifies as `verified` / `invalid` /
 * `unavailable`, and that `sweep()` persists + counts exactly the outcomes
 * `verifyEvent` returns — mirrors `receipt-audit.service.spec.ts`'s approach.
 */
jest.mock('./receipt-verify', () => ({
  ...jest.requireActual<typeof import('./receipt-verify')>('./receipt-verify'),
  verifyContentHash: jest.fn(),
  verifyBodyOffline: jest.fn(),
  fingerprintEd25519B64: jest.fn(),
  verifyCtxIdBinding: jest.fn(),
}));

jest.mock('./revocation-verify', () => ({
  ...jest.requireActual<typeof import('./revocation-verify')>('./revocation-verify'),
  sdkSupportsRevocations: jest.fn().mockReturnValue(true),
  parseKeyRevocation: jest.fn(),
}));

jest.mock('../common/multibase', () => ({
  ...jest.requireActual<typeof import('../common/multibase')>('../common/multibase'),
  decodeEd25519Multibase: jest.fn(),
}));

jest.mock('../auth/acdp-verify', () => ({
  ...jest.requireActual<typeof import('../auth/acdp-verify')>('../auth/acdp-verify'),
  verifySignatureB64: jest.fn(),
}));

jest.mock('./revocation-binding', () => ({
  ...jest.requireActual<typeof import('./revocation-binding')>('./revocation-binding'),
  crossCheckRegistryBinding: jest.fn(),
}));

import { verifySignatureB64 } from '../auth/acdp-verify';
import { DidResolutionError } from '../auth/did-web/did-web-resolver.service';
import { decodeEd25519Multibase } from '../common/multibase';
import { FederationFetchError } from '../contexts/safe-federation-client';
import { ContextEvent } from '../db/schema';
import { fingerprintEd25519B64, verifyBodyOffline, verifyContentHash, verifyCtxIdBinding } from './receipt-verify';
import { RevocationAuditService } from './revocation-audit.service';
import { crossCheckRegistryBinding } from './revocation-binding';
import { parseKeyRevocation } from './revocation-verify';

const mockVerifyContentHash = verifyContentHash as jest.MockedFunction<typeof verifyContentHash>;
const mockVerifyBodyOffline = verifyBodyOffline as jest.MockedFunction<typeof verifyBodyOffline>;
const mockFingerprintEd25519B64 = fingerprintEd25519B64 as jest.MockedFunction<typeof fingerprintEd25519B64>;
const mockVerifyCtxIdBinding = verifyCtxIdBinding as jest.MockedFunction<typeof verifyCtxIdBinding>;
const mockParseKeyRevocation = parseKeyRevocation as jest.MockedFunction<typeof parseKeyRevocation>;
const mockDecodeEd25519Multibase = decodeEd25519Multibase as jest.MockedFunction<typeof decodeEd25519Multibase>;
const mockVerifySignatureB64 = verifySignatureB64 as jest.MockedFunction<typeof verifySignatureB64>;
const mockCrossCheckRegistryBinding = crossCheckRegistryBinding as jest.MockedFunction<
  typeof crossCheckRegistryBinding
>;

const AUTHORITY = 'reg.example';
const CTX = 'acdp://reg.example/abcdef01-2345-4678-9abc-def012345678';
const HASH = 'sha256:' + 'a'.repeat(64);
const FP = 'sha256:' + 'b'.repeat(64);

function makeEvent(overrides: Partial<ContextEvent> = {}): ContextEvent {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: 'default',
    eventType: 'context_published',
    eventTs: '2026-01-01T00:00:00.000Z',
    runId: 'run-1',
    ctxId: CTX,
    lineageId: 'lin-1',
    agentId: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
    contextType: 'key-revocation',
    visibility: 'public',
    version: 1,
    derivedFrom: [],
    registryAuthority: AUTHORITY,
    scenarioId: null,
    fingerprint: 'evt:x',
    keyFingerprint: null,
    receiptPresent: false,
    rawPayload: { type: 'key-revocation' },
    createdAt: '2026-01-01T00:00:05.000Z',
    ...overrides,
  } as ContextEvent;
}

function makeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ctx_id: CTX,
    lineage_id: 'lin:sha256:' + 'c'.repeat(64),
    origin_registry: AUTHORITY,
    created_at: '2026-01-01T00:00:00.000Z',
    agent_id: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
    type: 'key-revocation',
    content_hash: HASH,
    ...overrides,
  };
}

const PARSED_REVOCATION = {
  revokedKeyFingerprint: 'sha256:' + 'd'.repeat(64),
  compromisedSince: '2026-05-01T00:00:00.000Z',
  reason: null,
  revokedKeyId: null,
  revokedKeyController: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
  publisher: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
  trustClass: 'producer_signed' as const,
};

describe('RevocationAuditService', () => {
  let config: any;
  let database: any;
  let revocationRepo: any;
  let registryRepo: any;
  let profiles: any;
  let federationClient: any;
  let didResolver: any;
  let instrumentation: any;
  let receiptAuditService: any;
  let svc: RevocationAuditService;

  beforeEach(() => {
    jest.clearAllMocks();
    config = {
      keyRevocationCheckEnabled: true,
      keyRevocationAttestedScope: 'same_registry',
      keyRevocationLookbackHours: 720,
      receiptAuditIntervalSeconds: 300,
      receiptAuditBatchSize: 50,
    };
    database = {
      tryAdvisoryLock: jest.fn().mockResolvedValue(true),
      advisoryUnlock: jest.fn().mockResolvedValue(undefined),
    };
    revocationRepo = {
      findCandidates: jest.fn().mockResolvedValue([]),
      record: jest.fn().mockResolvedValue({}),
      countByLineage: jest.fn().mockResolvedValue(0),
      findFreshLineageCursor: jest.fn().mockResolvedValue(false),
      recordLineageWalk: jest.fn().mockResolvedValue(undefined),
      distinctFingerprints: jest.fn().mockResolvedValue([]),
    };
    registryRepo = {
      findByAuthority: jest.fn().mockResolvedValue({ baseUrl: 'https://reg.example' }),
    };
    profiles = { registryCapabilities: jest.fn() };
    federationClient = { get: jest.fn() };
    didResolver = { resolveKey: jest.fn() };
    instrumentation = { keyRevocationChecksTotal: { inc: jest.fn() } };
    receiptAuditService = { reauditForFingerprint: jest.fn().mockResolvedValue(0) };

    mockVerifyCtxIdBinding.mockReturnValue({ ok: true });
    mockVerifyContentHash.mockReturnValue({ ok: true });
    mockVerifyBodyOffline.mockReturnValue({ ok: true });
    mockDecodeEd25519Multibase.mockReturnValue({ ok: true, publicKey: Buffer.alloc(32, 1) });
    mockFingerprintEd25519B64.mockReturnValue(FP);
    mockVerifySignatureB64.mockReturnValue(true);
    mockParseKeyRevocation.mockReturnValue({ ok: true, revocation: PARSED_REVOCATION });

    svc = new RevocationAuditService(
      config,
      database,
      revocationRepo,
      registryRepo,
      profiles,
      federationClient,
      didResolver,
      instrumentation,
      receiptAuditService,
    );
  });

  function respond(body: Record<string, unknown>, status = 200) {
    federationClient.get.mockResolvedValue({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ body }),
    });
  }

  it('rejects a candidate with no ctx_id', async () => {
    const out = await svc.verifyEvent(makeEvent({ ctxId: null }));
    expect(out.status).toBe('invalid');
  });

  it('is unavailable when the registry has no known base_url', async () => {
    registryRepo.findByAuthority.mockResolvedValue(null);
    const out = await svc.verifyEvent(makeEvent());
    expect(out.status).toBe('unavailable');
  });

  // ── Fetch classification ──────────────────────────────────────────────
  it('classifies a FederationFetchError FETCH as unavailable (transient)', async () => {
    federationClient.get.mockRejectedValue(new FederationFetchError('FETCH', 'boom'));
    const out = await svc.verifyEvent(makeEvent());
    expect(out.status).toBe('unavailable');
  });

  it('classifies a FederationFetchError SSRF as invalid (permanent)', async () => {
    federationClient.get.mockRejectedValue(new FederationFetchError('SSRF', 'nope'));
    const out = await svc.verifyEvent(makeEvent());
    expect(out.status).toBe('invalid');
  });

  it('classifies a 5xx status as unavailable, a 4xx as invalid', async () => {
    respond({}, 503);
    expect((await svc.verifyEvent(makeEvent())).status).toBe('unavailable');
    respond({}, 404);
    expect((await svc.verifyEvent(makeEvent())).status).toBe('invalid');
  });

  it('rejects a retrieval response with no body member', async () => {
    federationClient.get.mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ notBody: true }),
    });
    const out = await svc.verifyEvent(makeEvent());
    expect(out.status).toBe('invalid');
  });

  // ── ctx_id binding (RFC-ACDP-0006 §4.1 step 7) ────────────────────────
  it('rejects a served ctx_id substitution', async () => {
    respond(makeBody());
    mockVerifyCtxIdBinding.mockReturnValue({ ok: false, reason: 'context substitution: x', kind: 'mismatch' });
    const out = await svc.verifyEvent(makeEvent());
    expect(out.status).toBe('invalid');
    expect(out.reason).toContain('ctx_id substitution');
  });

  it('fails closed on an unverifiable ctx_id binding too — same polarity as contexts.controller.ts', async () => {
    respond(makeBody());
    mockVerifyCtxIdBinding.mockReturnValue({ ok: false, reason: 'invalid body JSON: x', kind: 'unverifiable' });
    const out = await svc.verifyEvent(makeEvent());
    expect(out.status).toBe('invalid');
    // Never upgraded into an unfounded substitution accusation.
    expect(out.reason).not.toContain('substitution');
    expect(out.reason).toContain('ctx_id binding unverifiable');
  });

  // ── Content hash ───────────────────────────────────────────────────────
  it('rejects a body with no content_hash', async () => {
    const { content_hash: _omit, ...noHash } = makeBody();
    respond(noHash);
    const out = await svc.verifyEvent(makeEvent());
    expect(out.status).toBe('invalid');
    expect(out.reason).toContain('no content_hash');
  });

  it('rejects a content_hash mismatch', async () => {
    respond(makeBody());
    mockVerifyContentHash.mockReturnValue({ ok: false, reason: 'nope' });
    const out = await svc.verifyEvent(makeEvent());
    expect(out.status).toBe('invalid');
    expect(out.reason).toContain('content_hash_mismatch');
  });

  // ── did:key producer path ────────────────────────────────────────────
  describe('did:key producer', () => {
    it('rejects a body that fails offline verification', async () => {
      respond(makeBody());
      mockVerifyBodyOffline.mockReturnValue({ ok: false, reason: 'bad sig' });
      const out = await svc.verifyEvent(makeEvent());
      expect(out.status).toBe('invalid');
      expect(out.reason).toContain('body_signature_invalid');
    });

    it('rejects an undecodable did:key agent_id', async () => {
      respond(makeBody());
      mockDecodeEd25519Multibase.mockReturnValue({ ok: false, reason: 'bad multibase' });
      const out = await svc.verifyEvent(makeEvent());
      expect(out.status).toBe('invalid');
      expect(out.reason).toContain('undecodable did:key');
    });

    it('verifies end-to-end and persists a producer_signed revocation', async () => {
      respond(makeBody());
      const out = await svc.verifyEvent(makeEvent());
      expect(out.status).toBe('verified');
      expect(out.trustClass).toBe('producer_signed');
      expect(mockParseKeyRevocation).toHaveBeenCalledWith(expect.any(String), FP);
    });
  });

  // ── did:web producer path ────────────────────────────────────────────
  describe('did:web producer', () => {
    const WEB_AGENT = 'did:web:agents.example.com:producer';
    const KEY_ID = `${WEB_AGENT}#key-1`;

    function webEvent(overrides: Partial<ContextEvent> = {}) {
      return makeEvent({ agentId: WEB_AGENT, ...overrides });
    }

    function webBody(sigOverrides: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
      return makeBody({
        agent_id: WEB_AGENT,
        signature: { algorithm: 'ed25519', key_id: KEY_ID, value: 'c2ln', ...sigOverrides },
        ...overrides,
      });
    }

    it('rejects a body signature missing key_id/value', async () => {
      respond(makeBody({ agent_id: WEB_AGENT, signature: {} }));
      const out = await svc.verifyEvent(webEvent());
      expect(out.status).toBe('invalid');
    });

    it('rejects a key_id with no #fragment', async () => {
      respond(webBody({ key_id: WEB_AGENT }));
      const out = await svc.verifyEvent(webEvent());
      expect(out.status).toBe('invalid');
    });

    it('rejects when signature.key_id DID part != agent_id (key_not_authorized)', async () => {
      respond(webBody({ key_id: 'did:web:other.example#key-1' }));
      const out = await svc.verifyEvent(webEvent());
      expect(out.status).toBe('invalid');
      expect(out.reason).toContain('key_not_authorized');
    });

    it('is unavailable for a non-ed25519 algorithm (no SDK fingerprint helper)', async () => {
      respond(webBody({ algorithm: 'ecdsa-p256' }));
      const out = await svc.verifyEvent(webEvent());
      expect(out.status).toBe('unavailable');
    });

    it('classifies a DidResolutionError FETCH as unavailable, PICK as invalid', async () => {
      respond(webBody());
      didResolver.resolveKey.mockRejectedValue(new DidResolutionError('FETCH', 'timeout'));
      expect((await svc.verifyEvent(webEvent())).status).toBe('unavailable');

      didResolver.resolveKey.mockRejectedValue(new DidResolutionError('PICK', 'not authorized'));
      expect((await svc.verifyEvent(webEvent())).status).toBe('invalid');
    });

    it('rejects a signature that fails verification', async () => {
      respond(webBody());
      didResolver.resolveKey.mockResolvedValue({ keyId: KEY_ID, algorithm: 'ed25519', publicKeyB64: 'a2V5' });
      mockVerifySignatureB64.mockReturnValue(false);
      const out = await svc.verifyEvent(webEvent());
      expect(out.status).toBe('invalid');
      expect(out.reason).toContain('body_signature_invalid');
    });

    it('verifies end-to-end over the recomputed content_hash (not raw body JSON)', async () => {
      respond(webBody());
      didResolver.resolveKey.mockResolvedValue({ keyId: KEY_ID, algorithm: 'ed25519', publicKeyB64: 'a2V5' });
      const out = await svc.verifyEvent(webEvent());
      expect(out.status).toBe('verified');
      expect(mockVerifySignatureB64).toHaveBeenCalledWith('ed25519', 'a2V5', HASH, 'c2ln');
    });
  });

  it('fails closed for an unsupported producer DID method', async () => {
    respond(makeBody({ agent_id: 'did:example:producer' }));
    const out = await svc.verifyEvent(makeEvent({ agentId: 'did:example:producer' }));
    expect(out.status).toBe('invalid');
  });

  // ── parseKeyRevocation outcome ────────────────────────────────────────
  it('propagates a parseKeyRevocation rejection as invalid', async () => {
    respond(makeBody());
    mockParseKeyRevocation.mockReturnValue({ ok: false, code: 'schema_violation', reason: 'bad shape' });
    const out = await svc.verifyEvent(makeEvent());
    expect(out.status).toBe('invalid');
    expect(out.reason).toContain('schema_violation');
  });

  // ── §6 registry-binding policy (registry_attested only) ────────────────
  describe('registry_attested trust class', () => {
    beforeEach(() => {
      mockParseKeyRevocation.mockReturnValue({
        ok: true,
        revocation: { ...PARSED_REVOCATION, trustClass: 'registry_attested' },
      });
    });

    it('is unavailable when capabilities are unreadable (registryDid null)', async () => {
      respond(makeBody());
      profiles.registryCapabilities.mockResolvedValue({ registryDid: null, acdpVersion: null });
      const out = await svc.verifyEvent(makeEvent());
      expect(out.status).toBe('unavailable');
      expect(mockCrossCheckRegistryBinding).not.toHaveBeenCalled();
    });

    it.each(['same_registry', 'global', 'off'] as const)(
      'rejects when the §6 binding check fails, regardless of keyRevocationAttestedScope=%s',
      async (scope) => {
        config.keyRevocationAttestedScope = scope;
        respond(makeBody());
        profiles.registryCapabilities.mockResolvedValue({ registryDid: 'did:web:reg.example', acdpVersion: '0.3.0' });
        mockCrossCheckRegistryBinding.mockReturnValue({ ok: false, reason: 'binding mismatch' });
        const out = await svc.verifyEvent(makeEvent());
        expect(out.status).toBe('invalid');
        expect(out.reason).toBe('binding mismatch');
      },
    );

    it.each(['same_registry', 'global', 'off'] as const)(
      'persists on a binding PASS regardless of keyRevocationAttestedScope=%s',
      async (scope) => {
        config.keyRevocationAttestedScope = scope;
        respond(makeBody());
        profiles.registryCapabilities.mockResolvedValue({ registryDid: 'did:web:reg.example', acdpVersion: '0.3.0' });
        mockCrossCheckRegistryBinding.mockReturnValue({ ok: true });
        const out = await svc.verifyEvent(makeEvent());
        expect(out.status).toBe('verified');
        expect(out.trustClass).toBe('registry_attested');
      },
    );
  });

  // ── never throws ────────────────────────────────────────────────────────
  it('never throws — an unexpected crash becomes an unavailable outcome', async () => {
    // registryRepo.findByAuthority is awaited directly with no local
    // try/catch (unlike the federation fetch, which already classifies its
    // own failures) — the one path in this method genuinely exercising the
    // outer crash guard.
    registryRepo.findByAuthority.mockRejectedValue(new Error('unexpected boom'));
    const out = await svc.verifyEvent(makeEvent());
    expect(out.status).toBe('unavailable');
    expect(out.reason).toContain('audit crashed');
    expect(out.reason).toContain('unexpected boom');
  });

  describe('sweep', () => {
    it('persists a verified outcome and counts it with status + trust_class labels', async () => {
      revocationRepo.findCandidates.mockResolvedValue([makeEvent()]);
      respond(makeBody());
      const n = await svc.sweep();
      expect(n).toBe(1);
      expect(revocationRepo.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'default',
          ctxId: CTX,
          revokedKeyFingerprint: PARSED_REVOCATION.revokedKeyFingerprint,
          trustClass: 'producer_signed',
        }),
      );
      expect(instrumentation.keyRevocationChecksTotal.inc).toHaveBeenCalledWith({
        status: 'verified',
        trust_class: 'producer_signed',
      });
      expect(database.advisoryUnlock).toHaveBeenCalled();
    });

    it('does not persist an invalid or unavailable outcome', async () => {
      revocationRepo.findCandidates.mockResolvedValue([makeEvent()]);
      federationClient.get.mockRejectedValue(new FederationFetchError('SSRF', 'nope'));
      const n = await svc.sweep();
      expect(n).toBe(1);
      expect(revocationRepo.record).not.toHaveBeenCalled();
      expect(instrumentation.keyRevocationChecksTotal.inc).toHaveBeenCalledWith({
        status: 'invalid',
        trust_class: 'unknown',
      });
    });

    it('skips the pass when another instance holds the advisory lock', async () => {
      database.tryAdvisoryLock.mockResolvedValue(false);
      const n = await svc.sweep();
      expect(n).toBe(0);
      expect(revocationRepo.findCandidates).not.toHaveBeenCalled();
    });

    it('passes the KEY_REVOCATION_LOOKBACK_HOURS window to findCandidates', async () => {
      config.keyRevocationLookbackHours = 1;
      const before = Date.now();
      await svc.sweep();
      const [sinceIso] = revocationRepo.findCandidates.mock.calls[0];
      const sinceMs = Date.parse(sinceIso);
      expect(before - sinceMs).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1000);
      expect(before - sinceMs).toBeLessThan(60 * 60 * 1000 + 5000);
    });

    // ── §7 lineage walk wiring (Phase 13) ─────────────────────────────────
    describe('lineage walk', () => {
      const LINEAGE = 'lin:sha256:' + 'c'.repeat(64);
      const OTHER_CTX = 'acdp://reg.example/00000000-0000-4000-8000-000000000000';

      function mockFetch(contextBody: Record<string, unknown>, lineageMembers: Record<string, unknown>[] | null) {
        federationClient.get.mockImplementation(async (url: string) => {
          if (url.includes('/lineages/')) {
            if (lineageMembers === null) {
              return { status: 503, contentType: 'application/json', body: '' };
            }
            return {
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(lineageMembers.map((body) => ({ body, registry_state: { status: 'active' } }))),
            };
          }
          return { status: 200, contentType: 'application/json', body: JSON.stringify({ body: contextBody }) };
        });
      }

      it('walks a newly-verified event\'s lineage and persists every OTHER member it finds', async () => {
        revocationRepo.findCandidates.mockResolvedValue([makeEvent()]);
        const otherMember = makeBody({ ctx_id: OTHER_CTX, lineage_id: LINEAGE });
        mockFetch(makeBody({ lineage_id: LINEAGE }), [makeBody({ lineage_id: LINEAGE }), otherMember]);

        await svc.sweep();

        expect(federationClient.get).toHaveBeenCalledWith(expect.stringContaining(`/lineages/${encodeURIComponent(LINEAGE)}`));
        // Once via the per-event path, plus once per lineage member the walk
        // re-verifies (including the triggering ctx_id itself — the walk has
        // no reason to skip it; the real repository's onConflictDoNothing is
        // what makes the re-observation idempotent, not this call count).
        expect(revocationRepo.record).toHaveBeenCalledTimes(3);
        expect(revocationRepo.record).toHaveBeenCalledWith(expect.objectContaining({ ctxId: OTHER_CTX, lineageId: LINEAGE }));
        expect(revocationRepo.recordLineageWalk).toHaveBeenCalledWith('default', LINEAGE, AUTHORITY);
      });

      it('does not walk when the lineage already has facts and a fresh cursor', async () => {
        revocationRepo.findCandidates.mockResolvedValue([makeEvent()]);
        revocationRepo.countByLineage.mockResolvedValue(1);
        revocationRepo.findFreshLineageCursor.mockResolvedValue(true);
        mockFetch(makeBody({ lineage_id: LINEAGE }), [makeBody({ lineage_id: LINEAGE })]);

        await svc.sweep();

        expect(federationClient.get).not.toHaveBeenCalledWith(expect.stringContaining('/lineages/'));
        expect(revocationRepo.recordLineageWalk).not.toHaveBeenCalled();
      });

      it('walks anyway when facts exist but the cursor is stale — cursor freshness alone never suffices', async () => {
        revocationRepo.findCandidates.mockResolvedValue([makeEvent()]);
        revocationRepo.countByLineage.mockResolvedValue(1);
        revocationRepo.findFreshLineageCursor.mockResolvedValue(false);
        mockFetch(makeBody({ lineage_id: LINEAGE }), [makeBody({ lineage_id: LINEAGE })]);

        await svc.sweep();

        expect(revocationRepo.recordLineageWalk).toHaveBeenCalledWith('default', LINEAGE, AUTHORITY);
      });

      it('walks anyway when the cursor is fresh but zero facts are known for the lineage (the security control)', async () => {
        revocationRepo.findCandidates.mockResolvedValue([makeEvent()]);
        revocationRepo.countByLineage.mockResolvedValue(0);
        revocationRepo.findFreshLineageCursor.mockResolvedValue(true);
        mockFetch(makeBody({ lineage_id: LINEAGE }), [makeBody({ lineage_id: LINEAGE })]);

        await svc.sweep();

        // countByLineage is checked BEFORE cursor freshness is even consulted.
        expect(revocationRepo.findFreshLineageCursor).not.toHaveBeenCalled();
        expect(revocationRepo.recordLineageWalk).toHaveBeenCalledWith('default', LINEAGE, AUTHORITY);
      });

      it('does not record a cursor when the walk fails (leaves it unset so the next sweep retries)', async () => {
        revocationRepo.findCandidates.mockResolvedValue([makeEvent()]);
        mockFetch(makeBody({ lineage_id: LINEAGE }), null); // 503 on the lineage endpoint
        await svc.sweep();
        expect(revocationRepo.recordLineageWalk).not.toHaveBeenCalled();
        // The triggering event's own fact is still recorded — only the walk failed.
        expect(revocationRepo.record).toHaveBeenCalledTimes(1);
      });

      it('skips ALL lineage walks this pass when distinct lineages exceed MAX_LINEAGE_WALKS', async () => {
        const events = Array.from({ length: 101 }, (_, i) =>
          makeEvent({
            id: `11111111-1111-4111-8111-1111111111${String(i).padStart(2, '0')}`,
            ctxId: `acdp://reg.example/${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
            lineageId: `lin:sha256:${String(i).padStart(64, '0')}`,
          }),
        );
        revocationRepo.findCandidates.mockResolvedValue(events);
        federationClient.get.mockImplementation(async (url: string) => {
          if (url.includes('/lineages/')) throw new Error('lineage walk must not run this pass');
          const ctxId = decodeURIComponent(url.split('/contexts/')[1]);
          const idx8 = ctxId.split('/').pop()!.split('-')[0];
          const lineageId = `lin:sha256:${idx8.padStart(64, '0')}`;
          return {
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ body: makeBody({ ctx_id: ctxId, lineage_id: lineageId }) }),
          };
        });

        const n = await svc.sweep();

        expect(n).toBe(101);
        expect(revocationRepo.recordLineageWalk).not.toHaveBeenCalled();
        // The 101 triggering events' own facts are still recorded independently.
        expect(revocationRepo.record).toHaveBeenCalledTimes(101);
      });
    });

    // ── RFC-ACDP-0014 §7 retroactive re-audit fan-out (Phase 15) ──────────
    describe('retroactive re-audit fan-out', () => {
      it('calls reauditForFingerprint for every distinct known fingerprint, every pass', async () => {
        revocationRepo.distinctFingerprints.mockResolvedValue([
          { tenantId: 'default', fingerprint: 'sha256:' + 'e'.repeat(64) },
          { tenantId: 'tenant-b', fingerprint: 'sha256:' + 'f'.repeat(64) },
        ]);
        await svc.sweep();
        expect(receiptAuditService.reauditForFingerprint).toHaveBeenCalledWith(
          'default',
          'sha256:' + 'e'.repeat(64),
        );
        expect(receiptAuditService.reauditForFingerprint).toHaveBeenCalledWith(
          'tenant-b',
          'sha256:' + 'f'.repeat(64),
        );
        expect(receiptAuditService.reauditForFingerprint).toHaveBeenCalledTimes(2);
      });

      it('never runs the fan-out when KEY_REVOCATION_CHECK_ENABLED is off', async () => {
        config.keyRevocationCheckEnabled = false;
        revocationRepo.distinctFingerprints.mockResolvedValue([
          { tenantId: 'default', fingerprint: 'sha256:' + 'e'.repeat(64) },
        ]);
        await svc.sweep();
        expect(revocationRepo.distinctFingerprints).not.toHaveBeenCalled();
        expect(receiptAuditService.reauditForFingerprint).not.toHaveBeenCalled();
      });

      it('logs and continues past one fingerprint whose re-audit throws, rather than aborting the sweep', async () => {
        revocationRepo.distinctFingerprints.mockResolvedValue([
          { tenantId: 'default', fingerprint: 'sha256:' + 'e'.repeat(64) },
          { tenantId: 'default', fingerprint: 'sha256:' + 'f'.repeat(64) },
        ]);
        receiptAuditService.reauditForFingerprint
          .mockRejectedValueOnce(new Error('boom'))
          .mockResolvedValueOnce(1);
        await expect(svc.sweep()).resolves.toBeDefined();
        expect(receiptAuditService.reauditForFingerprint).toHaveBeenCalledTimes(2);
        expect(database.advisoryUnlock).toHaveBeenCalled();
      });
    });
  });

  describe('onModuleInit', () => {
    it('does nothing when disabled', () => {
      config.keyRevocationCheckEnabled = false;
      svc.onModuleInit();
      expect(federationClient.get).not.toHaveBeenCalled();
      svc.onModuleDestroy();
    });
  });
});
