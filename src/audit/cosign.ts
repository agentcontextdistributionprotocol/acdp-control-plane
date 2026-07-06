/**
 * Transparency-log witness cosigning (RFC-ACDP-0015 §4/§5/§8).
 *
 * This is the COSIGN half of the RFC-ACDP-0009 §2.12 witness ecosystem — the
 * work `checkpoint-witness.service.ts` deliberately left unspecified. Once the
 * checkpoint witness has verified a checkpoint's signature (§9.3) and its §7
 * consistency obligation against its retained head, it MINTS a signed
 * `acdp-log-cosignature` object here: the witness's own attestation that it
 * observed and verified a specific `(log_id, tree_size, root_hash, timestamp)`
 * tuple no later than `witnessed_at`, signed with the WITNESS's own key.
 *
 * ## Implementation choice (native binding, TS fallback) — the SDK rule
 *
 * The pinned `acdp` binding (`@agentcontextdistributionprotocol/acdp@^0.7.0`)
 * carries the RFC-ACDP-0015 cosignature surface natively:
 * `AcdpVerifier.buildWitnessCosignature` (MINT, §5),
 * `AcdpVerifier.verifyWitnessCosignature` (VERIFY, §8), and
 * `AcdpVerifier.evaluateWitnessQuorum` (§8 N-witnessed report). When
 * {@link sdkHasCosignatureSurface} is true (0.7.0+), {@link mintCosignature}
 * DELEGATES the §5 signing construction to `buildWitnessCosignature` — the same
 * Rust arithmetic the reference implementation runs — and {@link verifyCosignature}
 * (when handed the full observed checkpoint) delegates §8 to
 * `verifyWitnessCosignature`. The verdicts / bytes are identical to the host TS
 * path; a conformance cross-check (`cosign.spec.ts`) runs the wit-001 golden
 * vector through BOTH paths and asserts the same canonical form, cosignature
 * hash, and signature bytes.
 *
 * The host-side §5 construction (`tsMintCosignature` / `tsVerifyCosignature`) is
 * RETAINED as the fallback for a binding that predates the cosignature surface
 * (≤ 0.6.0) — a witness that cannot mint is useless, so it degrades to the pure,
 * fully-pinned §5 construction rather than crashing. Both branches still take
 * everything that IS protocol wire format from the SDK: JCS canonicalization
 * (`AcdpCanonicalizer.canonicalize`, RFC 8785) and Ed25519 signature
 * verification (`AcdpVerifier` via `verifySignatureB64`). The host signing
 * primitive — Ed25519 over the ASCII bytes of `"sha256:<hex>"` — is
 * `node:crypto`, the same primitive the CP already uses to sign its EdDSA
 * federation JWTs (`src/auth/jwt-signing.ts`). The byte output of BOTH paths is
 * pinned identical to the Rust/Python implementations by the wit-001 golden
 * vector (`cosign.spec.ts`, seed 0x33×32).
 *
 * The §5 construction reuses RFC-ACDP-0010 §5 verbatim:
 *   1. Preimage  = JCS(cosignature − signature).
 *   2. Hash      = "sha256:" + hex(SHA-256(preimage)).
 *   3. Sign-input = the ASCII bytes of the full hash string (prefix included).
 *   4. Sign with the WITNESS's own assertionMethod key.
 *
 * All functions return outcome objects — they never throw on untrusted input.
 */
import { createHash, sign as edSign, type KeyObject } from 'node:crypto';
import { AcdpCanonicalizer, AcdpVerifier } from 'acdp';
import { verifySignatureB64 } from '../auth/acdp-verify';
import type { LogCheckpoint } from './log-verify';

/** RFC-ACDP-0015 §4: the sole cosignature envelope version / domain separator. */
export const COSIGNATURE_VERSION = 'acdp-cosig/1';
/** RFC-ACDP-0015 §8 step 5 skew allowance (RFC-ACDP-0011 §7 step 6). */
export const COSIGNATURE_MAX_FUTURE_SKEW_MS = 120_000;

export type CosignOutcome = { ok: true } | { ok: false; reason: string };

