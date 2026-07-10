/**
 * JWT signing-material abstraction.
 *
 * Captures the operator's algorithm choice + the right key material
 * for `jsonwebtoken` and for the JWKS endpoint, with one shared
 * `kid` derived from the public-key fingerprint so the same key
 * id appears on both the issued JWT header and in `/.well-known/jwks.json`.
 *
 * Supported algorithms:
 *
 *   - `HS256` (default, backward-compatible): symmetric HMAC. JWKS
 *     publishes nothing (secrets cannot be published). Existing
 *     V1 deployments need no change.
 *   - `EdDSA`: Ed25519 signing. JWKS publishes the public key in
 *     OKP/Ed25519 JWK form. Production-grade federation choice.
 *
 * RS256 is intentionally not (yet) supported — Ed25519 produces
 * smaller tokens, faster verifies, and is the OAuth2 community's
 * recommended modern default. RS256 can be added later behind the
 * same interface without breaking changes.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
} from 'node:crypto';
import type { Secret } from 'jsonwebtoken';

export type JwtSigningAlgorithm = 'HS256' | 'EdDSA';

export interface SigningMaterial {
  algorithm: JwtSigningAlgorithm;
  /** Key id (kid claim). Stable across restarts when key bytes are stable. */
  kid: string;
  /** Material passed to `jsonwebtoken.sign(payload, signingKey, ...)`. */
  signingKey: Secret;
  /** Material passed to `jsonwebtoken.verify(token, verifyKey, ...)`. */
  verifyKey: Secret;
  /**
   * Public-key JWK for publication in `/.well-known/jwks.json`.
   * `null` for HMAC (no public side to publish).
   */
  publicJwk: PublicJwk | null;
}

export interface PublicJwk {
  kty: string;
  kid: string;
  alg: string;
  use: 'sig';
  /** OKP curve name for Ed25519 (`'Ed25519'`). */
  crv?: string;
  /** Base64url public key (Ed25519 x). */
  x?: string;
}

export class JwtSigningConfigError extends Error {}

export interface JwtSigningConfig {
  algorithm: JwtSigningAlgorithm;
  /** HS256 only: ≥32-byte secret. */
  hsSecret?: string;
  /** EdDSA only: PEM-encoded Ed25519 private key. */
  privateKeyPem?: string;
  /** Optional kid override. When unset, derived from the public key fingerprint. */
  kid?: string;
}

/**
 * Build the operative signing material from config. Throws
 * `JwtSigningConfigError` when the inputs don't match the chosen
 * algorithm — surfaced at boot so misconfigurations don't sneak in.
 */
export function buildSigningMaterial(cfg: JwtSigningConfig): SigningMaterial {
  if (cfg.algorithm === 'HS256') {
    const secret = cfg.hsSecret ?? '';
    if (Buffer.byteLength(secret, 'utf-8') < 32) {
      throw new JwtSigningConfigError(
        `HS256 requires a >=32-byte secret (got ${Buffer.byteLength(secret, 'utf-8')})`,
      );
    }
    // HMAC kid is the SHA-256 of the secret, truncated. We don't
    // publish HMAC kids in a JWKS (they're symmetric), but having
    // a stable kid lets future trusted-issuer dispatch index on it.
    const kid = cfg.kid ?? fingerprint(Buffer.from(secret, 'utf-8'));
    return {
      algorithm: 'HS256',
      kid,
      signingKey: secret,
      verifyKey: secret,
      publicJwk: null,
    };
  }
  // EdDSA
  const pem = cfg.privateKeyPem ?? '';
  if (!pem.trim()) {
    throw new JwtSigningConfigError(
      'EdDSA requires JWT_PRIVATE_KEY_PEM (PEM-encoded Ed25519 private key)',
    );
  }
  let priv: KeyObject;
  try {
    priv = createPrivateKey(pem);
  } catch (e) {
    throw new JwtSigningConfigError(
      `JWT_PRIVATE_KEY_PEM is not a valid PEM key: ${e instanceof Error ? e.message : e}`,
    );
  }
  if (priv.asymmetricKeyType !== 'ed25519') {
    throw new JwtSigningConfigError(
      `JWT_PRIVATE_KEY_PEM must be an Ed25519 key (got '${priv.asymmetricKeyType ?? 'unknown'}')`,
    );
  }
  // @types/node 26 dropped the KeyObject overload from createPublicKey;
  // deriving the public key from a private KeyObject is valid at runtime.
  const pub = createPublicKey(priv as unknown as Parameters<typeof createPublicKey>[0]);
  const rawPubBytes = extractEd25519RawPublic(pub);
  const xB64Url = base64UrlEncode(rawPubBytes);
  const kid = cfg.kid ?? fingerprint(rawPubBytes);
  return {
    algorithm: 'EdDSA',
    kid,
    signingKey: priv as unknown as Secret,
    verifyKey: pub as unknown as Secret,
    publicJwk: {
      kty: 'OKP',
      kid,
      alg: 'EdDSA',
      use: 'sig',
      crv: 'Ed25519',
      x: xB64Url,
    },
  };
}

/**
 * Generate a fresh Ed25519 PEM pair. Convenience for tests + the
 * one-shot `npm run cli:gen-jwt-key` operator command (added in a
 * follow-up).
 */
export function generateEd25519Pem(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

function fingerprint(material: Buffer | Uint8Array): string {
  const hash = createHash('sha256').update(material).digest();
  // First 8 bytes, base64url-no-pad — short enough to fit in a JWT
  // header readably, long enough to be collision-resistant in
  // practice for the small (1-2) number of keys an issuer rotates
  // through.
  return base64UrlEncode(hash.subarray(0, 8));
}

/**
 * Extract the raw 32-byte Ed25519 public key from a Node KeyObject.
 *
 * Node's SPKI DER for Ed25519 is a fixed 44 bytes ending in the 32
 * raw key bytes. We slice off the prefix rather than re-encode via
 * the JWK export to keep the dependency surface narrow.
 */
function extractEd25519RawPublic(pub: KeyObject): Buffer {
  const der = pub.export({ format: 'der', type: 'spki' });
  if (der.length !== 44) {
    throw new JwtSigningConfigError(
      `unexpected Ed25519 SPKI length ${der.length} (want 44)`,
    );
  }
  return der.subarray(12, 44);
}

function base64UrlEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
