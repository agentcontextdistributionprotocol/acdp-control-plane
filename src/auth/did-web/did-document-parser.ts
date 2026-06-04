/**
 * Pure DID-document parsing + verification-method extraction.
 *
 * Separated from the network/cache layer so the picker logic is
 * testable without standing up an HTTP stub.
 *
 * The picker enforces the security properties the deferred plan calls out:
 *   - The verification method MUST be authorized in `assertionMethod`
 *     (a key listed only in `verificationMethod` cannot sign challenges).
 *   - The verification method's key type MUST match the requested
 *     algorithm (downgrade defense: an attacker can't claim an Ed25519
 *     sig against a P-256 key by guessing fragment ids).
 *   - The DID document `id` MUST equal the DID we requested
 *     (otherwise a misconfigured server could substitute another DID's
 *     keys).
 */
import { DidDocument, ResolvedKey, VerificationMethod } from './did-document';

export class DidDocumentError extends Error {
  readonly code:
    | 'PARSE_FAILED'
    | 'ID_MISMATCH'
    | 'KEY_NOT_FOUND'
    | 'KEY_NOT_AUTHORIZED'
    | 'UNSUPPORTED_TYPE'
    | 'MALFORMED_KEY'
    | 'ALG_MISMATCH';
  constructor(code: DidDocumentError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export function parseDidDocument(json: unknown, expectedDid: string): DidDocument {
  if (typeof json !== 'object' || json === null) {
    throw new DidDocumentError('PARSE_FAILED', 'DID document is not a JSON object');
  }
  const doc = json as Partial<DidDocument>;
  if (typeof doc.id !== 'string' || !doc.id) {
    throw new DidDocumentError('PARSE_FAILED', 'DID document missing required `id` field');
  }
  if (doc.id !== expectedDid) {
    // RFC 9.1: the document's `id` MUST match the DID being resolved.
    throw new DidDocumentError(
      'ID_MISMATCH',
      `DID document id '${doc.id}' does not match requested DID '${expectedDid}'`,
    );
  }
  return doc as DidDocument;
}

/**
 * Pick a verification method by id (or by algorithm if id is unset),
 * enforcing the assertionMethod authorization gate.
 *
 * `requestedAlg` is matched against the verification method's `type`
 * to defeat algorithm downgrade: a request that claims `ed25519` must
 * resolve a key of type `Ed25519VerificationKey2020` (or a JWK with
 * `kty=OKP,crv=Ed25519`); `ecdsa-p256` requires
 * `kty=EC, crv=P-256`.
 */
export function pickVerificationMethod(
  doc: DidDocument,
  requestedKeyId: string,
  requestedAlg: 'ed25519' | 'ecdsa-p256',
): ResolvedKey {
  const methods = doc.verificationMethod ?? [];
  const found = methods.find((m) => m.id === requestedKeyId);
  if (!found) {
    throw new DidDocumentError(
      'KEY_NOT_FOUND',
      `DID document has no verificationMethod with id '${requestedKeyId}'`,
    );
  }
  if (!isAuthorizedForAssertion(doc, requestedKeyId)) {
    throw new DidDocumentError(
      'KEY_NOT_AUTHORIZED',
      `verificationMethod '${requestedKeyId}' is not in assertionMethod (cannot sign challenges)`,
    );
  }
  return extractKey(found, requestedAlg);
}

function isAuthorizedForAssertion(doc: DidDocument, keyId: string): boolean {
  const am = doc.assertionMethod ?? [];
  for (const entry of am) {
    if (typeof entry === 'string') {
      if (entry === keyId) return true;
    } else if (entry.id === keyId) {
      return true;
    }
  }
  return false;
}

function extractKey(
  m: VerificationMethod,
  requestedAlg: 'ed25519' | 'ecdsa-p256',
): ResolvedKey {
  // Algorithm-downgrade defense (RFC-ACDP-0008 §3.9): if the method's
  // `type` (or its JWK / multibase multicodec prefix) declares an
  // algorithm, it MUST match the requested one before we touch any key
  // bytes. Extraction itself dispatches on `requestedAlg`, mirroring the
  // acdp-rs consumer — `type` is a signal, not a gate, so the set of
  // documents we accept matches what the registry accepts.
  const declared = declaredAlgorithm(m);
  if (declared && declared !== requestedAlg) {
    throw new DidDocumentError(
      'ALG_MISMATCH',
      `requested ${requestedAlg} but verificationMethod '${m.id}' is ${m.type}`,
    );
  }
  return requestedAlg === 'ed25519' ? extractEd25519(m) : extractEcdsaP256(m);
}

function extractEd25519(m: VerificationMethod): ResolvedKey {
  // A JWK takes precedence when present (OKP/Ed25519); otherwise fall
  // back to a multibase-z key. Both forms are accepted regardless of the
  // declared `type`, matching acdp-rs `ed25519_public_key_bytes`.
  if (m.publicKeyJwk) {
    const jwk = m.publicKeyJwk;
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x) {
      throw new DidDocumentError(
        'ALG_MISMATCH',
        `requested ed25519 but JWK kty='${jwk.kty}' crv='${jwk.crv}' x?=${!!jwk.x}`,
      );
    }
    return { keyId: m.id, algorithm: 'ed25519', publicKeyB64: base64UrlToBase64(jwk.x) };
  }
  if (m.publicKeyMultibase) {
    return {
      keyId: m.id,
      algorithm: 'ed25519',
      publicKeyB64: multibaseToBase64Ed25519(m.publicKeyMultibase, m.id),
    };
  }
  throw new DidDocumentError(
    'MALFORMED_KEY',
    `ed25519 verificationMethod '${m.id}' has neither publicKeyJwk nor publicKeyMultibase`,
  );
}

function extractEcdsaP256(m: VerificationMethod): ResolvedKey {
  const jwk = m.publicKeyJwk;
  if (!jwk) {
    // Match acdp-rs exactly: P-256 key bytes come from a JWK only.
    // `publicKeyMultibase` is intentionally unsupported for P-256 on
    // both sides, so we never accept a P-256 document the registry would
    // reject (that would just be the inverse asymmetry).
    throw new DidDocumentError(
      'MALFORMED_KEY',
      `ecdsa-p256 verificationMethod '${m.id}' requires publicKeyJwk ` +
        `(publicKeyMultibase not supported for P-256)`,
    );
  }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new DidDocumentError(
      'ALG_MISMATCH',
      `requested ecdsa-p256 but JWK kty='${jwk.kty}' crv='${jwk.crv}' x?=${!!jwk.x} y?=${!!jwk.y}`,
    );
  }
  return {
    keyId: m.id,
    algorithm: 'ecdsa-p256',
    publicKeyB64: ecJwkToSec1Base64(jwk.x, jwk.y, m.id),
  };
}