const WIRE_HASH_RE = /^sha256:[0-9a-f]{64}$/;
/** Canonical millisecond-precision RFC 3339 UTC (RFC-ACDP-0001 §5.3). */
const CANONICAL_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** §6: `<did:web DID>/log/<instance>` with instance `[a-z0-9-]{1,32}`. */
const LOG_ID_RE = /^did:web:[A-Za-z0-9._%:-]+\/log\/[a-z0-9-]{1,32}$/;
/** §4: witness_id is a did:web or did:key. */
const WITNESS_DID_RE = /^did:(web:[a-zA-Z0-9.%:-]+|key:z[1-9A-HJ-NP-Za-km-z]+)$/;

/**
 * The identity-bearing subset of an RFC-ACDP-0012 §6 checkpoint the witness
 * observed (RFC-ACDP-0015 §4 `witnessed_checkpoint`): closed
 * `{log_id, tree_size, root_hash, timestamp}`, copied verbatim.
 */
export interface WitnessedCheckpoint {
  log_id: string;
  tree_size: number;
  root_hash: string;
  /** The registry-CLAIMED checkpoint time; the witness copies, never vouches. */
  timestamp: string;
}

/** The signed `acdp-log-cosignature` object (RFC-ACDP-0015 §4). */
export interface LogCosignature {
  cosignature_version: string;
  witness_id: string;
  witnessed_checkpoint: WitnessedCheckpoint;
  witnessed_at: string;
  signature: { algorithm: string; key_id: string; value: string };
}

/**
 * The witness signing identity. `signAsciiToBase64` signs the ASCII bytes of a
 * message (the cosignature hash string) with the witness's Ed25519 key and
 * returns standard base64 — the §5 step 3/4 primitive. Kept as an interface so
 * a future native-binding signer can slot in behind the same shape.
 */
export interface WitnessSigner {
  witnessId: string;
  keyId: string;
  algorithm: 'ed25519';
  /**
   * The witness Ed25519 signing seed as hex, when it can be recovered from the
   * key material. Present for `node:crypto` keys; enables the native
   * `buildWitnessCosignature` MINT path (which takes a seed, not a KeyObject).
   * `undefined` forces the host TS mint. Never logged or serialized.
   */
  seedHex?: string;
  signAsciiToBase64(message: string): string;
}

/**
 * Build a {@link WitnessSigner} backed by a `node:crypto` Ed25519 private key
 * (loaded from a PEM at boot, or from a raw seed in tests). `key_id` must be a
 * DID URL under `witnessId` (RFC-ACDP-0015 §4). The raw 32-byte seed is
 * extracted from the PKCS#8 DER (Ed25519 private keys serialize as a fixed
 * 48-byte DER whose last 32 bytes are the seed) so the native MINT path can use
 * it; extraction failures leave `seedHex` undefined and simply keep the host
 * mint.
 */
export function nodeWitnessSigner(
  witnessId: string,
  keyId: string,
  privateKey: KeyObject,
): WitnessSigner {
  let seedHex: string | undefined;
  try {
    const der = privateKey.export({ format: 'der', type: 'pkcs8' });
    if (der.length === 48) seedHex = Buffer.from(der).subarray(16, 48).toString('hex');
  } catch {
    seedHex = undefined;
  }
  return {
    witnessId,
    keyId,
    algorithm: 'ed25519',
    seedHex,
    signAsciiToBase64(message: string): string {
      return edSign(null, Buffer.from(message, 'ascii'), privateKey).toString('base64');
    },
  };
}

/**
 * True when the installed `acdp` binding carries the native RFC-ACDP-0015
 * cosignature surface (0.7.0+). The probed names are the binding's public
 * static `AcdpVerifier` methods — the NAPI surface is camelCase
 * (`buildWitnessCosignature`, not `build_witness_cosignature`), so these match
 * the published methods exactly. When true, {@link mintCosignature} delegates
 * the §5 MINT to `buildWitnessCosignature` and {@link verifyCosignature}
 * delegates the §8 VERIFY to `verifyWitnessCosignature`; when false they fall
 * back to the host TS §5 construction below. (`evaluateWitnessQuorum` is the
 * §8 N-witnessed report — probed so the detect only trips on the complete
 * surface, exercised in the wit-003 parity cross-check.)
 */
