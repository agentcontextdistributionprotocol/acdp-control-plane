/**
 * RFC-ACDP-0015 witness-cosignature construction (§4–§5, §8) — the cross-
 * implementation parity guarantee for the TS mint/verify path.
 *
 * The centerpiece is the wit-001 GOLDEN PARITY test: it mints a cosignature for
 * the wit-001 scenario inputs with the fixture's witness seed (0x33×32) and
 * asserts BYTE-EXACT equality to the golden — canonical preimage, cosignature
 * hash (sha256:70f416e2…), and Ed25519 signature (omUcflbx…). A pass proves the
 * TS §5 construction (SDK JCS + node:crypto SHA-256/Ed25519) is byte-identical
 * to the Rust and acdp-verifier-py implementations that already pass wit-001 —
 * the same cross-implementation guarantee the log-verify parity tests give.
 *
 * Fixtures load from `$ACDP_SPEC_DIR/schemas/conformance` (falling back to the
 * sibling spec checkout) and the whole suite SKIPS gracefully when neither is
 * present — so a green run without the spec never falsely claims conformance.
 */
import { createHash, createPrivateKey, KeyObject } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AcdpCanonicalizer, AcdpVerifier } from 'acdp';
import {
  cosignatureFreshnessOk,
  cosignatureHash,
  mintCosignature,
  nativeMintCosignature,
  nativeVerifyCosignature,
  nodeWitnessSigner,
  parseCosignature,
  sdkHasCosignatureSurface,
  tsMintCosignature,
  tsVerifyCosignature,
  verifyCosignature,
  type WitnessedCheckpoint,
} from './cosign';
import type { LogCheckpoint } from './log-verify';

// ── Fixture loading (ACDP_SPEC_DIR, graceful skip) ───────────────────────

function conformanceDir(): string | null {
  const candidates = [
    process.env.ACDP_SPEC_DIR
      ? path.join(process.env.ACDP_SPEC_DIR, 'schemas', 'conformance')
      : null,
    path.resolve(__dirname, '../../../agentcontextdistributionprotocol/schemas/conformance'),
  ].filter((c): c is string => c !== null);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'wit-001-cosignature-golden.json'))) return dir;
  }
  return null;
}

const CONFORMANCE_DIR = conformanceDir();
const load = (name: string): any =>
  JSON.parse(fs.readFileSync(path.join(CONFORMANCE_DIR!, name), 'utf8'));

/** Build an Ed25519 signer from a raw 32-byte seed (the fixtures' key form). */
function signerFromSeed(seedHex: string, witnessId: string, keyId: string) {
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(seedHex, 'hex'),
  ]);
  const key: KeyObject = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return nodeWitnessSigner(witnessId, keyId, key);
}

const b64FromHex = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

// ── Unit tests (no fixtures) ─────────────────────────────────────────────

