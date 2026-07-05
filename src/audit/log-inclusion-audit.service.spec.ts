/**
 * LogInclusionAuditService — receipt ↔ log inclusion cross-check
 * (RFC-ACDP-0012 §9.1). HTTP and repositories are mocked; the crypto is
 * real: the "registry" in these tests operates an actual RFC 6962 tree
 * whose leaf 0 IS the audited event's receipt (built with the production
 * §4 leaf construction), and its checkpoints are Ed25519-signed.
 */
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { LogInclusionAuditService } from './log-inclusion-audit.service';
import { buildLogLeaf, checkpointHash, leafHash, LogCheckpoint, nodeHash } from './log-verify';
import { ContextEvent } from '../db/schema';

const AUTHORITY = 'reg-a.example';
const BASE = `https://${AUTHORITY}`;
const LOG_ID = `did:web:${AUTHORITY}/log/1`;
const CTX = `acdp://${AUTHORITY}/ctx-001`;

// ── RFC 6962 reference generator ─────────────────────────────────────────

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}
function mth(hashes: Buffer[]): Buffer {
  if (hashes.length === 0) return sha256(Buffer.alloc(0));
  if (hashes.length === 1) return hashes[0]!;
  const k = split(hashes.length);
  return nodeHash(mth(hashes.slice(0, k)), mth(hashes.slice(k)));
}
function auditPath(m: number, hashes: Buffer[]): Buffer[] {
  if (hashes.length <= 1) return [];
  const n = hashes.length;
  const k = split(n);
  if (m < k) return [...auditPath(m, hashes.slice(0, k)), mth(hashes.slice(k))];
  return [...auditPath(m - k, hashes.slice(k)), mth(hashes.slice(0, k))];
}
const wire = (b: Buffer) => `sha256:${b.toString('hex')}`;

// ── Registry fixture: a real tree whose leaf 0 is the audited receipt ────

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
const PUB_B64 = spki.subarray(spki.length - 32).toString('base64');

const receipt = {
  registry_did: `did:web:${AUTHORITY}`,
  ctx_id: CTX,
  lineage_id: 'lin-001',
  origin_registry: AUTHORITY,
  created_at: '2026-07-01T00:00:00.000Z',
  content_hash: 'sha256:' + 'a'.repeat(64),
  key_fingerprint: 'sha256:' + 'b'.repeat(64),
  signature: {
    algorithm: 'ed25519',
    key_id: `did:web:${AUTHORITY}#receipt-key-1`,
    value: 'c2ln',
  },
};

function registryTree(): Buffer[] {
  const built = buildLogLeaf(receipt);
  if (!built.ok) throw new Error(built.reason);
  const leaf0 = leafHash(built.leaf);
  if (leaf0 === null) throw new Error('leaf hash failed');
  const others = Array.from({ length: 4 }, (_, i) => {
    const h = leafHash({ leaf_version: 'acdp-log-leaf/1', ctx_id: `acdp://${AUTHORITY}/other-${i}` });
    if (h === null) throw new Error('leaf hash failed');
    return h;
  });
  return [leaf0, ...others];
}

function signCheckpoint(fields: Partial<Omit<LogCheckpoint, 'signature'>>): LogCheckpoint {
  const cp = {
    checkpoint_version: 'acdp-log/1',
    log_id: LOG_ID,
    tree_size: 0,
    root_hash: wire(mth([])),
    timestamp: new Date(Date.now() - 1000).toISOString(),
    ...fields,
    signature: {
      algorithm: 'ed25519',
      key_id: `did:web:${AUTHORITY}#receipt-key-1`,
      value: '',
    },
  } as LogCheckpoint;
  const hash = checkpointHash(cp)!;
  cp.signature.value = edSign(null, Buffer.from(hash, 'ascii'), privateKey).toString('base64');
  return cp;
}

function inclusionResponse(tamper?: (proof: Record<string, unknown>) => void) {
  const leaves = registryTree();
  const cp = signCheckpoint({ tree_size: 5, root_hash: wire(mth(leaves)) });
  const proof: Record<string, unknown> = {
    log_id: LOG_ID,
    leaf_index: 0,
    tree_size: 5,
    inclusion_path: auditPath(0, leaves).map(wire),
    log_checkpoint: cp,
  };
  if (tamper) tamper(proof);
  return proof;
}

