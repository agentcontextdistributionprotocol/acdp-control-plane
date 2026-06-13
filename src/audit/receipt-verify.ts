/**
 * Registry-receipt verification, delegated to the `acdp` Node SDK
 * (RFC-ACDP-0010). Same discipline as `src/auth/acdp-verify.ts`: the
 * receipt's closed-schema parse, the JCS preimage over the raw wire JSON,
 * the offline cross-checks and the Ed25519 signature check all live in
 * `acdp-rs` — the control plane accepts exactly the receipts the registry
 * and the reference consumer accept, with no parallel implementation.
 *
 * The receipt API (`AcdpVerifier.verifyReceipt`, `fingerprintEd25519B64`,
 * `verifyBodyOffline`) ships in `acdp` 0.4.0+ (the pinned dependency).
 * `sdkSupportsReceipts()` feature-detects it at runtime: on an older
 * binding (≤ 0.3.0) the audit sweep degrades to structural cross-checks
 * only (no signature verification) instead of crashing — a downgrade
 * weakens the audit loudly (boot warning) rather than breaking ingest.
 */
import { AcdpVerifier } from 'acdp';

/** The post-0.3.0 receipt surface, absent from the published 0.3.0 typings. */
interface ReceiptCapableVerifier {
  verifyReceipt(
    receiptJson: string,
    registryPublicKeyB64: string,
    expectedCtxId: string,
    recomputedBodyHash: string,
    producerKeyFingerprint: string,
  ): boolean;
  fingerprintEd25519B64(publicKeyB64: string): string;
  verifyBodyOffline(bodyJson: string): boolean;
}

const verifier = AcdpVerifier as unknown as Partial<ReceiptCapableVerifier>;

/** True when the installed `acdp` binding carries the RFC-ACDP-0010 API. */
export function sdkSupportsReceipts(): boolean {
  return (
    typeof verifier.verifyReceipt === 'function' &&
    typeof verifier.fingerprintEd25519B64 === 'function'
  );
}

export type VerifyOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Verify a body's `content_hash` by independent recomputation. On success
 * the echoed hash string is PROVEN equal to the recomputation, so it is
 * safe to feed to `verifyReceipt` as `recomputedBodyHash`.
 */
export function verifyContentHash(bodyJson: string, expectedHash: string): VerifyOutcome {
  try {
    AcdpVerifier.verifyContentHash(bodyJson, expectedHash);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: errMsg(e) };
  }
}

/**
 * Full receipt verification (signature + offline cross-checks). Throws if
 * the installed SDK predates the receipt API — guard with
 * `sdkSupportsReceipts()` first.
 */
export function verifyReceipt(
  receiptJson: string,
  registryPublicKeyB64: string,
  expectedCtxId: string,
  recomputedBodyHash: string,
  producerKeyFingerprint: string,
): VerifyOutcome {
  if (typeof verifier.verifyReceipt !== 'function') {
    throw new TypeError('installed acdp SDK has no verifyReceipt (need > 0.3.0)');
  }
  try {
    verifier.verifyReceipt(
      receiptJson,
      registryPublicKeyB64,
      expectedCtxId,
      recomputedBodyHash,
      producerKeyFingerprint,
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: errMsg(e) };
  }
}

/**
 * `"sha256:<64-hex>"` fingerprint of a raw Ed25519 public key — the
 * RFC-ACDP-0010 §6 encoding the receipt's `key_fingerprint` carries.
 * Throws if the installed SDK predates the receipt API.
 */
export function fingerprintEd25519B64(publicKeyB64: string): string {
  if (typeof verifier.fingerprintEd25519B64 !== 'function') {
    throw new TypeError('installed acdp SDK has no fingerprintEd25519B64 (need > 0.3.0)');
  }
  return verifier.fingerprintEd25519B64(publicKeyB64);
}

/**
 * Offline verification of a did:key body (signature against the key embedded
 * in the DID itself — no resolution, no network). Returns false when the SDK
 * predates the API; callers treat that as "not independently verified".
 */
export function verifyBodyOffline(bodyJson: string): VerifyOutcome {
  if (typeof verifier.verifyBodyOffline !== 'function') {
    return { ok: false, reason: 'installed acdp SDK has no verifyBodyOffline (need > 0.3.0)' };
  }
  try {
    verifier.verifyBodyOffline(bodyJson);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: errMsg(e) };
  }
}

function errMsg(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e) {
    return `${String((e as { code: unknown }).code)}: ${e instanceof Error ? e.message : String(e)}`;
  }
  return e instanceof Error ? e.message : String(e);
}