/**
 * Best-effort algorithm declaration from the verification method's `type`
 * and (when relevant) its JWK or multibase multicodec prefix. Returns
 * `undefined` when no signal is present. Port of acdp-rs
 * `VerificationMethod::declared_algorithm` (did/document.rs).
 */
function declaredAlgorithm(
  m: VerificationMethod,
): 'ed25519' | 'ecdsa-p256' | undefined {
  switch (m.type) {
    case 'Ed25519VerificationKey2020':
    case 'Ed25519VerificationKey2018':
      return 'ed25519';
    case 'EcdsaSecp256r1VerificationKey2019':
      return 'ecdsa-p256';
    case 'JsonWebKey2020': {
      const jwk = m.publicKeyJwk;
      if (!jwk) return undefined;
      if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') return 'ed25519';
      if (jwk.kty === 'EC' && jwk.crv === 'P-256') return 'ecdsa-p256';
      return undefined;
    }
    // `Multikey` (and any unrecognized type) — derive from the multibase
    // multicodec prefix so the downgrade guard is not silently skipped.
    default:
      return multicodecAlgorithm(m.publicKeyMultibase);
  }
}

/**
 * Map a `publicKeyMultibase` value to its algorithm via the multicodec
 * prefix of the decoded key (unsigned-varint): Ed25519 (`0xed 0x01`) or
 * P-256 (`0x80 0x24`). Returns `undefined` if not base58btc or the codec
 * is unrecognized. Matches acdp-rs `multicodec_algorithm`.
 */
