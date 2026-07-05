/**
 * CheckpointWitnessPollerService state machine (RFC-ACDP-0012).
 *
 * HTTP and repositories are mocked; the CRYPTO IS REAL — checkpoints are
 * built over real RFC 6962 trees and signed with a real Ed25519 keypair, so
 * these tests exercise the production §6/§9 verification end-to-end:
 *   - first checkpoint (nothing to compare — consistency NULL, cursor set)
 *   - happy consistency advance
 *   - root rewrite → consistency fails → evidence + alert + cursor holds
 *   - checkpoint signature failure
 *   - tree-size regression
 *   - log_id change (explicit §7.4 reset)
 *   - same-size root mismatch (split view)
 *   - per-registry isolation (one crash doesn't stall the sweep)
 *   - environmental failure → consecutive_failures, no alert, cursor holds
 *   - alert emission gated on the state TRANSITION (no re-spam)
 */
import { createHash, generateKeyPairSync, sign as edSign, KeyObject } from 'node:crypto';
import {
  CheckpointWitnessPollerService,
  LOG_WITNESS_ALERT_EVENT,
} from './checkpoint-witness.service';
import { checkpointHash, leafHash, LogCheckpoint, nodeHash } from './log-verify';

const AUTHORITY = 'reg-a.example';
const BASE = `https://${AUTHORITY}`;
const LOG_ID = `did:web:${AUTHORITY}/log/1`;
const TENANT = 'default';

// ── RFC 6962 reference generator (same as log-verify.spec) ───────────────

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
function consistencyProof(m: number, hashes: Buffer[]): Buffer[] {
  function subproof(m2: number, d: Buffer[], b: boolean): Buffer[] {
    if (m2 === d.length) return b ? [] : [mth(d)];
    const k = split(d.length);
    if (m2 <= k) return [...subproof(m2, d.slice(0, k), b), mth(d.slice(k))];
    return [...subproof(m2 - k, d.slice(k), false), mth(d.slice(0, k))];
  }
  return subproof(m, hashes, true);
}
const wire = (b: Buffer) => `sha256:${b.toString('hex')}`;
function makeLeafHashes(n: number, salt = ''): Buffer[] {
  return Array.from({ length: n }, (_, i) => {
    const h = leafHash({ leaf_version: 'acdp-log-leaf/1', ctx_id: `acdp://${AUTHORITY}/c${salt}${i}` });
    if (h === null) throw new Error('leaf hash failed');
    return h;
  });
}

// ── Ed25519 registry receipt key ─────────────────────────────────────────

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
const PUB_B64 = spki.subarray(spki.length - 32).toString('base64');

function signCheckpoint(
  key: KeyObject,
  fields: Partial<Omit<LogCheckpoint, 'signature'>> & { keyId?: string },
): LogCheckpoint {
  const { keyId, ...rest } = fields;
  const cp = {
    checkpoint_version: 'acdp-log/1',
    log_id: LOG_ID,
    tree_size: 0,
    root_hash: wire(mth([])),
    timestamp: new Date(Date.now() - 1000).toISOString(),
    ...rest,
    signature: {
      algorithm: 'ed25519',
      key_id: keyId ?? `did:web:${AUTHORITY}#receipt-key-1`,
      value: '',
    },
  } as LogCheckpoint;
  const hash = checkpointHash(cp)!;
  cp.signature.value = edSign(null, Buffer.from(hash, 'ascii'), key).toString('base64');
  return cp;
}

// ── Harness ──────────────────────────────────────────────────────────────

interface Harness {
  svc: CheckpointWitnessPollerService;
  witnessRepo: any;
  federationClient: any;
  streamHub: any;
  webhookService: any;
  instrumentation: any;
  profiles: any;
  enrollmentRepo: any;
  didResolver: any;
}

