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
  LOG_ID_RE,
  LogCheckpoint,
  logIdRegistryDid,
  nodeHash,
  parseCheckpoint,
  parseConsistencyProof,
  parseInclusionProof,
  sdkHasLogSurface,
  toClosedConsistencyProof,
  toClosedInclusionProof,
  verifyCheckpointSignature,
  verifyConsistency,
  verifyConsistencyPath,
  verifyInclusion,
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

  it('LOG_ID_RE (B9b, the sole declaration in src/) matches the closed JSON schema exactly: accepts its character class, rejects `_`', () => {
    // schemas/json/acdp-log-checkpoint.schema.json: `^did:web:[a-zA-Z0-9.%:-]+/log/[a-z0-9-]{1,32}$`.
    expect(LOG_ID_RE.test('did:web:reg.example.com%3A8443/log/abc-123')).toBe(true);
    // A `did:web` DID's general grammar (RFC-ACDP-0001 §5.11.2) allows `_` in a
    // domain label, but the closed log_id schema does not — the regex must
    // track the SCHEMA, not the general DID grammar.
    expect(LOG_ID_RE.test('did:web:reg_istry.example/log/a')).toBe(false);
    expect(LOG_ID_RE.test('did:web:reg.example/log/a_b')).toBe(false);
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

  // §10 openness: the parse MUST carry unmodelled members through, so a future
  // consumer can still reach the §6.1 cosignatures. Stripping happens at the
  // fold boundary only (see the closed-projection suite below).
  it('carries an RFC-ACDP-0015 §6.1 witness_signatures sibling through the open parse', () => {
    const parsed = parseInclusionProof({
      log_id: LOG_ID,
      leaf_index: 0,
      tree_size: 5,
      inclusion_path: [h],
      log_checkpoint: cp,
      witness_signatures: [{ witness_id: 'did:web:witness.example.org' }],
    });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect((parsed.proof as unknown as Record<string, unknown>).witness_signatures).toHaveLength(1);
  });
});

// ── B12: the closed §8.2 projection at the native-fold boundary ──────────
//
// RFC-ACDP-0015 §6.1 lets a registry attach witness cosignatures as a
// TOP-LEVEL SIBLING of a `GET /log/proof` response — the reference registry's
// `attach_witness_signatures` does exactly that, in inclusion AND consistency
// mode, as soon as it has aggregated its first cosignature. The SDK's
// `LogInclusion` / `LogConsistencyProof` are `deny_unknown_fields`, so handing
// the sibling to the native fold makes it report
// `does not parse: unknown field \`witness_signatures\`` — which callers read
// as a FAILED proof: a `consistency_failed` alert or a sealed `invalid_proof`
// verdict against a fully conformant registry.
//
// Every other proof fixture in this repo predates cosignature aggregation and
// therefore carries no sibling, which is why the defect was invisible. These
// tests add it.

/** A real RFC-ACDP-0015 §4 cosignature object, as the registry serves them. */
function witnessSignature(cp: LogCheckpoint): Record<string, unknown> {
  return {
    cosignature_version: 'acdp-cosig/1',
    witness_id: 'did:web:witness.example.org%3A8443',
    witnessed_checkpoint: {
      log_id: cp.log_id,
      tree_size: cp.tree_size,
      root_hash: cp.root_hash,
      timestamp: cp.timestamp,
    },
    witnessed_at: '2026-07-05T00:00:00.000Z',
    signature: {
      algorithm: 'ed25519',
      key_id: 'did:web:witness.example.org%3A8443#witness-key-1',
      value: 'Y29zaWc=',
    },
  };
}

