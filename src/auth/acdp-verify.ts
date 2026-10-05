/**
 * Signature verification + public-key validation, delegated to the
 * `acdp` Node SDK (NAPI binding over the Rust `acdp` crate).
 *
 * The control plane no longer hand-ports the Ed25519 / ECDSA-P256 verify
 * wire formats (SPKI envelopes, IEEE-1363 vs DER, the §5.8 signing
 * input). Those primitives live in `acdp-rs` and are exposed verbatim
 * via `AcdpVerifier`, so a signature this control plane accepts is
 * byte-for-byte the same set the registry accepts — no parallel
 * implementation to drift (RFC-ACDP-0001 §5.8, RFC-ACDP-0008 §3.9).
 *
 * `AcdpVerifier.verifySignature*` returns `true` on success and *throws*
 * on any failure (bad signature, malformed key/sig, wrong length). The
 * rest of the auth stack expects a boolean, so we translate the throw
 * into `false` here — the single boundary where that mapping happens.
 */
import { AcdpVerifier } from '@agentcontextdistributionprotocol/acdp';

export type SignatureAlgorithm = 'ed25519' | 'ecdsa-p256';

/**
 * Verify a detached signature over `message` (the ASCII bytes of the
 * canonical signing input — a challenge, a capability assertion, or a
 * `content_hash`). `publicKeyB64` is standard base64 of the raw key
 * bytes: 32-byte Ed25519, or 65-byte SEC1-uncompressed P-256.
 *
 * Returns `true` only on a valid signature; never throws.
 */
export function verifySignatureB64(
  algorithm: SignatureAlgorithm,
  publicKeyB64: string,
  message: string,
  signatureB64: string,
): boolean {
  try {
    return algorithm === 'ed25519'
      ? AcdpVerifier.verifySignature(publicKeyB64, signatureB64, message)
      : AcdpVerifier.verifySignatureP256(publicKeyB64, signatureB64, message);
  } catch {
    // Malformed key/sig or a verification failure — all map to "not valid".
    return false;
  }
}

/**
 * Validate that `publicKeyB64` decodes to a well-formed raw public key
 * for `algorithm`. Throws on a malformed key so callers (the pinned-key
 * loader) can skip a bad entry at boot rather than failing later inside
 * `verifySignatureB64`.
 *
 * The binding verifies key bytes as part of signature checking but has
 * no standalone validator, so we keep the cheap structural check here:
 *   - ed25519:    exactly 32 raw bytes
 *   - ecdsa-p256: 65-byte SEC1 uncompressed (`0x04 || X(32) || Y(32)`)
 */
export function assertValidPublicKey(
  algorithm: SignatureAlgorithm,
  publicKeyB64: string,
): void {
  const raw = Buffer.from(publicKeyB64, 'base64');
  if (algorithm === 'ed25519') {
    if (raw.length !== 32) {
      throw new Error(`Ed25519 public key must be 32 bytes, got ${raw.length}`);
    }
    return;
  }
  if (raw.length !== 65) {
    throw new Error(
      `P-256 SEC1 public key must be 65 bytes (uncompressed), got ${raw.length}`,
    );
  }
  if (raw[0] !== 0x04) {
    throw new Error(
      `P-256 SEC1 public key must start with 0x04 (uncompressed tag); got 0x${raw[0]!.toString(16)}`,
    );
  }
}

/**
 * RFC-ACDP-0001 §5.10 `sig-004-ed25519-strict-negative` (embedded so the boot
 * check needs no spec checkout): identity public key, identity R, s = 0. The
 * loose equation [s]B = R + [k]A holds for EVERY message, so a non-strict
 * verifier accepts it; a conformant one MUST reject it (`invalid_signature`).
 */
const SIG_004_PUBLIC_KEY_B64 = 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const SIG_004_SIGNATURE_B64 =
  'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
const SIG_004_SIGNATURE_INPUT =
  'sha256:ccd2641662848a5168095e629c2c90336441bc0d61464e3d8066ea3c147fbaea';

/**
 * Boot-time self-test: refuse to run on an SDK binding that verifies Ed25519
 * non-strictly. The lockfile pins a strict `acdp` (>= 0.14.4), but a
 * mis-resolved native `optionalDependency` could still load an older binary;
 * every audit verdict this control plane records would then violate a MUST.
 * Throws (boot-time only — exempt from the request-path `throw new Error` rule).
 */
export function assertStrictEd25519(): void {
  if (
    verifySignatureB64(
      'ed25519',
      SIG_004_PUBLIC_KEY_B64,
      SIG_004_SIGNATURE_INPUT,
      SIG_004_SIGNATURE_B64,
    )
  ) {
    throw new Error(
      'The loaded acdp SDK binding verifies Ed25519 non-strictly: it accepted the ' +
        'RFC-ACDP-0001 §5.10 sig-004 small-order forgery. Refusing to start. ' +
        'Install acdp >= 0.14.4 with its native package (run `npm ci`).',
    );
  }
}
