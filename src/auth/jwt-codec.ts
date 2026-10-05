/**
 * JWT sign/verify codec with real EdDSA (Ed25519) support.
 *
 * The bundled `jsonwebtoken` (+ `jwa`) does NOT implement EdDSA — it rejects
 * the algorithm outright ("not a valid algorithm"). So a control plane
 * configured with `JWT_SIGNING_ALG=EdDSA`, or one verifying an EdDSA token
 * from a trusted peer's JWKS, would throw at runtime even though the rest of
 * the stack (jwt-signing material, JWKS publication, trusted-issuer parsing)
 * is built for it.
 *
 * This codec closes that gap WITHOUT a new dependency: Node's `crypto`
 * signs Ed25519 (algorithm identifier `null` — the digest is intrinsic to the
 * curve), but VERIFICATION goes through the `acdp` SDK (`verifySignatureB64`),
 * which enforces RFC-ACDP-0001 §5.10 strict Ed25519 (reject `s >= L` and
 * small-order A or R) by construction rather than by whichever OpenSSL this
 * Node happens to link. HS256 still delegates to `jsonwebtoken` so its
 * behavior is unchanged.
 *
 * Each call site allows exactly ONE algorithm (the configured signing alg, or
 * the trusted issuer's declared alg), so there is no alg-confusion surface:
 * `verifyJwt` rejects any token whose header `alg` isn't in the allowed set
 * before selecting a verification path.
 */
import { createPublicKey, KeyObject, sign as cryptoSign } from 'node:crypto';
import { verifySignatureB64 } from './acdp-verify';
import jwt, { type Algorithm, type Secret, type SignOptions } from 'jsonwebtoken';

export type JwtAlgorithm = 'HS256' | 'EdDSA';

/** Anything Node's crypto / jsonwebtoken accept as a key. */
export type KeyLike = Secret | KeyObject | string;

export interface SignJwtOptions {
  algorithm: JwtAlgorithm;
  key: KeyLike;
  /** Header `kid` (key id) for verifier key selection during rotation. */
  keyid?: string;
}

export interface VerifyJwtOptions {
  /** Allowed algorithms. A token whose header alg is absent here is rejected. */
  algorithms: JwtAlgorithm[];
  key: KeyLike;
  issuer?: string;
  audience?: string;
  /** Seconds of leeway applied to exp/nbf. Defaults to 0. */
  clockToleranceSec?: number;
}

/**
 * Sign a finished claim set. The payload is signed verbatim — callers stamp
 * `iat`/`nbf`/`exp` themselves (so HS256 keeps `noTimestamp: true` semantics
 * and EdDSA matches).
 */
export function signJwt(payload: Record<string, unknown>, opts: SignJwtOptions): string {
  if (opts.algorithm === 'EdDSA') {
    return signEdDSA(payload, opts.key, opts.keyid);
  }
  // jsonwebtoken rejects `keyid: undefined`, so only set it when present.
  const signOptions: SignOptions = { algorithm: opts.algorithm as Algorithm, noTimestamp: true };
  if (opts.keyid) signOptions.keyid = opts.keyid;
  return jwt.sign(payload, opts.key as Secret, signOptions);
}

/**
 * Verify a token and return its claims. Throws (plain `Error`) on any failure
 * — bad signature, wrong alg, expired, not-yet-valid, issuer/audience
 * mismatch — mirroring `jsonwebtoken`'s contract so existing callers keep
 * wrapping the rejection in `UnauthorizedException`.
 */
export function verifyJwt(token: string, opts: VerifyJwtOptions): Record<string, unknown> {
  const alg = decodeAlg(token);
  if (!opts.algorithms.includes(alg as JwtAlgorithm)) {
    throw new Error(
      `token alg '${alg}' is not in the allowed set [${opts.algorithms.join(', ')}]`,
    );
  }
  if (alg === 'EdDSA') {
    return verifyEdDSA(token, opts);
  }
  return jwt.verify(token, opts.key as Secret, {
    algorithms: [alg as Algorithm],
    issuer: opts.issuer,
    audience: opts.audience,
    clockTolerance: opts.clockToleranceSec ?? 0,
  }) as Record<string, unknown>;
}