describe('cosignature construction (RFC-ACDP-0015 §4–§5)', () => {
  const CHECKPOINT: WitnessedCheckpoint = {
    log_id: 'did:web:registry.example.com/log/1',
    tree_size: 5,
    root_hash: 'sha256:0b5978172c671ca050b44790a749b18fc29d58a7a17495fbb4e0f86eb885f731',
    timestamp: '2026-07-04T12:00:00.000Z',
  };
  const signer = signerFromSeed(
    '33'.repeat(32),
    'did:web:witness.example.org',
    'did:web:witness.example.org#witness-key-1',
  );

  it('the preimage hash is JCS-then-SHA-256 with the sha256: prefix', () => {
    const unsigned = {
      cosignature_version: 'acdp-cosig/1',
      witness_id: 'did:web:witness.example.org',
      witnessed_checkpoint: CHECKPOINT,
      witnessed_at: '2026-07-04T12:00:05.000Z',
    };
    const canonical = AcdpCanonicalizer.canonicalize(JSON.stringify(unsigned));
    const expected = 'sha256:' + createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
    expect(cosignatureHash(unsigned)).toBe(expected);
  });

  it('mints a cosignature that verifies under the witness public key', () => {
    const minted = mintCosignature(CHECKPOINT, '2026-07-04T12:00:05.000Z', signer);
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const witnessPubB64 = b64FromHex(
      '17cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce',
    );
    expect(verifyCosignature(minted.cosignature, witnessPubB64)).toEqual({ ok: true });
  });

  it('rejects a cosignature whose key_id DID != witness_id (§8 step 3 binding)', () => {
    const minted = mintCosignature(CHECKPOINT, '2026-07-04T12:00:05.000Z', signer);
    if (!minted.ok) throw new Error('mint failed');
    const tampered = {
      ...minted.cosignature,
      signature: { ...minted.cosignature.signature, key_id: 'did:web:evil.example.org#k1' },
    };
    const witnessPubB64 = b64FromHex(
      '17cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce',
    );
    expect(verifyCosignature(tampered, witnessPubB64).ok).toBe(false);
  });

  it('parseCosignature enforces the closed §4 schema', () => {
    const minted = mintCosignature(CHECKPOINT, '2026-07-04T12:00:05.000Z', signer);
    if (!minted.ok) throw new Error('mint failed');
    expect(parseCosignature(minted.cosignature).ok).toBe(true);
    // Unknown top-level member → fail (every member is signed).
    expect(parseCosignature({ ...minted.cosignature, extra: 1 }).ok).toBe(false);
    // Wrong version → fail.
    expect(parseCosignature({ ...minted.cosignature, cosignature_version: 'acdp-cosig/2' }).ok).toBe(false);
    // Non-canonical witnessed_at → fail.
    expect(
      parseCosignature({ ...minted.cosignature, witnessed_at: '2026-07-04T12:00:05Z' }).ok,
    ).toBe(false);
  });

  it('flags a future witnessed_at beyond the 120s skew (§8 step 5)', () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const minted = mintCosignature(CHECKPOINT, future, signer);
    if (!minted.ok) throw new Error('mint failed');
    expect(cosignatureFreshnessOk(minted.cosignature).ok).toBe(false);
  });
});

// ── Golden parity (fixtures required) ────────────────────────────────────

const describeGolden = CONFORMANCE_DIR ? describe : describe.skip;
if (!CONFORMANCE_DIR) {

  console.warn('[cosign.spec] ACDP_SPEC_DIR / sibling spec not found — SKIPPING wit-* golden parity');
}