export function sdkHasCosignatureSurface(): boolean {
  const v = AcdpVerifier as unknown as Record<string, unknown>;
  return (
    typeof v.buildWitnessCosignature === 'function' &&
    typeof v.verifyWitnessCosignature === 'function' &&
    typeof v.evaluateWitnessQuorum === 'function'
  );
}

/** The RFC-ACDP-0015 §5/§8 cosignature surface on the 0.7.0+ binding. */
interface CosignCapableVerifier {
  buildWitnessCosignature(
    witnessedCheckpointJson: string,
    witnessDid: string,
    witnessSeedHex: string,
    witnessedAtRfc3339: string,
  ): string;
  verifyWitnessCosignature(
    cosigJson: string,
    witnessDidDocJson: string,
    expectedCheckpointJson: string,
    nowRfc3339?: string | null,
    maxClockSkewSecs?: number | null,
  ): string;
}

/** Map a native error (which may carry a `.code`) to a reason string. */
function nativeErr(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    return `${String((err as { code: unknown }).code)}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * The §5 cosignature preimage hash: `"sha256:" + hex(SHA-256(JCS(cosig −
 * signature)))`. JCS comes from the SDK (RFC 8785); only SHA-256 is
 * node:crypto. `unsigned` is the cosignature object WITHOUT its `signature`
 * member. Returns null if it cannot be canonicalized.
 */
export function cosignatureHash(unsigned: Omit<LogCosignature, 'signature'>): string | null {
  let canonical: string;
  try {
    canonical = AcdpCanonicalizer.canonicalize(JSON.stringify(unsigned));
  } catch {
    return null;
  }
  const digest = createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
  return `sha256:${digest}`;
}

/**
 * Mint a cosignature over an observed checkpoint (RFC-ACDP-0015 §4–§5). The
 * caller has already discharged the §7 obligation (signature + consistency);
 * this only performs the §5 signing construction. Returns the signed object
 * plus its hash, or an error if the object cannot be canonicalized.
 */
export type MintOutcome =
  | { ok: true; cosignature: LogCosignature; cosignatureHash: string }
  | { ok: false; reason: string };

export function mintCosignature(
  witnessedCheckpoint: WitnessedCheckpoint,
  witnessedAt: string,
  signer: WitnessSigner,
): MintOutcome {
  // Native (0.7.0+) when the surface is present, the signer exposes its seed,
  // and the key_id follows the binding's fixed `<witnessId>#witness-key-1`
  // convention (`buildWitnessCosignature` mints under exactly that key id, so a
  // custom key id can only be served by the host path). A native failure
  // degrades to the byte-identical host mint so a witness never stalls.
  if (canNativeMint(signer)) {
    const native = nativeMintCosignature(witnessedCheckpoint, witnessedAt, signer);
    if (native.ok) return native;
  }
  return tsMintCosignature(witnessedCheckpoint, witnessedAt, signer);
}

/** True when {@link mintCosignature} can route this signer through the binding. */
function canNativeMint(signer: WitnessSigner): boolean {
  return (
    sdkHasCosignatureSurface() &&
    typeof signer.seedHex === 'string' &&
    signer.keyId === `${signer.witnessId}#witness-key-1`
  );
}

/**
 * The native-binding branch of {@link mintCosignature} (exported for the parity
 * cross-check): delegate the §5 construction to `AcdpVerifier.buildWitnessCosignature`.
 * The binding mints under `<witnessId>#witness-key-1` and signs the ASCII bytes
 * of the `"sha256:<hex>"` cosignature hash — byte-identical to the host path.
 */
export function nativeMintCosignature(
  witnessedCheckpoint: WitnessedCheckpoint,
  witnessedAt: string,
  signer: WitnessSigner,
): MintOutcome {
  if (typeof signer.seedHex !== 'string') {
    return { ok: false, reason: 'signer exposes no seed for the native mint path' };
  }
  const surface = AcdpVerifier as unknown as CosignCapableVerifier;
  let json: string;
  try {
    json = surface.buildWitnessCosignature(
      JSON.stringify({
        log_id: witnessedCheckpoint.log_id,
        tree_size: witnessedCheckpoint.tree_size,
        root_hash: witnessedCheckpoint.root_hash,
        timestamp: witnessedCheckpoint.timestamp,
      }),
      signer.witnessId,
      signer.seedHex,
      witnessedAt,
    );
  } catch (err) {
    return { ok: false, reason: nativeErr(err) };
  }
  let cosignature: LogCosignature;
  try {
    cosignature = JSON.parse(json) as LogCosignature;
  } catch {
    return { ok: false, reason: 'native mint returned non-JSON' };
  }
  const { signature: _omit, ...unsigned } = cosignature;
  const hash = cosignatureHash(unsigned);
  if (hash === null) {
    return { ok: false, reason: 'native cosignature could not be canonicalized (JCS)' };
  }
  return { ok: true, cosignature, cosignatureHash: hash };
}

