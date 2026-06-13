/**
 * The resolver's output shape.
 *
 * DID-document parsing and verification-method key extraction now live
 * in `acdp-rs` (exposed via the `acdp` SDK's `AcdpDidDocument`), so the
 * W3C DID-document interfaces and the hand-ported key-decoding code that
 * used to live here are gone. All that remains is the canonical
 * raw-bytes form the rest of the auth stack speaks.
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

/**
 * A resolved registry **receipt** signing key (RFC-ACDP-0010 §9). Same
 * raw-bytes shape as {@link ResolvedKey} plus the lifecycle signal: a
 * retired receipt key (retained in `verificationMethod` but no longer in
 * `assertionMethod`) resolves with `historical: true` — the receipt still
 * verifies, but as *historically authorized* rather than current.
 */
export interface ResolvedReceiptKey extends ResolvedKey {
  historical: boolean;
}
