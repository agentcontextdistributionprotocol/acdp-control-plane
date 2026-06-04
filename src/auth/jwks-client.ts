/**
 * Minimal JWKS client for EdDSA trusted issuers.
 *
 * Why hand-rolled rather than `jwks-rsa`: that package is RS256-only,
 * and the OAuth-ecosystem JWKS libraries that *do* speak Ed25519 pull
 * in much heavier dependency trees. The wire surface we need is
 * small enough (GET → cache → return PEM) that a 100-LOC client is
 * easier to audit than a third-party transitive closure.
 *
 * Caching:
 *   - 5-minute TTL.
 *   - Concurrent misses share the single in-flight fetch promise
 *     (thundering-herd defense).
 *   - On HTTP error we briefly cache the error (30s) so a downed
 *     peer doesn't get DDOS'd by the validator's retry loop.
 *
 * Security:
 *   - We expect `jwks_url` to be https in production and validate
 *     the issuer's full URL (no SSRF affordance — operators configure it).
 *   - The JWKS response is treated as untrusted JSON; only well-formed
 *     OKP/Ed25519 entries are admitted.
 */
import { createPublicKey, type KeyObject } from 'node:crypto';

interface JwksKey {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  crv?: string;
  x?: string;
}

interface JwksResponse {
  keys?: JwksKey[];
}

interface CacheEntry {
  fetchedAt: number;
  /** Map of kid → PEM-encoded public key. `''` (empty key) holds the first key as fallback. */
  byKid: Map<string, string>;
  /** Order keys were seen, used for fallback when the token has no kid. */
  order: string[];
}

const SUCCESS_TTL_MS = 5 * 60_000; // 5 min
const ERROR_TTL_MS = 30_000; // 30 s

export class JwksClient {
  private cache: CacheEntry | null = null;
  private inflight: Promise<CacheEntry> | null = null;
  private lastErrorAt = 0;
  private lastError: Error | null = null;

  constructor(
    private readonly url: string,
    /** Override for tests: inject a fake fetch. */
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * Return a PEM-encoded public key matching `kid`. When `kid` is null
   * (token didn't carry one) OR when no key matches, return the first
   * key in the JWKS — most issuers have one active signing key.
   */
  async getSigningKey(kid: string | null): Promise<string> {
    const entry = await this.ensureFresh();
    if (kid) {
      const hit = entry.byKid.get(kid);
      if (hit) return hit;
    }
    if (entry.order.length === 0) {
      throw new Error(`JWKS at ${this.url} returned no usable keys`);
    }
    return entry.byKid.get(entry.order[0]) as string;
  }

  private async ensureFresh(): Promise<CacheEntry> {
    const now = this.clock();
    if (this.cache && now - this.cache.fetchedAt < SUCCESS_TTL_MS) {
      return this.cache;
    }
    if (this.lastError && now - this.lastErrorAt < ERROR_TTL_MS) {
      throw this.lastError;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchAndParse()
      .then((entry) => {
        this.cache = entry;
        this.lastError = null;
        return entry;
      })
      .catch((e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e));
        this.lastError = err;
        this.lastErrorAt = this.clock();
        throw err;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async fetchAndParse(): Promise<CacheEntry> {
    // Defense-in-depth even though jwksUrl is operator-configured: require
    // https, refuse to auto-follow redirects (a redirect could point at an
    // internal target), and cap the response body so a hostile/compromised
    // issuer can't stream an unbounded JWKS into memory.
    if (!this.url.toLowerCase().startsWith('https://')) {
      throw new Error(`JWKS url ${this.url} must be https`);
    }
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5_000);
    let resp: Response;
    try {
      resp = await this.fetchImpl(this.url, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
        redirect: 'manual',
      });
    } finally {
      clearTimeout(timeout);
    }
    if (resp.status >= 300 && resp.status < 400) {
      throw new Error(`JWKS fetch ${this.url} returned a redirect (refused)`);
    }
    if (!resp.ok) {
      throw new Error(`JWKS fetch ${this.url} returned HTTP ${resp.status}`);
    }
    const MAX_JWKS_BYTES = 64 * 1024;
    const declared = Number(resp.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_JWKS_BYTES) {
      throw new Error(`JWKS at ${this.url} exceeds ${MAX_JWKS_BYTES}-byte cap`);
    }
    const raw = new Uint8Array(await resp.arrayBuffer());
    if (raw.byteLength > MAX_JWKS_BYTES) {
      throw new Error(`JWKS at ${this.url} exceeds ${MAX_JWKS_BYTES}-byte cap`);
    }
    let json: JwksResponse;
    try {
      json = JSON.parse(new TextDecoder('utf-8').decode(raw)) as JwksResponse;
    } catch {
      throw new Error(`JWKS at ${this.url} is not valid JSON`);
    }
    if (!json || !Array.isArray(json.keys)) {
      throw new Error(`JWKS at ${this.url} is malformed (no keys array)`);
    }
    const byKid = new Map<string, string>();
    const order: string[] = [];
    for (const k of json.keys) {
      if (k.kty !== 'OKP' || k.crv !== 'Ed25519' || !k.x) continue;
      const kid = k.kid ?? `__unkeyed_${order.length}`;
      try {
        const pem = ed25519JwkToPem(k);
        byKid.set(kid, pem);
        order.push(kid);
      } catch {
        // Skip malformed entries — operators may roll keys with mixed
        // shapes; we just ignore the bad ones rather than failing.
      }
    }
    return {
      fetchedAt: this.clock(),
      byKid,
      order,
    };
  }
}

/**
 * Convert an OKP/Ed25519 JWK into a SPKI-PEM string usable with
 * `jsonwebtoken.verify`. Reconstructs the 44-byte SPKI DER:
 * 12-byte fixed prefix (algorithm OID) + 32-byte raw public key.
 */
function ed25519JwkToPem(jwk: JwksKey): string {
  if (!jwk.x) throw new Error('JWK missing x');
  const raw = base64UrlDecode(jwk.x);
  if (raw.length !== 32) {
    throw new Error(`Ed25519 JWK x is ${raw.length} bytes (want 32)`);
  }
  const prefix = Buffer.from([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ]);
  const spki = Buffer.concat([prefix, raw]);
  const key: KeyObject = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  return key.export({ format: 'pem', type: 'spki' }).toString();
}

function base64UrlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