/**
 * The host-arithmetic branch of {@link mintCosignature} (exported for the parity
 * cross-check): the pure §5 construction over SDK JCS + node:crypto Ed25519.
 */
export function tsMintCosignature(
  witnessedCheckpoint: WitnessedCheckpoint,
  witnessedAt: string,
  signer: WitnessSigner,
): MintOutcome {
  const unsigned: Omit<LogCosignature, 'signature'> = {
    cosignature_version: COSIGNATURE_VERSION,
    witness_id: signer.witnessId,
    witnessed_checkpoint: {
      log_id: witnessedCheckpoint.log_id,
      tree_size: witnessedCheckpoint.tree_size,
      root_hash: witnessedCheckpoint.root_hash,
      timestamp: witnessedCheckpoint.timestamp,
    },
    witnessed_at: witnessedAt,
  };
  const hash = cosignatureHash(unsigned);
  if (hash === null) {
    return { ok: false, reason: 'cosignature could not be canonicalized (JCS)' };
  }
  const value = signer.signAsciiToBase64(hash);
  return {
    ok: true,
    cosignatureHash: hash,
    cosignature: {
      ...unsigned,
      signature: {
        algorithm: signer.algorithm,
        key_id: signer.keyId,
        value,
      },
    },
  };
}

/**
 * §8 step 1 — closed-schema parse of a cosignature. Exactly the five members,
 * `cosignature_version` exactly `"acdp-cosig/1"`, closed `witnessed_checkpoint`
 * and `signature` sub-objects, well-formed `log_id` / `root_hash` / canonical-ms
 * timestamps. Every member is signed, so an unknown or missing member fails.
 */
export function parseCosignature(
  raw: unknown,
): { ok: true; cosignature: LogCosignature } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'cosignature is not a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  const expected = [
    'cosignature_version',
    'witness_id',
    'witnessed_checkpoint',
    'witnessed_at',
    'signature',
  ];
  const keys = Object.keys(obj);
  const extra = keys.filter((k) => !expected.includes(k));
  const missing = expected.filter((k) => !keys.includes(k));
  if (extra.length > 0 || missing.length > 0) {
    return {
      ok: false,
      reason:
        `cosignature schema violation (closed §4 object): ` +
        `missing=[${missing.join(',')}] unknown=[${extra.join(',')}]`,
    };
  }
  if (obj.cosignature_version !== COSIGNATURE_VERSION) {
    return {
      ok: false,
      reason: `cosignature_version must be '${COSIGNATURE_VERSION}', got '${String(obj.cosignature_version)}'`,
    };
  }
  if (typeof obj.witness_id !== 'string' || !WITNESS_DID_RE.test(obj.witness_id)) {
    return { ok: false, reason: `malformed witness_id '${String(obj.witness_id)}'` };
  }
  const wcErr = validateWitnessedCheckpoint(obj.witnessed_checkpoint);
  if (wcErr) return { ok: false, reason: wcErr };
  if (
    typeof obj.witnessed_at !== 'string' ||
    !CANONICAL_TS_RE.test(obj.witnessed_at) ||
    !Number.isFinite(Date.parse(obj.witnessed_at))
  ) {
    return { ok: false, reason: 'witnessed_at is not canonical ms-precision RFC 3339 UTC' };
  }
  const sig = obj.signature;
  if (sig === null || typeof sig !== 'object' || Array.isArray(sig)) {
    return { ok: false, reason: 'signature is not an object' };
  }
  const s = sig as Record<string, unknown>;
  if (
    Object.keys(s).sort().join(',') !== 'algorithm,key_id,value' ||
    typeof s.algorithm !== 'string' ||
    typeof s.key_id !== 'string' ||
    typeof s.value !== 'string'
  ) {
    return { ok: false, reason: 'signature must be the closed {algorithm,key_id,value} object' };
  }
  return { ok: true, cosignature: obj as unknown as LogCosignature };
}

