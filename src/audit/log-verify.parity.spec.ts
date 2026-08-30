/**
 * Native-vs-host parity cross-check for the RFC-ACDP-0012 §9.1/§9.2 folds.
 *
 * This is the conformance gate that JUSTIFIES routing the log verification
 * through the `acdp` binding (0.6.0+, `sdkHasLogSurface()`): the SAME canonical
 * golden vectors — log-001 (leaf/root + inclusion) and log-003 (consistency) —
 * are run through the native binding path (`nativeVerify*`) AND the host TS
 * arithmetic (`tsVerify*`), and the roots and verdicts MUST be byte-identical.
 * If the two ever diverge the swap is unsafe and this test fails loudly.
 *
 * The vectors are read from the canonical spec checkout
 * (`../agentcontextdistributionprotocol/schemas/conformance/`, or
 * `$ACDP_SPEC_DIR/schemas/conformance`); the suite SKIPS gracefully when
 * neither is present so it never breaks CI in a bare checkout — but on a full
 * monorepo checkout it exercises the real binding.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AcdpMerkle } from '@agentcontextdistributionprotocol/acdp';
import {
  ConsistencyProof,
  InclusionProof,
  LogCheckpoint,
  buildLogLeaf,
  leafHash,
  nativeVerifyConsistency,
  nativeVerifyInclusion,
  nodeHash,
  sdkHasLogSurface,
  tsVerifyConsistency,
  tsVerifyInclusion,
  wireHashToBuf,
} from './log-verify';

// ── Locate the canonical conformance fixtures ────────────────────────────

function conformanceDir(): string | null {
  const candidates = [
    process.env.ACDP_SPEC_DIR ? join(process.env.ACDP_SPEC_DIR, 'schemas', 'conformance') : null,
    resolve(__dirname, '../../..', 'agentcontextdistributionprotocol/schemas/conformance'),
  ].filter((p): p is string => p !== null);
  for (const dir of candidates) {
    if (existsSync(join(dir, 'log-001-leaf-and-root-golden.json'))) return dir;
  }
  return null;
}

const DIR = conformanceDir();
const REGISTRY_KEY_ID = 'did:web:registry.example.com#receipt-key-1';

function loadVector(file: string): Record<string, any> {
  return JSON.parse(readFileSync(join(DIR!, file), 'utf8')).vectors[0];
}

/** RFC 6962 §5.2 MTH over wire-form leaf hashes, host-side (the fallback path). */
function tsRoot(leafHashesWire: string[]): string {
  const hashes = leafHashesWire.map((w) => {
    const b = wireHashToBuf(w);
    if (b === null) throw new Error(`bad wire hash ${w}`);
    return b;
  });
  const mth = (hs: Buffer[]): Buffer => {
    if (hs.length === 1) return hs[0]!;
    let k = 1;
    while (k * 2 < hs.length) k *= 2;
    return nodeHash(mth(hs.slice(0, k)), mth(hs.slice(k)));
  };
  return `sha256:${mth(hashes).toString('hex')}`;
}

// ACDP_REQUIRE_CONFORMANCE (set by CI's `unit` job, mirroring acdp-rs's
// ACDP_REQUIRE_CONFORMANCE): when set, a missing spec checkout is a hard
// failure instead of a graceful skip — a green run then genuinely proves the
// log-001/log-003 golden parity ran, rather than silently no-op'ing (CP-7).
const REQUIRE_CONFORMANCE = typeof process.env.ACDP_REQUIRE_CONFORMANCE !== 'undefined';
const describeOrSkip = DIR || REQUIRE_CONFORMANCE ? describe : describe.skip;

function requireConformanceDir(): void {
  if (REQUIRE_CONFORMANCE && !DIR) {
    throw new Error(
      'ACDP_REQUIRE_CONFORMANCE is set but no ACDP spec checkout was found at ' +
        'ACDP_SPEC_DIR or the sibling path — the log-001/log-003 golden parity ' +
        'fixtures are required in this mode.',
    );
  }
}

