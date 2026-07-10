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
 * natively signs/verifies Ed25519 (algorithm identifier `null` — the digest
 * is intrinsic to the curve). HS256 still delegates to `jsonwebtoken` so its
 * behavior is unchanged.
 *
 * Each call site allows exactly ONE algorithm (the configured signing alg, or
 * the trusted issuer's declared alg), so there is no alg-confusion surface:
 * `verifyJwt` rejects any token whose header `alg` isn't in the allowed set
 * before selecting a verification path.
 */
import { createPublicKey, KeyObject, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
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

// ── EdDSA (Ed25519) via Node crypto ──────────────────────────────────────

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
  const ok = cryptoVerify(
    null,
    Buffer.from(`${h}.${p}`),
    toPublicKey(opts.key),
    Buffer.from(s, 'base64url'),
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

function toPublicKey(key: KeyLike): KeyObject {
  if (key instanceof KeyObject) {
    // A private key can verify too, but normalize to the public half.
    // @types/node 26 dropped the KeyObject overload from createPublicKey,
    // though deriving a public key from a private KeyObject is valid at runtime.
    return key.type === 'private'
      ? createPublicKey(key as unknown as Parameters<typeof createPublicKey>[0])
      : key;
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