function validateWitnessedCheckpoint(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'witnessed_checkpoint is not an object';
  }
  const o = raw as Record<string, unknown>;
  const expected = ['log_id', 'tree_size', 'root_hash', 'timestamp'];
  const keys = Object.keys(o);
  if (
    keys.filter((k) => !expected.includes(k)).length > 0 ||
    expected.filter((k) => !keys.includes(k)).length > 0
  ) {
    return 'witnessed_checkpoint schema violation (closed {log_id,tree_size,root_hash,timestamp})';
  }
  if (typeof o.log_id !== 'string' || !LOG_ID_RE.test(o.log_id)) {
    return `witnessed_checkpoint.log_id is malformed`;
  }
  if (typeof o.tree_size !== 'number' || !Number.isInteger(o.tree_size) || o.tree_size < 0) {
    return 'witnessed_checkpoint.tree_size must be an integer >= 0';
  }
  if (typeof o.root_hash !== 'string' || !WIRE_HASH_RE.test(o.root_hash)) {
    return 'witnessed_checkpoint.root_hash is malformed';
  }
  if (
    typeof o.timestamp !== 'string' ||
    !CANONICAL_TS_RE.test(o.timestamp) ||
    !Number.isFinite(Date.parse(o.timestamp))
  ) {
    return 'witnessed_checkpoint.timestamp is not canonical ms-precision RFC 3339 UTC';
  }
  return null;
}

/**
 * §8 steps 2–3 — verify a cosignature under the witness's resolved
 * assertionMethod public key. Recompute the §5 preimage hash over
 * `cosig − signature`, verify `signature.value` over its ASCII bytes with the
 * witness key, and enforce the witness binding (the DID portion of
 * `signature.key_id` MUST equal `witness_id`).
 *
 * The `witnessPublicKeyB64` is the WITNESS's own key (resolved from the witness
 * DID's `assertionMethod`), NOT the registry's — that independence is the whole
 * point (§5). A failure here surfaces as `invalid_witness_cosignature` (§10).
 * Ed25519 verify goes through the SDK (`verifySignatureB64`), the same
 * parity-guaranteed path the checkpoint witness uses.
 *
 * Native (0.7.0+): when `expectedCheckpoint` (the full §6 checkpoint the caller
 * independently holds) is supplied AND the binding carries the cosignature
 * surface, the §8 verification delegates to `AcdpVerifier.verifyWitnessCosignature`
 * — witness binding, checkpoint binding, and signature all in Rust. Without a
 * checkpoint, or on a ≤0.6.0 binding, it runs the host §8 steps 2–3 below. Both
 * paths return the same verdict for a well-formed cosignature.
 */
export function verifyCosignature(
  cosignature: LogCosignature,
  witnessPublicKeyB64: string,
  expectedCheckpoint?: LogCheckpoint,
): CosignOutcome {
  if (expectedCheckpoint !== undefined && sdkHasCosignatureSurface()) {
    return nativeVerifyCosignature(cosignature, witnessPublicKeyB64, expectedCheckpoint);
  }
  return tsVerifyCosignature(cosignature, witnessPublicKeyB64);
}

/**
 * The native-binding branch of {@link verifyCosignature} (exported for the
 * parity cross-check). Synthesizes the witness's resolved DID document from the
 * raw public key (the shape §8 step 2 dereferences) and delegates the §8
 * verification to `AcdpVerifier.verifyWitnessCosignature` against the caller's
 * verified checkpoint.
 */
export function nativeVerifyCosignature(
  cosignature: LogCosignature,
  witnessPublicKeyB64: string,
  expectedCheckpoint: LogCheckpoint,
): CosignOutcome {
  const surface = AcdpVerifier as unknown as CosignCapableVerifier;
  const didDoc = witnessDidDocFromPubkey(
    cosignature.witness_id,
    cosignature.signature.key_id,
    witnessPublicKeyB64,
  );
  let json: string;
  try {
    json = surface.verifyWitnessCosignature(
      JSON.stringify(cosignature),
      JSON.stringify(didDoc),
      JSON.stringify(expectedCheckpoint),
    );
  } catch (err) {
    return { ok: false, reason: nativeErr(err) };
  }
  let parsed: { valid?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(json) as { valid?: unknown; error?: unknown };
  } catch {
    return { ok: false, reason: 'native cosignature verification returned non-JSON' };
  }
  if (parsed.valid === true) return { ok: true };
  return {
    ok: false,
    reason:
      typeof parsed.error === 'string' ? parsed.error : 'native cosignature verification failed',
  };
}

