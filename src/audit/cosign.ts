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
 * ## Implementation choice (host TS today, native swap tomorrow) — the SDK rule
 *
 * The pinned `acdp` binding (`@agentcontextdistributionprotocol/acdp@^0.6.0`)
 * carries the RFC-ACDP-0012 log surface, but NOT the RFC-ACDP-0015 cosignature
 * surface (that landed in the Rust crate — `WitnessSigner` / `WitnessedCheckpoint`
 * / `verify_cosignature` — but not yet the bindings). So the §5 signing
 * construction is implemented HOST-SIDE here, exactly as the checkpoint witness
 * implements the §5/§9 Merkle math in TS. It still takes everything that IS
 * protocol wire format from the SDK: JCS canonicalization
 * (`AcdpCanonicalizer.canonicalize`, RFC 8785) and Ed25519 signature
 * verification (`AcdpVerifier` via `verifySignatureB64`). The signing primitive
 * — Ed25519 over the ASCII bytes of `"sha256:<hex>"` — is `node:crypto`, the
 * same primitive the CP already uses to sign its EdDSA federation JWTs
 * (`src/auth/jwt-signing.ts`) and to sign test checkpoints in the log tests.
 * The byte output is pinned identical to the Rust/Python implementations by the
 * wit-001 golden vector (`cosign.spec.ts`, seed 0x33×32).
 *
 * {@link sdkHasCosignatureSurface} is the feature-detect for the future native
 * swap (mirrors `sdkHasLogSurface` in `log-verify.ts`): when a later binding
 * exposes the cosignature API, mint/verify can delegate to the Rust arithmetic
 * with no call-site change.
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
import { AcdpCanonicalizer } from 'acdp';
import { verifySignatureB64 } from '../auth/acdp-verify';

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
  signAsciiToBase64(message: string): string;
}

/**
 * Build a {@link WitnessSigner} backed by a `node:crypto` Ed25519 private key
 * (loaded from a PEM at boot, or from a raw seed in tests). `key_id` must be a
 * DID URL under `witnessId` (RFC-ACDP-0015 §4).
 */
export function nodeWitnessSigner(
  witnessId: string,
  keyId: string,
  privateKey: KeyObject,
): WitnessSigner {
  return {
    witnessId,
    keyId,
    algorithm: 'ed25519',
    signAsciiToBase64(message: string): string {
      return edSign(null, Buffer.from(message, 'ascii'), privateKey).toString('base64');
    },
  };
}

/**
 * True when the installed `acdp` binding carries a native RFC-ACDP-0015
 * cosignature surface. The 0.6.0 binding does NOT (the Rust crate has
 * `WitnessSigner` but the bindings were not regenerated), so this returns
 * false and mint/verify use the host TS §5 construction below. Mirrors
 * `sdkHasLogSurface()` — when a 0.7.0+ binding ships the API, this flips true
 * and the arithmetic can delegate to Rust with no call-site change.
 */
export function sdkHasCosignatureSurface(): boolean {
  // Probe both the verifier and a producer/signer surface — the NAPI names
  // would be camelCase (`verifyWitnessCosignature`, `signWitnessCosignature`),
  // mirroring the log surface probe. Neither exists on 0.6.0.
  const probes: Array<[unknown, string]> = [];
  try {

    const acdp = require('acdp') as Record<string, unknown>;
    const verifier = acdp.AcdpVerifier as Record<string, unknown> | undefined;
    const producer = acdp.AcdpProducer as Record<string, unknown> | undefined;
    if (verifier) probes.push([verifier.verifyWitnessCosignature, 'verifyWitnessCosignature']);
    if (producer) probes.push([producer.signWitnessCosignature, 'signWitnessCosignature']);
  } catch {
    return false;
  }
  return probes.length === 2 && probes.every(([fn]) => typeof fn === 'function');
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
export function mintCosignature(
  witnessedCheckpoint: WitnessedCheckpoint,
  witnessedAt: string,
  signer: WitnessSigner,
):
  | { ok: true; cosignature: LogCosignature; cosignatureHash: string }
  | { ok: false; reason: string } {
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
 */
export function verifyCosignature(
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