// ── EdDSA (Ed25519): sign via Node crypto, verify via the acdp SDK ──────────────────────────────────────

function signEdDSA(
  payload: Record<string, unknown>,
  key: KeyLike,
  keyid?: string,
): string {
  const header: Record<string, unknown> = { alg: 'EdDSA', typ: 'JWT' };
  if (keyid) header.kid = keyid;
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(
    Buffer.from(JSON.stringify(payload)),
  )}`;
  // Ed25519 signs the raw input; the digest algorithm is `null`.
  const sig = cryptoSign(null, Buffer.from(signingInput), key as KeyObject);
  return `${signingInput}.${b64url(sig)}`;
}

function verifyEdDSA(token: string, opts: VerifyJwtOptions): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || parts[2] === undefined) {
    throw new Error('malformed JWT: expected three segments');
  }
  const [h, p, s] = parts;
  const sig = Buffer.from(s, 'base64url');
  if (sig.length !== ED25519_SIGNATURE_BYTES) {
    throw new Error('invalid signature');
  }
  // The SDK verifies strictly (RFC-ACDP-0001 §5.10); it never throws past
  // `verifySignatureB64`, so any malformed key/signature is "invalid signature".
  const ok = verifySignatureB64(
    'ed25519',
    rawEd25519PublicKeyB64(toPublicKey(opts.key)),
    `${h}.${p}`,
    sig.toString('base64'),
  );
  if (!ok) {
    throw new Error('invalid signature');
  }
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  validateRegisteredClaims(payload, opts);
  return payload;
}

/** exp/nbf/iss/aud validation — parity with `jsonwebtoken`'s verify options. */
function validateRegisteredClaims(
  payload: Record<string, unknown>,
  opts: VerifyJwtOptions,
): void {
  const now = Math.floor(Date.now() / 1000);
  const tol = opts.clockToleranceSec ?? 0;
  if (typeof payload.exp === 'number' && now > payload.exp + tol) {
    throw new Error('jwt expired');
  }
  if (typeof payload.nbf === 'number' && now < payload.nbf - tol) {
    throw new Error('jwt not active');
  }
  if (opts.issuer !== undefined && payload.iss !== opts.issuer) {
    throw new Error(`jwt issuer invalid. expected: ${opts.issuer}`);
  }
  if (opts.audience !== undefined) {
    const aud = payload.aud;
    const matches = Array.isArray(aud) ? aud.includes(opts.audience) : aud === opts.audience;
    if (!matches) {
      throw new Error('jwt audience invalid');
    }
  }
}

const ED25519_SIGNATURE_BYTES = 64;

/** Raw 32-byte Ed25519 public key (standard base64) from a KeyObject. */
function rawEd25519PublicKeyB64(key: KeyObject): string {
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('EdDSA verification key is not an Ed25519 key');
  }
  const { x } = key.export({ format: 'jwk' });
  if (typeof x !== 'string') {
    throw new Error('EdDSA verification key has no raw public component');
  }
  return Buffer.from(x, 'base64url').toString('base64');
}

function toPublicKey(key: KeyLike): KeyObject {
  if (key instanceof KeyObject) {
    // A private key can verify too, but normalize to the public half.
    return key.type === 'private' ? createPublicKey(key) : key;
  }
  return createPublicKey(key as string | Buffer);
}

function decodeAlg(token: string): string {
  const h = token.split('.')[0];
  if (!h) throw new Error('malformed JWT: missing header');
  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  } catch {
    throw new Error('malformed JWT: header is not valid base64url JSON');
  }
  if (!header || typeof header !== 'object' || typeof (header as { alg?: unknown }).alg !== 'string') {
    throw new Error('malformed JWT: header missing alg');
  }
  return (header as { alg: string }).alg;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}