/** The host-arithmetic branch of {@link verifyCosignature} (§8 steps 2–3). */
export function tsVerifyCosignature(
  cosignature: LogCosignature,
  witnessPublicKeyB64: string,
): CosignOutcome {
  if (cosignature.signature.algorithm !== 'ed25519') {
    return {
      ok: false,
      reason: `unsupported cosignature algorithm '${cosignature.signature.algorithm}' — ed25519 is mandatory (RFC-ACDP-0015 §5)`,
    };
  }
  // §8 step 3: witness binding — the signing key must belong to witness_id.
  const keyDid = stripFragment(cosignature.signature.key_id);
  if (keyDid !== cosignature.witness_id) {
    return {
      ok: false,
      reason: `signature.key_id '${cosignature.signature.key_id}' is not a key of witness_id '${cosignature.witness_id}'`,
    };
  }
  const { signature: _omit, ...unsigned } = cosignature;
  const hash = cosignatureHash(unsigned);
  if (hash === null) {
    return { ok: false, reason: 'cosignature could not be canonicalized (JCS)' };
  }
  const valid = verifySignatureB64(
    'ed25519',
    witnessPublicKeyB64,
    hash,
    cosignature.signature.value,
  );
  return valid ? { ok: true } : { ok: false, reason: 'witness cosignature signature invalid' };
}

/** §8 step 5: `witnessed_at` must not be in the future beyond the skew allowance. */
export function cosignatureFreshnessOk(
  cosignature: LogCosignature,
  nowMs: number = Date.now(),
): CosignOutcome {
  const ts = Date.parse(cosignature.witnessed_at);
  if (ts - nowMs > COSIGNATURE_MAX_FUTURE_SKEW_MS) {
    return {
      ok: false,
      reason: `witnessed_at '${cosignature.witnessed_at}' is in the future beyond the 120s skew allowance`,
    };
  }
  return { ok: true };
}

/** The `did:web:...` / `did:key:...` DID with any `#fragment` stripped. */
function stripFragment(didUrl: string): string {
  const hash = didUrl.indexOf('#');
  return hash === -1 ? didUrl : didUrl.slice(0, hash);
}

/**
 * Build the resolvable witness DID document `AcdpVerifier.verifyWitnessCosignature`
 * dereferences (§8 step 2) from the witness's raw Ed25519 public key. The
 * standard-base64 key becomes the single `Ed25519VerificationKey2020`
 * `assertionMethod` entry, encoded as `did:key`-style multibase (multicodec
 * 0xed01). Mirrors `WitnessSigningService.didDocument()`.
 */
function witnessDidDocFromPubkey(
  witnessId: string,
  keyId: string,
  publicKeyB64: string,
): Record<string, unknown> {
  const raw = Buffer.from(publicKeyB64, 'base64');
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: witnessId,
    verificationMethod: [
      {
        id: keyId,
        type: 'Ed25519VerificationKey2020',
        controller: witnessId,
        publicKeyMultibase: ed25519Multibase(raw),
      },
    ],
    assertionMethod: [keyId],
  };
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Encode a raw 32-byte Ed25519 key as `did:key`-style multibase (0xed01 prefix). */
function ed25519Multibase(rawPub: Buffer): string {
  const prefixed = Buffer.concat([Buffer.from([0xed, 0x01]), rawPub]);
  let x = BigInt('0x' + (prefixed.toString('hex') || '0'));
  let out = '';
  while (x > 0n) {
    out = BASE58_ALPHABET[Number(x % 58n)] + out;
    x /= 58n;
  }
  for (const byte of prefixed) {
    if (byte === 0) out = BASE58_ALPHABET[0] + out;
    else break;
  }
  return 'z' + out;
}