function makeHarness(overrides: Partial<Record<string, any>> = {}): Harness {
  const config = {
    logWitnessEnabled: true,
    logWitnessIntervalSeconds: 300,
    logWitnessExcludeAuthorities: [] as string[],
    ...overrides.config,
  };
  const database = {
    tryAdvisoryLock: jest.fn().mockResolvedValue(true),
    advisoryUnlock: jest.fn().mockResolvedValue(undefined),
  };
  const witnessRepo = {
    getCursor: jest.fn().mockResolvedValue(null),
    recordCheckpoint: jest.fn().mockResolvedValue({}),
    advanceCursor: jest.fn().mockResolvedValue(undefined),
    markAlert: jest.fn().mockResolvedValue({ wasAlerted: false, previousReason: null }),
    markFailure: jest.fn().mockResolvedValue(undefined),
  };
  const enrollmentRepo = {
    listAllEnabled: jest
      .fn()
      .mockResolvedValue([{ authority: AUTHORITY, tenantId: TENANT, baseUrl: BASE, enabled: true }]),
  };
  const registryRepo = { findByAuthority: jest.fn().mockResolvedValue(null) };
  const profiles = { advertisesTransparencyLog: jest.fn().mockResolvedValue(true) };
  const federationClient = { get: jest.fn() };
  const didResolver = {
    resolveReceiptKey: jest.fn().mockResolvedValue({ publicKeyB64: PUB_B64, historical: false }),
  };
  const instrumentation = {
    logWitnessChecksTotal: { inc: jest.fn() },
    logWitnessAlertsTotal: { inc: jest.fn() },
  };
  const streamHub = { publishGlobal: jest.fn() };
  const webhookService = { fireEvent: jest.fn().mockResolvedValue(undefined) };

  const svc = new CheckpointWitnessPollerService(
    config as never,
    database as never,
    witnessRepo as never,
    enrollmentRepo as never,
    registryRepo as never,
    profiles as never,
    federationClient as never,
    didResolver as never,
    instrumentation as never,
    streamHub as never,
    webhookService as never,
  );
  return {
    svc,
    witnessRepo,
    federationClient,
    streamHub,
    webhookService,
    instrumentation,
    profiles,
    enrollmentRepo,
    didResolver,
  };
}

/** Route mocked GETs by URL. */
function routeFetch(h: Harness, routes: Record<string, { status: number; body: string }>) {
  h.federationClient.get.mockImplementation((url: string) => {
    const hit = routes[url];
    if (!hit) return Promise.reject(new Error(`unexpected fetch ${url}`));
    return Promise.resolve({ status: hit.status, contentType: 'application/acdp+json', body: hit.body });
  });
}

function cursorAt(logId: string, size: number, root: string) {
  return {
    registryAuthority: AUTHORITY,
    tenantId: TENANT,
    logId,
    lastWitnessedSize: size,
    lastRootHash: root,
    consecutiveFailures: 0,
    alerted: false,
    lastAlertReason: null,
  };
}