function makeEvent(overrides: Partial<ContextEvent> = {}): ContextEvent {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    tenantId: 'default',
    eventType: 'context_published',
    eventTs: '2026-07-01T00:00:00.000Z',
    runId: 'run-1',
    ctxId: CTX,
    lineageId: 'lin-001',
    agentId: 'did:web:agent.example',
    contextType: 'analysis',
    visibility: 'public',
    version: 1,
    derivedFrom: [],
    registryAuthority: AUTHORITY,
    scenarioId: null,
    fingerprint: 'evt:x',
    keyFingerprint: receipt.key_fingerprint,
    receiptPresent: true,
    rawPayload: { type: 'context_published', registry_receipt: receipt },
    createdAt: '2026-07-01T00:00:05.000Z',
    ...overrides,
  } as ContextEvent;
}

// ── Harness ──────────────────────────────────────────────────────────────

function makeHarness() {
  const config = {
    logInclusionAuditEnabled: true,
    logInclusionAuditIntervalSeconds: 300,
    logInclusionAuditBatchSize: 50,
    logInclusionAuditLookbackHours: 24,
  };
  const database = {
    tryAdvisoryLock: jest.fn().mockResolvedValue(true),
    advisoryUnlock: jest.fn().mockResolvedValue(undefined),
  };
  const auditRepo = {
    findUnauditedReceiptPublishes: jest.fn().mockResolvedValue([]),
    record: jest.fn().mockResolvedValue({}),
  };
  const witnessRepo = { findByLogIdAndSize: jest.fn().mockResolvedValue(null) };
  const registryRepo = {
    findByAuthority: jest.fn().mockResolvedValue({ authority: AUTHORITY, baseUrl: BASE }),
  };
  const profiles = { advertisesTransparencyLog: jest.fn().mockResolvedValue(true) };
  const federationClient = { get: jest.fn() };
  const didResolver = {
    resolveReceiptKey: jest.fn().mockResolvedValue({ publicKeyB64: PUB_B64, historical: false }),
  };
  const instrumentation = { logInclusionAuditsTotal: { inc: jest.fn() } };

  const svc = new LogInclusionAuditService(
    config as never,
    database as never,
    auditRepo as never,
    witnessRepo as never,
    registryRepo as never,
    profiles as never,
    federationClient as never,
    didResolver as never,
    instrumentation as never,
  );
  return { svc, auditRepo, witnessRepo, registryRepo, profiles, federationClient, instrumentation };
}