function multicodecAlgorithm(
  mb: string | undefined,
): 'ed25519' | 'ecdsa-p256' | undefined {
  if (!mb || mb[0] !== 'z') return undefined;
  let decoded: Uint8Array;
  try {
    decoded = base58Decode(mb.slice(1));
  } catch {
    return undefined;
  }
  if (decoded.length < 2) return undefined;
  if (decoded[0] === 0xed && decoded[1] === 0x01) return 'ed25519';
  if (decoded[0] === 0x80 && decoded[1] === 0x24) return 'ecdsa-p256';
  return undefined;
}

/**
 * Decode a multibase-z (base58btc) Ed25519 public key per
 * DID Core Multibase + Multicodec 0xed01 prefix, and re-encode the
 * raw 32 bytes as standard base64 for the pinned-key directory.
 */
function multibaseToBase64Ed25519(mb: string, keyId: string): string {
  if (mb[0] !== 'z') {
    throw new DidDocumentError(
      'MALFORMED_KEY',
      `publicKeyMultibase '${keyId}' is not z-base58btc (got prefix '${mb[0]}')`,
    );
  }
  const decoded = base58Decode(mb.slice(1));
  // Multicodec prefix for Ed25519: 0xed 0x01 (varint), then 32 raw bytes.
  if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new DidDocumentError(
      'MALFORMED_KEY',
      `publicKeyMultibase '${keyId}' is not a multicodec-tagged Ed25519 key (length ${decoded.length})`,
    );
  }
  return Buffer.from(decoded.slice(2)).toString('base64');
}

function base64UrlToBase64(s: string): string {
  // Convert base64url (no padding) → standard base64 (with padding).
  let std = s.replace(/-/g, '+').replace(/_/g, '/');
  while (std.length % 4 !== 0) std += '=';
  return std;
}

function ecJwkToSec1Base64(xB64Url: string, yB64Url: string, keyId: string): string {
  const x = Buffer.from(base64UrlToBase64(xB64Url), 'base64');
  const y = Buffer.from(base64UrlToBase64(yB64Url), 'base64');
  if (x.length !== 32 || y.length !== 32) {
    throw new DidDocumentError(
      'MALFORMED_KEY',
      `P-256 JWK '${keyId}' has wrong-length coordinates (x=${x.length} y=${y.length}, expected 32/32)`,
    );
  }
  const sec1 = Buffer.concat([Buffer.from([0x04]), x, y]);
  return sec1.toString('base64');
}

// Minimal base58btc decoder. Pulled in rather than depending on `bs58`
// to keep dep count low — the alphabet is short and the code is small.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX: Record<string, number> = {};
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_INDEX[BASE58_ALPHABET[i]!] = i;
}

function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  let leadingZeros = 0;
  for (const c of s) {
    if (c !== '1') break;
    leadingZeros++;
  }
  const bytes: number[] = [];
  for (const c of s) {
    const v = BASE58_INDEX[c];
    if (v === undefined) {
      throw new DidDocumentError('MALFORMED_KEY', `base58: invalid character '${c}'`);
    }
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Build little-endian byte array → reverse for big-endian.
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < leadingZeros; i++) out[i] = 0;
  for (let i = 0; i < bytes.length; i++) out[leadingZeros + i] = bytes[bytes.length - 1 - i]!;
  return out;
}