describe('log-verify: closed §8.2 projection at the fold boundary (RFC-ACDP-0015 §6.1)', () => {
  const { privateKey } = testKeypair();
  // Leaf 0 is a REAL §4 leaf (the native fold parses it closed-schema, unlike
  // the host arithmetic which only hashes it); leaves 1..4 are opaque siblings.
  const built = buildLogLeaf({
    ctx_id: 'acdp://reg.example/ctx-0',
    lineage_id: 'lin-001',
    origin_registry: AUTHORITY,
    created_at: '2026-07-01T00:00:00.000Z',
    content_hash: 'sha256:' + 'a'.repeat(64),
    key_fingerprint: 'sha256:' + 'b'.repeat(64),
    signature: { algorithm: 'ed25519', key_id: `did:web:${AUTHORITY}#receipt-key-1`, value: 'c2ln' },
  });
  if (!built.ok) throw new Error(built.reason);
  const foldedLeaf = built.leaf;
  const leaves = [leafHash(foldedLeaf)!, ...makeLeafHashes(5).slice(1)];
  const root5 = wire(mth(leaves));
  const checkpoint = signedCheckpoint(privateKey, { tree_size: 5, root_hash: root5 });

  /** The inclusion-mode response a witnessed registry actually serves. */
  function inclusionResponse(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      log_id: LOG_ID,
      leaf_index: 0,
      tree_size: 5,
      inclusion_path: auditPath(0, leaves).map(wire),
      log_checkpoint: checkpoint,
      // The retrieval-authorized convenience echo (§8.2) — a modelled but
      // untrusted member the fold must not consume.
      leaf: foldedLeaf,
      witness_signatures: [witnessSignature(checkpoint)],
      ...extra,
    };
  }

  /** The consistency-mode response a witnessed registry actually serves. */
  function consistencyResponse(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      log_id: LOG_ID,
      first_tree_size: 3,
      second_tree_size: 5,
      consistency_path: consistencyProof(3, leaves).map(wire),
      log_checkpoint: checkpoint,
      witness_signatures: [witnessSignature(checkpoint)],
      ...extra,
    };
  }

  it('the environment carries the native log surface (so this exercises the affected path)', () => {
    // The host TS fold reads only named fields and was NEVER affected — a green
    // host-path run would prove nothing. Assert we are on the native binding.
    expect(sdkHasLogSurface()).toBe(true);
  });

  // Acceptance criterion 9: the JSON handed to the binding carries EXACTLY the
  // closed §8.2 member set. Asserted by key set, so a sibling of ANY name is
  // caught — not just `witness_signatures`. The expressions below are
  // byte-identical to the arguments `nativeVerifyInclusion` /
  // `nativeVerifyConsistency` build.
  it('hands the binding exactly the closed inclusion member set', () => {
    const parsed = parseInclusionProof(
      inclusionResponse({ some_future_sibling: { anything: true } }),
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    const argJson = JSON.stringify(toClosedInclusionProof(parsed.proof));
    expect(Object.keys(JSON.parse(argJson) as Record<string, unknown>).sort()).toEqual([
      'inclusion_path',
      'leaf_index',
      'log_id',
      'tree_size',
    ]);
  });

  it('hands the binding exactly the closed consistency member set', () => {
    const parsed = parseConsistencyProof(
      consistencyResponse({ some_future_sibling: { anything: true } }),
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    const argJson = JSON.stringify(toClosedConsistencyProof(parsed.proof));
    expect(Object.keys(JSON.parse(argJson) as Record<string, unknown>).sort()).toEqual([
      'consistency_path',
      'first_tree_size',
      'log_id',
      'second_tree_size',
    ]);
  });

  // Acceptance criterion 8.
  it('verifies an inclusion proof carrying the §6.1 sibling', () => {
    const parsed = parseInclusionProof(inclusionResponse());
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(verifyInclusion(parsed.proof, checkpoint, foldedLeaf)).toEqual({ ok: true });
  });

  // Acceptance criterion 7.
  it('verifies a consistency proof carrying the §6.1 sibling', () => {
    const parsed = parseConsistencyProof(consistencyResponse());
    if (!parsed.ok) throw new Error(parsed.reason);
    const retainedRoot = wire(mth(leaves.slice(0, 3)));
    expect(verifyConsistency(parsed.proof, checkpoint, retainedRoot)).toEqual({ ok: true });
  });

  // Acceptance criterion 10 — the fix must not become a way to launder a
  // failing fold. Both negative controls carry the sibling too.
  it('still rejects a TAMPERED inclusion path even with the §6.1 sibling attached', () => {
    const bad = inclusionResponse();
    const path = [...(bad.inclusion_path as string[])];
    path[0] = 'sha256:' + 'f'.repeat(64);
    bad.inclusion_path = path;
    const parsed = parseInclusionProof(bad);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(verifyInclusion(parsed.proof, checkpoint, foldedLeaf).ok).toBe(false);
  });

  it('still rejects an INCONSISTENT consistency proof even with the §6.1 sibling attached', () => {
    // A registry that rewrote history: the served proof folds to a tree that
    // is NOT an extension of our retained size-3 root.
    const rewritten = makeLeafHashes(5).map((h2, i) => (i < 3 ? leafHash({ evil: i })! : h2));
    const bad = consistencyResponse({
      consistency_path: consistencyProof(3, rewritten).map(wire),
    });
    const parsed = parseConsistencyProof(bad);
    if (!parsed.ok) throw new Error(parsed.reason);
    const retainedRoot = wire(mth(leaves.slice(0, 3)));
    expect(verifyConsistency(parsed.proof, checkpoint, retainedRoot).ok).toBe(false);
  });
});