describeOrSkip('log-verify parity: native binding vs host arithmetic', () => {
  beforeAll(requireConformanceDir);

  it('the environment carries the native log surface (0.6.0+)', () => {
    // This suite only runs when the fixtures are present; on this monorepo
    // checkout the pinned binding is 0.6.0+, so the native surface MUST exist —
    // otherwise the switch-over silently fell back to TS.
    expect(sdkHasLogSurface()).toBe(true);
  });

  // ── log-001: leaf hash, Merkle root, inclusion proof (§4–§6, §9.1) ─────

  describe('log-001 (leaf + root + inclusion)', () => {
    const v = DIR ? loadVector('log-001-leaf-and-root-golden.json') : ({} as any);
    const exp = v.expected;

    it('native and host agree on the §5.1 leaf hash, and match the golden', () => {
      const leaf0 = v.leaves[0];
      const native = AcdpMerkle.leafHash(JSON.stringify(leaf0));
      const host = leafHash(leaf0);
      expect(host).not.toBeNull();
      const hostWire = `sha256:${host!.toString('hex')}`;
      expect(native).toBe(hostWire);
      expect(native).toBe(exp.leaf_hashes[0]);
    });

    it('native and host agree on the size-5 Merkle root, and match the golden', () => {
      const native = AcdpMerkle.rootHash(JSON.stringify(exp.leaf_hashes));
      const host = tsRoot(exp.leaf_hashes);
      expect(native).toBe(host);
      expect(native).toBe(exp.root_hash);
    });

    it('native and host agree on the §4 leaf reconstruction from a receipt', () => {
      const leaf0 = v.leaves[0];
      const receipt = {
        registry_did: 'did:web:registry.example.com',
        ctx_id: leaf0.ctx_id,
        lineage_id: leaf0.lineage_id,
        origin_registry: leaf0.origin_registry,
        created_at: leaf0.created_at,
        content_hash: leaf0.content_hash,
        key_fingerprint: leaf0.key_fingerprint,
        signature: { algorithm: 'ed25519', key_id: REGISTRY_KEY_ID, value: 'c2ln' },
      };
      const host = buildLogLeaf(receipt);
      expect(host.ok).toBe(true);
      if (!host.ok) return;
      // The reconstructed leaf's receipt_hash is the rcpt-001 pinned value.
      expect(host.leaf.receipt_hash).toBe(leaf0.receipt_hash);
      // Native leaf hash of the reconstructed leaf equals the golden leaf hash.
      expect(AcdpMerkle.leafHash(JSON.stringify(host.leaf))).toBe(exp.leaf_hashes[0]);
    });

    it('native and host produce the SAME inclusion verdict (valid) for leaf 0', () => {
      const checkpoint = exp.log_checkpoint as LogCheckpoint;
      const proof: InclusionProof = {
        log_id: exp.log_inclusion.log_id,
        leaf_index: exp.log_inclusion.leaf_index,
        tree_size: exp.log_inclusion.tree_size,
        inclusion_path: exp.log_inclusion.inclusion_path,
        log_checkpoint: checkpoint,
      };
      const leaf0 = v.leaves[0];
      const native = nativeVerifyInclusion(proof, checkpoint, leaf0);
      const host = tsVerifyInclusion(proof, checkpoint, leaf0);
      expect(native).toEqual({ ok: true });
      expect(host).toEqual({ ok: true });
      expect(native).toEqual(host);
    });

    it('native and host produce the SAME inclusion verdict (invalid) for a tampered path', () => {
      const checkpoint = exp.log_checkpoint as LogCheckpoint;
      const tampered = [...exp.log_inclusion.inclusion_path];
      tampered[0] = `sha256:${'f'.repeat(64)}`;
      const proof: InclusionProof = {
        log_id: exp.log_inclusion.log_id,
        leaf_index: exp.log_inclusion.leaf_index,
        tree_size: exp.log_inclusion.tree_size,
        inclusion_path: tampered,
        log_checkpoint: checkpoint,
      };
      const leaf0 = v.leaves[0];
      const native = nativeVerifyInclusion(proof, checkpoint, leaf0);
      const host = tsVerifyInclusion(proof, checkpoint, leaf0);
      expect(native.ok).toBe(false);
      expect(host.ok).toBe(false);
    });
  });

  // ── log-003: consistency proof between sizes 3 and 5 (§9.2) ─────────────

  describe('log-003 (consistency)', () => {
    const v = DIR ? loadVector('log-003-consistency-proof-golden.json') : ({} as any);
    const exp = v.expected;

    function secondCheckpoint(): LogCheckpoint {
      return {
        ...v.second_checkpoint_unsigned,
        signature: {
          algorithm: 'ed25519',
          key_id: REGISTRY_KEY_ID,
          value: exp.second_signature_value_base64,
        },
      } as LogCheckpoint;
    }

    function proofOf(path: string[]): ConsistencyProof {
      return {
        log_id: v.log_id,
        first_tree_size: v.first_checkpoint_unsigned.tree_size,
        second_tree_size: v.second_checkpoint_unsigned.tree_size,
        consistency_path: path,
        log_checkpoint: secondCheckpoint(),
      };
    }

    it('native and host agree on the retained roots, and match the golden', () => {
      const first = tsRoot(v.leaf_hashes.slice(0, 3));
      const second = tsRoot(v.leaf_hashes.slice(0, 5));
      expect(first).toBe(exp.first_root_hash);
      expect(second).toBe(exp.second_root_hash);
      expect(AcdpMerkle.rootHash(JSON.stringify(v.leaf_hashes.slice(0, 3)))).toBe(first);
      expect(AcdpMerkle.rootHash(JSON.stringify(v.leaf_hashes.slice(0, 5)))).toBe(second);
    });

    it('native and host produce the SAME consistency verdict (valid) for 3→5', () => {
      const checkpoint = secondCheckpoint();
      const proof = proofOf(exp.consistency_proof_response.consistency_path);
      const native = nativeVerifyConsistency(proof, checkpoint, exp.first_root_hash);
      const host = tsVerifyConsistency(proof, checkpoint, exp.first_root_hash);
      expect(native).toEqual({ ok: true });
      expect(host).toEqual({ ok: true });
      expect(native).toEqual(host);
    });

    it('native and host produce the SAME consistency verdict (invalid) for a rewrite', () => {
      const checkpoint = secondCheckpoint();
      const tampered = [...exp.consistency_proof_response.consistency_path];
      tampered[0] = `sha256:${'e'.repeat(64)}`;
      const proof = proofOf(tampered);
      const native = nativeVerifyConsistency(proof, checkpoint, exp.first_root_hash);
      const host = tsVerifyConsistency(proof, checkpoint, exp.first_root_hash);
      expect(native.ok).toBe(false);
      expect(host.ok).toBe(false);
    });
  });
});