describe('LogInclusionAuditService', () => {
  it('verifies a genuine inclusion proof end-to-end → included', async () => {
    const h = makeHarness();
    h.federationClient.get.mockResolvedValue({
      status: 200,
      contentType: 'application/acdp+json',
      body: JSON.stringify(inclusionResponse()),
    });

    const verdict = await h.svc.auditEvent(makeEvent());
    expect(verdict).toEqual({
      status: 'included',
      detail: [],
      logId: LOG_ID,
      leafIndex: 0,
      treeSize: 5,
    });
    expect(h.federationClient.get).toHaveBeenCalledWith(
      `${BASE}/log/proof?ctx_id=${encodeURIComponent(CTX)}`,
    );
  });

  it('a tampered inclusion path fails as invalid_proof (INVALID_LOG_PROOF)', async () => {
    const h = makeHarness();
    h.federationClient.get.mockResolvedValue({
      status: 200,
      contentType: 'application/acdp+json',
      body: JSON.stringify(
        inclusionResponse((proof) => {
          (proof.inclusion_path as string[])[0] = 'sha256:' + 'f'.repeat(64);
        }),
      ),
    });

    const verdict = await h.svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('invalid_proof');
    expect(verdict.detail.join(' ')).toContain('INVALID_LOG_PROOF');
  });

  it('a receipt the leaf disagrees with fails the fold (leaf reconstructed from OUR receipt)', async () => {
    const h = makeHarness();
    // The registry's tree binds the honest receipt, but the event we hold
    // carries a receipt with a different created_at → our reconstructed leaf
    // hashes differently → the audit path cannot reach the root.
    h.federationClient.get.mockResolvedValue({
      status: 200,
      contentType: 'application/acdp+json',
      body: JSON.stringify(inclusionResponse()),
    });
    const ev = makeEvent({
      rawPayload: {
        type: 'context_published',
        registry_receipt: { ...receipt, created_at: '2026-06-01T00:00:00.000Z' },
      },
    });

    const verdict = await h.svc.auditEvent(ev);
    expect(verdict.status).toBe('invalid_proof');
  });

  it('a checkpoint diverging from the witnessed root at the same size is split-view evidence', async () => {
    const h = makeHarness();
    h.witnessRepo.findByLogIdAndSize.mockResolvedValue({
      logId: LOG_ID,
      treeSize: 5,
      rootHash: 'sha256:' + 'd'.repeat(64), // what OUR witness saw
    });
    h.federationClient.get.mockResolvedValue({
      status: 200,
      contentType: 'application/acdp+json',
      body: JSON.stringify(inclusionResponse()),
    });

    const verdict = await h.svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('invalid_proof');
    expect(verdict.detail.join(' ')).toContain('split-view');
  });

  it('404 for a receipt-bearing ctx_id is the §3 omission evidence → not_logged', async () => {
    const h = makeHarness();
    h.federationClient.get.mockResolvedValue({ status: 404, contentType: null, body: '{}' });

    const verdict = await h.svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('not_logged');
    expect(verdict.detail.join(' ')).toContain('omission');
  });

  it('a checkpoint signature failure inside the proof is invalid_proof', async () => {
    const h = makeHarness();
    h.federationClient.get.mockResolvedValue({
      status: 200,
      contentType: 'application/acdp+json',
      body: JSON.stringify(
        inclusionResponse((proof) => {
          const cp = proof.log_checkpoint as LogCheckpoint;
          cp.root_hash = 'sha256:' + 'e'.repeat(64); // tamper after signing
          // keep proof.tree_size aligned so the SIGNATURE is what fails
        }),
      ),
    });

    const verdict = await h.svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('invalid_proof');
    expect(verdict.detail.join(' ')).toContain('signature');
  });

  it('registry without the profile → no_log; unreadable capabilities → error', async () => {
    const h = makeHarness();
    h.profiles.advertisesTransparencyLog.mockResolvedValue(false);
    expect((await h.svc.auditEvent(makeEvent())).status).toBe('no_log');

    h.profiles.advertisesTransparencyLog.mockResolvedValue(null);
    expect((await h.svc.auditEvent(makeEvent())).status).toBe('error');
  });

  it('transport failure → error (environmental, no flag)', async () => {
    const h = makeHarness();
    h.federationClient.get.mockRejectedValue(new Error('ECONNREFUSED'));
    const verdict = await h.svc.auditEvent(makeEvent());
    expect(verdict.status).toBe('error');
    expect(verdict.detail.join(' ')).toContain('unverified');
  });

  it('sweep records one sealed verdict per event and counts the metric', async () => {
    const h = makeHarness();
    h.auditRepo.findUnauditedReceiptPublishes.mockResolvedValue([makeEvent()]);
    h.federationClient.get.mockResolvedValue({
      status: 200,
      contentType: 'application/acdp+json',
      body: JSON.stringify(inclusionResponse()),
    });

    const n = await h.svc.sweep();
    expect(n).toBe(1);
    expect(h.auditRepo.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: '22222222-2222-4222-8222-222222222222',
        status: 'included',
        logId: LOG_ID,
        leafIndex: 0,
        treeSize: 5,
      }),
    );
    expect(h.instrumentation.logInclusionAuditsTotal.inc).toHaveBeenCalledWith({
      status: 'included',
    });
  });

  it('sweep is a no-op when another instance holds the advisory lock', async () => {
    const h = makeHarness();
    (h.svc as any).database.tryAdvisoryLock = jest.fn().mockResolvedValue(false);
    expect(await h.svc.sweep()).toBe(0);
    expect(h.auditRepo.findUnauditedReceiptPublishes).not.toHaveBeenCalled();
  });
});