describeGolden('RFC-ACDP-0015 golden parity (wit-001..004 over log-001)', () => {
  it('wit-001: mint is BYTE-EXACT to the golden (canonical, hash, signature)', () => {
    const fixture = load('wit-001-cosignature-golden.json');
    const kp = fixture.witness_test_keypair;
    const vector = fixture.vectors[0];
    const unsigned = vector.cosignature_unsigned;
    const expected = vector.expected;

    // 1. Canonical preimage byte-for-byte.
    const canonical = AcdpCanonicalizer.canonicalize(JSON.stringify(unsigned));
    expect(canonical).toBe(expected.canonical_form);

    // 2. Cosignature hash.
    expect(cosignatureHash(unsigned)).toBe(expected.cosignature_hash);

    // 3. Ed25519 signature over the ASCII hash — the whole parity claim.
    const signer = signerFromSeed(kp.private_seed_hex, unsigned.witness_id, kp.key_id);
    const minted = mintCosignature(
      unsigned.witnessed_checkpoint,
      unsigned.witnessed_at,
      signer,
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(minted.cosignatureHash).toBe(expected.cosignature_hash);
    expect(minted.cosignature.signature.value).toBe(expected.signature_value_base64);
    // The whole signed object matches the pinned golden.
    expect(minted.cosignature).toEqual(expected.log_cosignature);

    // 4. It verifies under the witness test public key, and the binding holds.
    const witnessPubB64 = b64FromHex(kp.public_key_hex);
    expect(verifyCosignature(minted.cosignature, witnessPubB64)).toEqual({ ok: true });
  });

  it('wit-001: the cosigned tuple chains to the log-001 golden checkpoint', () => {
    const wit = load('wit-001-cosignature-golden.json');
    const log = load('log-001-leaf-and-root-golden.json');
    const wc = wit.vectors[0].cosignature_unsigned.witnessed_checkpoint;
    const cp = log.vectors[0].checkpoint_unsigned;
    expect(wc.log_id).toBe(cp.log_id);
    expect(wc.tree_size).toBe(cp.tree_size);
    expect(wc.root_hash).toBe(cp.root_hash);
    expect(wc.timestamp).toBe(cp.timestamp);
  });

  it('wit-003: two distinct witnesses over one tuple → 2-witnessed', () => {
    const fixture = load('wit-003-quorum-verification.json');
    const witnessIds = new Set<string>();
    for (const vector of fixture.vectors) {
      const kp = vector.witness_test_keypair;
      const unsigned = vector.cosignature_unsigned;
      const keyId = `${unsigned.witness_id}#witness-key-1`;
      const signer = signerFromSeed(kp.private_seed_hex, unsigned.witness_id, keyId);
      const minted = mintCosignature(unsigned.witnessed_checkpoint, unsigned.witnessed_at, signer);
      expect(minted.ok).toBe(true);
      if (!minted.ok) return;
      // Each vector reproduces its own golden bytes.
      expect(minted.cosignatureHash).toBe(vector.expected.cosignature_hash);
      expect(minted.cosignature.signature.value).toBe(vector.expected.signature_value_base64);
      // Each verifies under its own witness key.
      expect(
        verifyCosignature(minted.cosignature, b64FromHex(kp.public_key_hex)).ok,
      ).toBe(true);
      witnessIds.add(unsigned.witness_id);
    }
    const q = fixture.expected_quorum;
    // Distinct witness_id count over one (log_id, tree_size, root_hash) tuple.
    expect(witnessIds.size).toBe(q.witnessed_count);
    for (const vector of fixture.vectors) {
      expect(vector.cosignature_unsigned.witnessed_checkpoint.log_id).toBe(q.log_id);
      expect(vector.cosignature_unsigned.witnessed_checkpoint.tree_size).toBe(q.tree_size);
      expect(vector.cosignature_unsigned.witnessed_checkpoint.root_hash).toBe(q.root_hash);
    }
  });

  it('wit-004: a wrong-key signature fails verification (invalid_witness_cosignature)', () => {
    const fixture = load('wit-004-cosignature-key-mismatch.json');
    const parsed = parseCosignature(fixture.cosignature);
    expect(parsed.ok).toBe(true); // parses/well-formed — the failure is cryptographic
    if (!parsed.ok) return;
    // Resolve witness A's assertionMethod key (17cb79…) and verify — MUST fail,
    // because signature.value was produced by witness B's key (d759793…).
    const witnessAPubB64 = b64FromHex(fixture.witness_did_document.assertion_method_key_public_hex);
    const verdict = verifyCosignature(parsed.cosignature, witnessAPubB64);
    expect(verdict.ok).toBe(false);
    // The recomputed hash still matches the pinned one (only the sig is wrong).
    const { signature: _omit, ...unsigned } = parsed.cosignature;
    expect(cosignatureHash(unsigned)).toBe(fixture.expected.cosignature_hash);
    // For contrast, it WOULD verify under the wrong signer's key (sanity).
    const witnessBPubB64 = b64FromHex(fixture.wrong_signer_key_public_hex);
    expect(verifyCosignature(parsed.cosignature, witnessBPubB64).ok).toBe(true);
  });
});

// ── Native-vs-host parity (fixtures required) ────────────────────────────
//
// The conformance gate that JUSTIFIES routing the RFC-ACDP-0015 mint/verify
// through the `acdp` binding (0.7.0+, `sdkHasCosignatureSurface()`): the SAME
// wit-001 (mint), wit-001/wit-004 (verify) and wit-003 (quorum) golden inputs
// run through BOTH the native binding path AND the host TS §5 construction, and
// the bytes/verdicts MUST be identical. If they ever diverge the swap is unsafe
// and this fails loudly. Skips gracefully without the spec checkout.

/** The full log-001 §6 checkpoint the wit-* tuples chain to (native verify anchor). */
function log001Checkpoint(): LogCheckpoint {
  return load('log-001-leaf-and-root-golden.json').vectors[0].expected.log_checkpoint as LogCheckpoint;
}

describeGolden('RFC-ACDP-0015 native-vs-host parity (mint / verify / quorum)', () => {
  it('the environment carries the native cosignature surface (0.7.0+)', () => {
    // This suite only runs with the fixtures present (the monorepo checkout),
    // where the pinned binding is 0.7.0 — so the native surface MUST exist,
    // otherwise the switch-over silently stayed on the TS fallback.
    expect(sdkHasCosignatureSurface()).toBe(true);
  });

  it('wit-001 MINT: native and host produce BYTE-IDENTICAL cosignatures (== golden)', () => {
    const fixture = load('wit-001-cosignature-golden.json');
    const kp = fixture.witness_test_keypair;
    const unsigned = fixture.vectors[0].cosignature_unsigned;
    const expected = fixture.vectors[0].expected;
    const signer = signerFromSeed(kp.private_seed_hex, unsigned.witness_id, kp.key_id);

    const native = nativeMintCosignature(unsigned.witnessed_checkpoint, unsigned.witnessed_at, signer);
    const host = tsMintCosignature(unsigned.witnessed_checkpoint, unsigned.witnessed_at, signer);
    expect(native.ok).toBe(true);
    expect(host.ok).toBe(true);
    if (!native.ok || !host.ok) return;

    // The whole justification: the two paths emit the same bytes as each other,
    // and both equal the pinned golden (canonical hash + Ed25519 signature).
    expect(native.cosignatureHash).toBe(host.cosignatureHash);
    expect(native.cosignature.signature.value).toBe(host.cosignature.signature.value);
    expect(native.cosignature).toEqual(host.cosignature);
    expect(native.cosignatureHash).toBe(expected.cosignature_hash);
    expect(native.cosignature.signature.value).toBe(expected.signature_value_base64);
    expect(native.cosignature).toEqual(expected.log_cosignature);

    // And the public dispatcher (mintCosignature) engages native for this signer.
    const dispatched = mintCosignature(unsigned.witnessed_checkpoint, unsigned.witnessed_at, signer);
    expect(dispatched.ok).toBe(true);
    if (!dispatched.ok) return;
    expect(dispatched.cosignature).toEqual(expected.log_cosignature);
  });

  it('wit-001 VERIFY: native and host both accept the valid cosignature', () => {
    const fixture = load('wit-001-cosignature-golden.json');
    const kp = fixture.witness_test_keypair;
    const cosig = fixture.vectors[0].expected.log_cosignature;
    const witnessPubB64 = b64FromHex(kp.public_key_hex);
    const checkpoint = log001Checkpoint();

    const native = nativeVerifyCosignature(cosig, witnessPubB64, checkpoint);
    const host = tsVerifyCosignature(cosig, witnessPubB64);
    expect(native).toEqual({ ok: true });
    expect(host).toEqual({ ok: true });
    expect(native).toEqual(host);
    // The dispatcher routes native when handed the full checkpoint.
    expect(verifyCosignature(cosig, witnessPubB64, checkpoint)).toEqual({ ok: true });
  });

  it('wit-004 VERIFY: native and host both REJECT the wrong-key signature', () => {
    const fixture = load('wit-004-cosignature-key-mismatch.json');
    const cosig = fixture.cosignature;
    const checkpoint = log001Checkpoint();
    const witnessAPubB64 = b64FromHex(fixture.witness_did_document.assertion_method_key_public_hex);

    const native = nativeVerifyCosignature(cosig, witnessAPubB64, checkpoint);
    const host = tsVerifyCosignature(cosig, witnessAPubB64);
    expect(native.ok).toBe(false);
    expect(host.ok).toBe(false);

    // Under the (wrong) signer's own key the signature bytes DO check out, so
    // both paths accept — the failure above is purely the key binding, and the
    // two paths agree on both verdicts.
    const witnessBPubB64 = b64FromHex(fixture.wrong_signer_key_public_hex);
    expect(nativeVerifyCosignature(cosig, witnessBPubB64, checkpoint).ok).toBe(true);
    expect(tsVerifyCosignature(cosig, witnessBPubB64).ok).toBe(true);
  });

  it('wit-003 QUORUM: native evaluateWitnessQuorum agrees with the host distinct-witness count', () => {
    const fixture = load('wit-003-quorum-verification.json');
    const q = fixture.expected_quorum;
    const checkpoint = log001Checkpoint();

    const cosignatures: unknown[] = [];
    const didDocs: Record<string, unknown> = {};
    const trusted: string[] = [];
    const hostWitnessIds = new Set<string>();
    // The witness clock: past both witnesses' witnessed_at so §8 step 5 passes.
    const now = '2026-07-04T12:03:05.000Z';

    for (const vector of fixture.vectors) {
      const kp = vector.witness_test_keypair;
      const unsigned = vector.cosignature_unsigned;
      const witnessId = unsigned.witness_id as string;
      const keyId = `${witnessId}#witness-key-1`;
      const signer = signerFromSeed(kp.private_seed_hex, witnessId, keyId);
      const minted = mintCosignature(unsigned.witnessed_checkpoint, unsigned.witnessed_at, signer);
      expect(minted.ok).toBe(true);
      if (!minted.ok) return;
      cosignatures.push(minted.cosignature);
      trusted.push(witnessId);
      hostWitnessIds.add(witnessId);
      const pubMultibase = mintedDidDoc(witnessId, keyId, kp.public_key_hex);
      didDocs[witnessId] = pubMultibase;
    }

    const report = JSON.parse(
      AcdpVerifier.evaluateWitnessQuorum(
        JSON.stringify(cosignatures),
        JSON.stringify(checkpoint),
        JSON.stringify(trusted),
        JSON.stringify(didDocs),
        JSON.stringify({ min_witnesses: q.witnessed_count }),
        now,
      ),
    ) as { witnessed_count: number; meets_quorum: boolean; failures: unknown[] };

    // Native report and the host distinct-witness count agree, and both equal
    // the pinned golden quorum size.
    expect(report.failures).toHaveLength(0);
    expect(report.witnessed_count).toBe(hostWitnessIds.size);
    expect(report.witnessed_count).toBe(q.witnessed_count);
    expect(report.meets_quorum).toBe(true);
  });
});

/** A minimal resolvable witness DID document for `evaluateWitnessQuorum` (§9). */
function mintedDidDoc(witnessId: string, keyId: string, publicKeyHex: string): Record<string, unknown> {
  const raw = Buffer.from(publicKeyHex, 'hex');
  const prefixed = Buffer.concat([Buffer.from([0xed, 0x01]), raw]);
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let x = BigInt('0x' + (prefixed.toString('hex') || '0'));
  let mb = '';
  while (x > 0n) {
    mb = alphabet[Number(x % 58n)] + mb;
    x /= 58n;
  }
  for (const b of prefixed) {
    if (b === 0) mb = alphabet[0] + mb;
    else break;
  }
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: witnessId,
    verificationMethod: [
      {
        id: keyId,
        type: 'Ed25519VerificationKey2020',
        controller: witnessId,
        publicKeyMultibase: 'z' + mb,
      },
    ],
    assertionMethod: [keyId],
  };
}
