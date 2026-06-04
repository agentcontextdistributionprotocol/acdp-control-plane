/**
 * DID document shape (W3C DID Core 1.0, JSON form) — only the fields
 * the resolver consults. Unknown fields are preserved during parse
 * but never read.
 *
 * https://www.w3.org/TR/did-core/#did-document-properties
 */

export interface VerificationMethod {
  /** Full DID URL, e.g. `did:web:example.com:agents:alice#key-1`. */
  id: string;
  /** DID of the controlling identity. */
  controller: string;
  /**
   * Key-encoding type. Mirrors the set `acdp-rs`/`acdp-registry-rs`
   * accept so an agent the registry authenticates also authenticates
   * here (RFC-ACDP-0008 §3.9). Extraction dispatches on the *requested
   * algorithm*, not on `type`; `type` (plus the JWK/multibase contents)
   * only supplies the algorithm-downgrade signal. Supported:
   *   - `Ed25519VerificationKey2020` / `Ed25519VerificationKey2018` → ed25519
   *   - `EcdsaSecp256r1VerificationKey2019`                          → ecdsa-p256
   *   - `JsonWebKey2020` (OKP/Ed25519 or EC/P-256)
   *   - `Multikey` (algorithm derived from the multibase multicodec prefix)
   */
  type:
    | 'Ed25519VerificationKey2020'
    | 'Ed25519VerificationKey2018'
    | 'EcdsaSecp256r1VerificationKey2019'
    | 'JsonWebKey2020'
    | 'Multikey';
  /** Multibase-encoded public key (only with `Ed25519VerificationKey2020`). */
  publicKeyMultibase?: string;
  /** JWK (only with `JsonWebKey2020`). */
  publicKeyJwk?: {
    kty?: string;
    crv?: string;
    x?: string;
    y?: string;
    alg?: string;
  };
}

export interface DidDocument {
  /** Per spec, MAY be a string or an array of strings. */
  '@context'?: string | string[];
  /** The DID this document describes. MUST equal the requested DID. */
  id: string;
  /** Verification methods declared by this DID. */
  verificationMethod?: VerificationMethod[];
  /**
   * DID URLs (or inline VerificationMethods) authorized for "assertion"
   * purposes — i.e. signing. We REQUIRE the verification method's id to
   * appear here; a key declared in `verificationMethod` but absent from
   * `assertionMethod` is NOT usable for proving challenges.
   */
  assertionMethod?: Array<string | VerificationMethod>;
}

/**
 * Extracted public key in the canonical raw-bytes form the rest of
 * the auth stack already speaks (base64, like PinnedKeysService).
 */
export interface ResolvedKey {
  /** Verification method id (full DID URL with fragment). */
  keyId: string;
  /** `ed25519` or `ecdsa-p256`. */
  algorithm: 'ed25519' | 'ecdsa-p256';
  /**
   * Standard-base64 raw key bytes:
   *   - ed25519:    32 bytes
   *   - ecdsa-p256: 65-byte SEC1 uncompressed (`0x04 || X || Y`)
   */
  publicKeyB64: string;
}
