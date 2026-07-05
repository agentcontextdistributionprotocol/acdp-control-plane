/**
 * RFC-ACDP-0012 §5/§6/§9 verification arithmetic.
 *
 * The proof fixtures are generated in-test by an independent RFC 6962
 * reference implementation (recursive MTH / PATH / SUBPROOF, transcribed
 * from RFC 6962 §2.1) and verified with the production fold algorithms —
 * the same generator-vs-verifier cross-check the spec's own conformance
 * generator performs for all tree sizes ≤ 8 and all proof indexes.
 * Checkpoint signatures use a real Ed25519 keypair (node:crypto) verified
 * through the SDK's `AcdpVerifier` path.
 */
import { createHash, generateKeyPairSync, sign as edSign, KeyObject } from 'node:crypto';
import {
  buildLogLeaf,
  checkpointHash,
  checkpointTimestampOk,
  leafHash,
  LogCheckpoint,
  logIdRegistryDid,
  nodeHash,
  parseCheckpoint,
  parseConsistencyProof,
  parseInclusionProof,
  verifyCheckpointSignature,
  verifyConsistencyPath,
  verifyInclusionPath,
  wireHashToBuf,
} from './log-verify';

// ── RFC 6962 reference implementation (test-only generator) ─────────────

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

/** Largest power of two STRICTLY less than n (n >= 2). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** RFC 6962 §2.1 MTH over already-computed leaf hashes. */
function mth(hashes: Buffer[]): Buffer {
  if (hashes.length === 0) return sha256(Buffer.alloc(0));
  if (hashes.length === 1) return hashes[0]!;
  const k = split(hashes.length);
  return nodeHash(mth(hashes.slice(0, k)), mth(hashes.slice(k)));
}

/** RFC 6962 §2.1.1 PATH(m, D[n]). */
function auditPath(m: number, hashes: Buffer[]): Buffer[] {
  if (hashes.length <= 1) return [];
  const n = hashes.length;
  const k = split(n);
  if (m < k) return [...auditPath(m, hashes.slice(0, k)), mth(hashes.slice(k))];
  return [...auditPath(m - k, hashes.slice(k)), mth(hashes.slice(0, k))];
}

/** RFC 6962 §2.1.2 PROOF(m, D[n]) = SUBPROOF(m, D[n], true). */
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

/** Deterministic distinct leaves; hashed with the PRODUCTION §5.1 leaf hash. */
function makeLeafHashes(n: number): Buffer[] {
  return Array.from({ length: n }, (_, i) => {
    const h = leafHash({ leaf_version: 'acdp-log-leaf/1', ctx_id: `acdp://reg.example/ctx-${i}` });
    if (h === null) throw new Error('leaf hash failed');
    return h;
  });
}

// ── Ed25519 test keypair (registry receipt signing key stand-in) ────────

function testKeypair(): { privateKey: KeyObject; publicKeyB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { privateKey, publicKeyB64: spki.subarray(spki.length - 32).toString('base64') };
}

const AUTHORITY = 'reg.example';
const LOG_ID = `did:web:${AUTHORITY}/log/1`;

function signedCheckpoint(
  privateKey: KeyObject,
  fields: Partial<Omit<LogCheckpoint, 'signature'>> = {},
): LogCheckpoint {
  const unsigned = {
    checkpoint_version: 'acdp-log/1',
    log_id: LOG_ID,
    tree_size: 0,
    root_hash: wire(sha256(Buffer.alloc(0))),
    timestamp: new Date(Date.now() - 1000).toISOString(),
    ...fields,
  };
  const withPlaceholder = {
    ...unsigned,
    signature: { algorithm: 'ed25519', key_id: `did:web:${AUTHORITY}#receipt-key-1`, value: '' },
  } as LogCheckpoint;
  const hash = checkpointHash(withPlaceholder)!;
  const sig = edSign(null, Buffer.from(hash, 'ascii'), privateKey);
  withPlaceholder.signature.value = sig.toString('base64');
  return withPlaceholder;
}