describe('CheckpointWitnessPollerService', () => {
  it('first checkpoint: witnessed, consistency NULL, cursor set', async () => {
    const h = makeHarness();
    const leaves = makeLeafHashes(3);
    const cp = signCheckpoint(privateKey, { tree_size: 3, root_hash: wire(mth(leaves)) });
    routeFetch(h, { [`${BASE}/log/checkpoint`]: { status: 200, body: JSON.stringify(cp) } });

    const outcomes = await h.svc.sweep();
    expect(outcomes).toEqual([{ authority: AUTHORITY, status: 'witnessed' }]);
    expect(h.witnessRepo.recordCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ treeSize: 3, signatureValid: true, consistencyOk: null }),
    );
    expect(h.witnessRepo.advanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({ logId: LOG_ID, treeSize: 3, rootHash: wire(mth(leaves)) }),
    );
    expect(h.witnessRepo.markAlert).not.toHaveBeenCalled();
  });

  it('happy growth: valid consistency proof advances the cursor', async () => {
    const h = makeHarness();
    const leaves = makeLeafHashes(5);
    const prevRoot = wire(mth(leaves.slice(0, 3)));
    h.witnessRepo.getCursor.mockResolvedValue(cursorAt(LOG_ID, 3, prevRoot));
    const cp = signCheckpoint(privateKey, { tree_size: 5, root_hash: wire(mth(leaves)) });
    routeFetch(h, {
      [`${BASE}/log/checkpoint`]: { status: 200, body: JSON.stringify(cp) },
      [`${BASE}/log/proof?first=3&second=5`]: {
        status: 200,
        body: JSON.stringify({
          log_id: LOG_ID,
          first_tree_size: 3,
          second_tree_size: 5,
          consistency_path: consistencyProof(3, leaves).map(wire),
          log_checkpoint: cp,
        }),
      },
    });

    const outcomes = await h.svc.sweep();
    expect(outcomes).toEqual([{ authority: AUTHORITY, status: 'witnessed' }]);
    expect(h.witnessRepo.recordCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ treeSize: 5, signatureValid: true, consistencyOk: true }),
    );
    expect(h.witnessRepo.advanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({ treeSize: 5 }),
    );
    expect(h.witnessRepo.markAlert).not.toHaveBeenCalled();
  });

  it('ROOT REWRITE: failing consistency persists the evidence pair, alerts, and holds the cursor', async () => {
    const h = makeHarness();
    // The witness retained the HONEST size-3 root…
    const honestRoot = wire(mth(makeLeafHashes(3)));
    h.witnessRepo.getCursor.mockResolvedValue(cursorAt(LOG_ID, 3, honestRoot));
    // …but the registry rewrote history and now serves a different tree.
    const evil = makeLeafHashes(5, 'evil-');
    const cp = signCheckpoint(privateKey, { tree_size: 5, root_hash: wire(mth(evil)) });
    routeFetch(h, {
      [`${BASE}/log/checkpoint`]: { status: 200, body: JSON.stringify(cp) },
      [`${BASE}/log/proof?first=3&second=5`]: {
        status: 200,
        body: JSON.stringify({
          log_id: LOG_ID,
          first_tree_size: 3,
          second_tree_size: 5,
          consistency_path: consistencyProof(3, evil).map(wire),
          log_checkpoint: cp,
        }),
      },
    });

    const outcomes = await h.svc.sweep();
    expect(outcomes).toEqual([
      { authority: AUTHORITY, status: 'alert', reason: 'consistency_failed' },
    ]);
    // Evidence: the offending signed checkpoint row, consistency_ok=false…
    expect(h.witnessRepo.recordCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ treeSize: 5, signatureValid: true, consistencyOk: false }),
    );
    // …the alert detail carries the retained pre-rewrite head + failing path…
    expect(h.witnessRepo.markAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'consistency_failed',
        detail: expect.objectContaining({
          previous: expect.objectContaining({ tree_size: 3, root_hash: honestRoot }),
          consistency_path: expect.any(Array),
        }),
      }),
    );
    // …the cursor's retained head is NOT advanced…
    expect(h.witnessRepo.advanceCursor).not.toHaveBeenCalled();
    // …and the alert is counted + emitted (SSE + outbound webhook).
    expect(h.instrumentation.logWitnessAlertsTotal.inc).toHaveBeenCalledWith({
      reason: 'consistency_failed',
    });
    expect(h.streamHub.publishGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ type: LOG_WITNESS_ALERT_EVENT, reason: 'consistency_failed' }),
      TENANT,
    );
    expect(h.webhookService.fireEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: LOG_WITNESS_ALERT_EVENT }),
      TENANT,
    );
  });

  it('refusing the REQUIRED consistency proof is itself the consistency_failed evidence', async () => {
    const h = makeHarness();
    const honestRoot = wire(mth(makeLeafHashes(3)));
    h.witnessRepo.getCursor.mockResolvedValue(cursorAt(LOG_ID, 3, honestRoot));
    const cp = signCheckpoint(privateKey, { tree_size: 5, root_hash: wire(mth(makeLeafHashes(5))) });
    routeFetch(h, {
      [`${BASE}/log/checkpoint`]: { status: 200, body: JSON.stringify(cp) },
      [`${BASE}/log/proof?first=3&second=5`]: { status: 404, body: '{}' },
    });

    const outcomes = await h.svc.sweep();
    expect(outcomes).toEqual([
      { authority: AUTHORITY, status: 'alert', reason: 'consistency_failed' },
    ]);
    expect(h.witnessRepo.advanceCursor).not.toHaveBeenCalled();
  });

  it('signature failure: alert + evidence row with signature_valid=false, cursor holds', async () => {
    const h = makeHarness();
    h.witnessRepo.getCursor.mockResolvedValue(
      cursorAt(LOG_ID, 3, wire(mth(makeLeafHashes(3)))),
    );
    const cp = signCheckpoint(privateKey, { tree_size: 5, root_hash: wire(mth(makeLeafHashes(5))) });
    // Tamper AFTER signing — the signature no longer covers root_hash.
    const tampered = { ...cp, root_hash: wire(sha256(Buffer.from('tampered'))) };
    routeFetch(h, { [`${BASE}/log/checkpoint`]: { status: 200, body: JSON.stringify(tampered) } });

    const outcomes = await h.svc.sweep();
    expect(outcomes).toEqual([
      { authority: AUTHORITY, status: 'alert', reason: 'checkpoint_signature_invalid' },
    ]);
    expect(h.witnessRepo.recordCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ signatureValid: false }),
    );
    expect(h.witnessRepo.advanceCursor).not.toHaveBeenCalled();
  });

  it('tree_size regression: alert, cursor holds', async () => {
    const h = makeHarness();
    h.witnessRepo.getCursor.mockResolvedValue(
      cursorAt(LOG_ID, 5, wire(mth(makeLeafHashes(5)))),
    );
    const cp = signCheckpoint(privateKey, { tree_size: 3, root_hash: wire(mth(makeLeafHashes(3))) });
    routeFetch(h, { [`${BASE}/log/checkpoint`]: { status: 200, body: JSON.stringify(cp) } });

    const outcomes = await h.svc.sweep();
    expect(outcomes).toEqual([
      { authority: AUTHORITY, status: 'alert', reason: 'tree_size_regression' },
    ]);
    expect(h.witnessRepo.advanceCursor).not.toHaveBeenCalled();
  });

  it('log_id change: the §7.4 reset is loud', async () => {
    const h = makeHarness();
    h.witnessRepo.getCursor.mockResolvedValue(
      cursorAt(LOG_ID, 3, wire(mth(makeLeafHashes(3)))),
    );
    const cp = signCheckpoint(privateKey, {
      log_id: `did:web:${AUTHORITY}/log/2`,
      tree_size: 1,
      root_hash: wire(mth(makeLeafHashes(1))),
    });
    routeFetch(h, { [`${BASE}/log/checkpoint`]: { status: 200, body: JSON.stringify(cp) } });

    const outcomes = await h.svc.sweep();
    expect(outcomes).toEqual([{ authority: AUTHORITY, status: 'alert', reason: 'log_id_changed' }]);
    expect(h.witnessRepo.advanceCursor).not.toHaveBeenCalled();
  });

  it('same tree_size, different root: split-view alert', async () => {
    const h = makeHarness();
    h.witnessRepo.getCursor.mockResolvedValue(
      cursorAt(LOG_ID, 3, wire(mth(makeLeafHashes(3)))),
    );
    const cp = signCheckpoint(privateKey, {
      tree_size: 3,
      root_hash: wire(mth(makeLeafHashes(3, 'other-'))),
    });
    routeFetch(h, { [`${BASE}/log/checkpoint`]: { status: 200, body: JSON.stringify(cp) } });

    const outcomes = await h.svc.sweep();
    expect(outcomes).toEqual([{ authority: AUTHORITY, status: 'alert', reason: 'root_mismatch' }]);
    expect(h.witnessRepo.recordCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ consistencyOk: false }),
    );
  });

  it('foreign-key / foreign-log binding is rejected (§9.3 step 3)', async () => {
    const h = makeHarness();
    const cp = signCheckpoint(privateKey, {
      tree_size: 1,
      root_hash: wire(mth(makeLeafHashes(1))),
      keyId: 'did:web:evil.example#receipt-key-1',
    });
    routeFetch(h, { [`${BASE}/log/checkpoint`]: { status: 200, body: JSON.stringify(cp) } });

    const outcomes = await h.svc.sweep();
    expect(outcomes).toEqual([
      { authority: AUTHORITY, status: 'alert', reason: 'checkpoint_invalid' },
    ]);
  });

  it('environmental fetch failure: consecutive_failures bumps, NO alert, cursor holds', async () => {
    const h = makeHarness();
    h.federationClient.get.mockRejectedValue(new Error('ECONNREFUSED'));

    const outcomes = await h.svc.sweep();
    expect(outcomes[0]!.status).toBe('error');
    expect(h.witnessRepo.markFailure).toHaveBeenCalledWith(TENANT, AUTHORITY);
    expect(h.witnessRepo.markAlert).not.toHaveBeenCalled();
    expect(h.witnessRepo.advanceCursor).not.toHaveBeenCalled();
    expect(h.streamHub.publishGlobal).not.toHaveBeenCalled();
  });

  it('DID resolution failure is environmental, not an alert', async () => {
    const h = makeHarness();
    h.didResolver.resolveReceiptKey.mockRejectedValue(new Error('did doc unreachable'));
    const cp = signCheckpoint(privateKey, { tree_size: 1, root_hash: wire(mth(makeLeafHashes(1))) });
    routeFetch(h, { [`${BASE}/log/checkpoint`]: { status: 200, body: JSON.stringify(cp) } });

    const outcomes = await h.svc.sweep();
    expect(outcomes[0]!.status).toBe('error');
    expect(h.witnessRepo.markAlert).not.toHaveBeenCalled();
  });

  it('skips registries that do not advertise the profile (and unreachable capabilities)', async () => {
    const h = makeHarness();
    h.profiles.advertisesTransparencyLog.mockResolvedValue(false);
    let outcomes = await h.svc.sweep();
    expect(outcomes[0]!.status).toBe('skipped');

    h.profiles.advertisesTransparencyLog.mockResolvedValue(null);
    outcomes = await h.svc.sweep();
    expect(outcomes[0]!.status).toBe('skipped');
    expect(h.federationClient.get).not.toHaveBeenCalled();
  });

  it('honors the per-registry opt-out', async () => {
    const h = makeHarness({ config: { logWitnessExcludeAuthorities: [AUTHORITY] } });
    const outcomes = await h.svc.sweep();
    expect(outcomes[0]).toEqual(
      expect.objectContaining({ authority: AUTHORITY, status: 'skipped' }),
    );
    expect(h.profiles.advertisesTransparencyLog).not.toHaveBeenCalled();
  });

  it('per-registry isolation: a crashing registry does not stall the next one', async () => {
    const h = makeHarness();
    const OTHER = 'reg-b.example';
    h.enrollmentRepo.listAllEnabled.mockResolvedValue([
      { authority: AUTHORITY, tenantId: TENANT, baseUrl: BASE, enabled: true },
      { authority: OTHER, tenantId: TENANT, baseUrl: `https://${OTHER}`, enabled: true },
    ]);
    // First registry's profile probe crashes hard (not a rejection — a throw
    // deeper in the pass); second serves a clean first checkpoint.
    h.profiles.advertisesTransparencyLog.mockImplementation((authority: string) => {
      if (authority === AUTHORITY) throw new Error('boom');
      return Promise.resolve(true);
    });
    const cpB = signCheckpoint(privateKey, {
      log_id: `did:web:${OTHER}/log/1`,
      tree_size: 1,
      root_hash: wire(mth(makeLeafHashes(1))),
      keyId: `did:web:${OTHER}#receipt-key-1`,
    });
    routeFetch(h, {
      [`https://${OTHER}/log/checkpoint`]: { status: 200, body: JSON.stringify(cpB) },
    });

    const outcomes = await h.svc.sweep();
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]!.status).toBe('error');
    expect(outcomes[1]).toEqual({ authority: OTHER, status: 'witnessed' });
  });

  it('emission is transition-gated: a persisting alert does not re-spam SSE/webhooks', async () => {
    const h = makeHarness();
    h.witnessRepo.getCursor.mockResolvedValue(
      cursorAt(LOG_ID, 5, wire(mth(makeLeafHashes(5)))),
    );
    // Already alerted with the same reason.
    h.witnessRepo.markAlert.mockResolvedValue({
      wasAlerted: true,
      previousReason: 'tree_size_regression',
    });
    const cp = signCheckpoint(privateKey, { tree_size: 3, root_hash: wire(mth(makeLeafHashes(3))) });
    routeFetch(h, { [`${BASE}/log/checkpoint`]: { status: 200, body: JSON.stringify(cp) } });

    const outcomes = await h.svc.sweep();
    expect(outcomes[0]!.status).toBe('alert');
    // Metric still counts every detection…
    expect(h.instrumentation.logWitnessAlertsTotal.inc).toHaveBeenCalled();
    // …but no fresh SSE / webhook emission on the unchanged state.
    expect(h.streamHub.publishGlobal).not.toHaveBeenCalled();
    expect(h.webhookService.fireEvent).not.toHaveBeenCalled();
  });

  it('does nothing when another instance holds the advisory lock', async () => {
    const h = makeHarness();
    (h.svc as any).database.tryAdvisoryLock = jest.fn().mockResolvedValue(false);
    const outcomes = await h.svc.sweep();
    expect(outcomes).toEqual([]);
    expect(h.enrollmentRepo.listAllEnabled).not.toHaveBeenCalled();
  });
});