describe('log-verify: Merkle arithmetic (§5, §9.1, §9.2)', () => {
  it('empty tree root is SHA-256("") (§5.2)', () => {
    expect(mth([]).toString('hex')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('verifies inclusion for every leaf of every tree size ≤ 8', () => {
    for (let n = 1; n <= 8; n++) {
      const leaves = makeLeafHashes(n);
      const root = wire(mth(leaves));
      for (let m = 0; m < n; m++) {
        const path = auditPath(m, leaves).map(wire);
        const verdict = verifyInclusionPath(m, n, leaves[m]!, path, root);
        expect({ n, m, verdict }).toEqual({ n, m, verdict: { ok: true } });
      }
    }
  });

  it('rejects a tampered inclusion path element (log-002 analogue)', () => {
    const leaves = makeLeafHashes(5);
    const root = wire(mth(leaves));
    const path = auditPath(0, leaves).map(wire);
    path[1] = wire(sha256(Buffer.from('tampered')));
    const verdict = verifyInclusionPath(0, 5, leaves[0]!, path, root);
    expect(verdict.ok).toBe(false);
  });

  it('rejects a proof for the wrong leaf, wrong index, truncated and padded paths', () => {
    const leaves = makeLeafHashes(6);
    const root = wire(mth(leaves));
    const path = auditPath(2, leaves).map(wire);
    // wrong leaf
    expect(verifyInclusionPath(2, 6, leaves[3]!, path, root).ok).toBe(false);
    // wrong index
    expect(verifyInclusionPath(3, 6, leaves[2]!, path, root).ok).toBe(false);
    // truncated
    expect(verifyInclusionPath(2, 6, leaves[2]!, path.slice(0, -1), root).ok).toBe(false);
    // padded
    expect(verifyInclusionPath(2, 6, leaves[2]!, [...path, path[0]!], root).ok).toBe(false);
    // out of range
    expect(verifyInclusionPath(6, 6, leaves[2]!, path, root).ok).toBe(false);
  });

  it('verifies consistency for every 0 < m ≤ n ≤ 8 pair', () => {
    for (let n = 1; n <= 8; n++) {
      const leaves = makeLeafHashes(n);
      const secondRoot = wire(mth(leaves));
      for (let m = 1; m <= n; m++) {
        const firstRoot = wire(mth(leaves.slice(0, m)));
        const path = consistencyProof(m, leaves).map(wire);
        const verdict = verifyConsistencyPath(m, n, path, firstRoot, secondRoot);
        expect({ n, m, verdict }).toEqual({ n, m, verdict: { ok: true } });
      }
    }
  });

  it('detects a root rewrite: consistency fails against the pre-rewrite root', () => {
    const honest = makeLeafHashes(3);
    const retainedRoot = wire(mth(honest));
    // The registry rewrites leaf 1, then grows to 5 leaves.
    const rewritten = [...makeLeafHashes(5)];
    rewritten[1] = sha256(Buffer.from('evil-replacement'));
    const newRoot = wire(mth(rewritten));
    const path = consistencyProof(3, rewritten).map(wire);
    const verdict = verifyConsistencyPath(3, 5, path, retainedRoot, newRoot);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('history rewrite');
  });

  it('same-size consistency requires an empty path and equal roots (§9.2 step 1)', () => {
    const leaves = makeLeafHashes(4);
    const root = wire(mth(leaves));
    expect(verifyConsistencyPath(4, 4, [], root, root)).toEqual({ ok: true });
    const other = wire(sha256(Buffer.from('x')));
    expect(verifyConsistencyPath(4, 4, [], root, other).ok).toBe(false);
    expect(verifyConsistencyPath(4, 4, [root], root, root).ok).toBe(false);
  });

  it('rejects first==0, first>second, and empty paths (§9.2 step 2)', () => {
    const leaves = makeLeafHashes(4);
    const root = wire(mth(leaves));
    expect(verifyConsistencyPath(0, 4, [root], root, root).ok).toBe(false);
    expect(verifyConsistencyPath(5, 4, [root], root, root).ok).toBe(false);
    expect(verifyConsistencyPath(2, 4, [], root, root).ok).toBe(false);
  });
});

describe('log-verify: checkpoint parse + signature (§6, §9.3)', () => {
  const { privateKey, publicKeyB64 } = testKeypair();

  it('accepts and verifies a well-formed signed checkpoint', () => {
    const cp = signedCheckpoint(privateKey, { tree_size: 5 });
    const parsed = parseCheckpoint(cp as unknown as Record<string, unknown>);
    expect(parsed.ok).toBe(true);
    expect(verifyCheckpointSignature(cp, publicKeyB64)).toEqual({ ok: true });
    expect(checkpointTimestampOk(cp)).toEqual({ ok: true });
  });

  it('rejects a checkpoint whose root_hash was altered after signing (log-004 analogue)', () => {
    const cp = signedCheckpoint(privateKey, { tree_size: 5 });
    const tampered = {
      ...cp,
      root_hash: wire(sha256(Buffer.from('altered'))),
    } as LogCheckpoint;
    const verdict = verifyCheckpointSignature(tampered, publicKeyB64);
    expect(verdict.ok).toBe(false);
  });

  it('rejects unknown/missing members, bad version, bad log_id, non-ms timestamps (closed §6 schema)', () => {
    const cp = signedCheckpoint(privateKey) as unknown as Record<string, unknown>;
    expect(parseCheckpoint({ ...cp, extra: 1 }).ok).toBe(false);
    const { timestamp: _t, ...missing } = cp;
    expect(parseCheckpoint(missing).ok).toBe(false);
    expect(parseCheckpoint({ ...cp, checkpoint_version: 'acdp-log/2' }).ok).toBe(false);
    expect(parseCheckpoint({ ...cp, log_id: 'did:web:reg.example/notlog/1' }).ok).toBe(false);
    expect(parseCheckpoint({ ...cp, log_id: `did:web:${AUTHORITY}/log/UPPER` }).ok).toBe(false);
    expect(parseCheckpoint({ ...cp, tree_size: -1 }).ok).toBe(false);
    expect(parseCheckpoint({ ...cp, tree_size: 1.5 }).ok).toBe(false);
    expect(parseCheckpoint({ ...cp, root_hash: 'sha256:xyz' }).ok).toBe(false);
    // Second-precision timestamp is not the canonical ms form.
    expect(parseCheckpoint({ ...cp, timestamp: '2026-07-05T00:00:00Z' }).ok).toBe(false);
  });

  it('rejects a non-ed25519 signature algorithm and a future timestamp beyond skew', () => {
    const cp = signedCheckpoint(privateKey);
    const p256 = {
      ...cp,
      signature: { ...cp.signature, algorithm: 'ecdsa-p256' },
    } as LogCheckpoint;
    expect(verifyCheckpointSignature(p256, publicKeyB64).ok).toBe(false);

    const future = signedCheckpoint(privateKey, {
      timestamp: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    expect(checkpointTimestampOk(future).ok).toBe(false);
  });

  it('extracts the registry DID from a log_id', () => {
    expect(logIdRegistryDid(LOG_ID)).toBe(`did:web:${AUTHORITY}`);
    expect(logIdRegistryDid('nonsense')).toBeNull();
  });
});

describe('log-verify: leaf reconstruction (§4, §9.1 step 1)', () => {
  const receipt = {
    registry_did: `did:web:${AUTHORITY}`,
    ctx_id: `acdp://${AUTHORITY}/ctx-001`,
    lineage_id: 'lin-001',
    origin_registry: AUTHORITY,
    created_at: '2026-07-01T00:00:00.000Z',
    content_hash: 'sha256:' + 'a'.repeat(64),
    key_fingerprint: 'sha256:' + 'b'.repeat(64),
    signature: { algorithm: 'ed25519', key_id: `did:web:${AUTHORITY}#receipt-key-1`, value: 'c2ln' },
  };

  it('builds the closed leaf with the receipt-preimage hash', () => {
    const out = buildLogLeaf(receipt);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(Object.keys(out.leaf).sort()).toEqual([
      'content_hash',
      'created_at',
      'ctx_id',
      'key_fingerprint',
      'leaf_version',
      'lineage_id',
      'origin_registry',
      'receipt_hash',
    ]);
    expect(out.leaf.leaf_version).toBe('acdp-log-leaf/1');
    expect(out.leaf.receipt_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('receipt_hash excludes the signature — stable across the sanctioned §9 re-mint', () => {
    const a = buildLogLeaf(receipt);
    const b = buildLogLeaf({
      ...receipt,
      signature: { ...receipt.signature, value: 'ZGlmZmVyZW50' },
    });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.leaf.receipt_hash).toBe(b.leaf.receipt_hash);
  });

  it('a different attested field changes the receipt_hash', () => {
    const a = buildLogLeaf(receipt);
    const b = buildLogLeaf({ ...receipt, created_at: '2026-07-02T00:00:00.000Z' });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.leaf.receipt_hash).not.toBe(b.leaf.receipt_hash);
  });

  it('fails closed on a receipt missing leaf fields', () => {
    const { lineage_id: _omit, ...partial } = receipt;
    expect(buildLogLeaf(partial).ok).toBe(false);
  });
});

describe('log-verify: proof-response parsing (§8.2)', () => {
  const h = 'sha256:' + 'c'.repeat(64);
  const cp = { checkpoint_version: 'acdp-log/1' };

  it('parses well-formed inclusion / consistency responses', () => {
    expect(
      parseInclusionProof({
        log_id: LOG_ID,
        leaf_index: 0,
        tree_size: 5,
        inclusion_path: [h],
        log_checkpoint: cp,
      }).ok,
    ).toBe(true);
    expect(
      parseConsistencyProof({
        log_id: LOG_ID,
        first_tree_size: 3,
        second_tree_size: 5,
        consistency_path: [h, h],
        log_checkpoint: cp,
      }).ok,
    ).toBe(true);
  });

  it('rejects malformed shapes', () => {
    expect(parseInclusionProof(null).ok).toBe(false);
    expect(
      parseInclusionProof({ log_id: LOG_ID, leaf_index: -1, tree_size: 5, inclusion_path: [h], log_checkpoint: cp }).ok,
    ).toBe(false);
    expect(
      parseInclusionProof({ log_id: LOG_ID, leaf_index: 0, tree_size: 5, inclusion_path: ['nope'], log_checkpoint: cp }).ok,
    ).toBe(false);
    expect(
      parseInclusionProof({ log_id: LOG_ID, leaf_index: 0, tree_size: 5, inclusion_path: [h] }).ok,
    ).toBe(false);
    expect(
      parseConsistencyProof({ log_id: LOG_ID, first_tree_size: 3, second_tree_size: 'x', consistency_path: [h], log_checkpoint: cp }).ok,
    ).toBe(false);
  });

  it('wireHashToBuf round-trips and rejects garbage', () => {
    const buf = wireHashToBuf(h);
    expect(buf?.toString('hex')).toBe('c'.repeat(64));
    expect(wireHashToBuf('sha256:short')).toBeNull();
    expect(wireHashToBuf(42)).toBeNull();
  });
});
