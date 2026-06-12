/**
 * `did:web` resolver service.
 *
 * Resolves `did:web:authority[:path...]` to a [`ResolvedKey`] by:
 *
 *   1. Translating the DID to its HTTPS URL (`did-url::didWebToUrl`).
 *   2. Running the SSRF guard against the URL + DNS-resolved hosts.
 *   3. Fetching `/.well-known/did.json` (or `/path/did.json`) with a
 *      strict `Accept: application/did+json, application/json` header,
 *      a 5-second connect / 10-second total deadline, and a 64 KB body
 *      cap (RFC-ACDP-0006 §7.3).
 *   4. Validating the response content-type is `application/did+json`
 *      or `application/json` (RFC-ACDP-0001 §5.11 step 3.b).
 *   5. Parsing the document, asserting `doc.id == requested DID`.
 *   6. Picking the requested verification method (must appear in
 *      `assertionMethod`) and decoding it to raw bytes + algorithm.
 *
 * Results are LRU-cached for `cacheTtlSeconds` (default 3600s). The
 * cache is keyed by full DID URL (with fragment) so a rotation that
 * changes only the `#key-2` fragment doesn't stale-evict `#key-1`.
 *
 * Fallback chain (deferred-plan §1):
 *   - In production, this service is consulted by `TokenIssuer`
 *     AFTER `PinnedKeysService.get()` returns null. That order is
 *     enforced by `TokenIssuer`, not here — this service has no
 *     opinion on fallbacks, only on resolution.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { AcdpDid, AcdpDidDocument } from 'acdp';
import { ResolvedKey } from './did-document';
import { SsrfPolicy, SsrfPolicyError } from './ssrf-guard';

const MAX_BODY_BYTES = 64 * 1024;        // RFC-ACDP-0006 §7.3
const DEFAULT_TIMEOUT_MS = 10_000;
const ACCEPTED_CONTENT_TYPES = [
  'application/did+json',
  'application/json',
];

export class DidResolutionError extends Error {
  readonly code:
    | 'URL'
    | 'SSRF'
    | 'FETCH'
    | 'STATUS'
    | 'CONTENT_TYPE'
    | 'BODY_TOO_LARGE'
    | 'PARSE'
    | 'PICK';
  constructor(code: DidResolutionError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Pluggable HTTP fetcher.
 *
 * Tests inject a deterministic implementation; production uses
 * Node's built-in `fetch`. Wrapping the fetch lets us pin the
 * resolved IP in a future hardening pass without changing this
 * service's surface (V2 closes the DNS-rebinding TOCTOU mentioned
 * in `ssrf-guard.ts`).
 */
export interface DidFetcher {
  fetch(url: string, init: {
    headers: Record<string, string>;
    signal: AbortSignal;
  }): Promise<DidFetchResponse>;
}

export interface DidFetchResponse {
  status: number;
  contentType: string | null;
  body: () => Promise<Uint8Array>;
}

export const DID_FETCHER = Symbol('DID_FETCHER');

/** Default implementation using Node's global `fetch`. */
export class DefaultDidFetcher implements DidFetcher {
  async fetch(
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal },
  ): Promise<DidFetchResponse> {
    const resp = await fetch(url, {
      headers: init.headers,
      signal: init.signal,
      redirect: 'manual', // we enforce same-authority below explicitly
    });
    return {
      status: resp.status,
      contentType: resp.headers.get('content-type'),
      body: async () => new Uint8Array(await resp.arrayBuffer()),
    };
  }
}

interface CacheEntry {
  doc: AcdpDidDocument;
  cachedAt: number;
}

/**
 * Extract a stable `code: message` detail from an error thrown by the
 * `acdp` binding (its errors carry the reason on `.code`). Falls back to
 * the plain message for non-binding errors.
 */
function bindingErrDetail(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e) {
    const code = String((e as { code: unknown }).code);
    const msg = e instanceof Error ? e.message : String(e);
    return `${code}: ${msg}`;
  }
  return e instanceof Error ? e.message : String(e);
}

@Injectable()
export class DidWebResolverService implements OnModuleDestroy {
  private readonly logger = new Logger(DidWebResolverService.name);
  private readonly ssrf: SsrfPolicy;
  private readonly fetcher: DidFetcher;
  /** TTL for cached documents in seconds. */
  private readonly cacheTtlSeconds: number;
  /** Max requests/sec budget — refused with FETCH error when exceeded.
   *  Token-bucket-lite; resets on the second boundary. */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Optional() ssrf?: SsrfPolicy,
    @Optional() @Inject(DID_FETCHER) fetcher?: DidFetcher,
    // Without @Optional() Nest tries to resolve a `Number` provider and the
    // whole AuthModule.forRoot() graph fails to boot when issuance is enabled.
    @Optional() cacheTtlSeconds?: number,
  ) {
    this.ssrf = ssrf ?? new SsrfPolicy();
    this.fetcher = fetcher ?? new DefaultDidFetcher();
    this.cacheTtlSeconds = cacheTtlSeconds ?? 3600;
  }

  async onModuleDestroy(): Promise<void> {
    this.cache.clear();
  }

  /**
   * Resolve `did:web:...#key-fragment` to the matching public key.
   *
   * The fragment-bearing DID URL is required because a single DID
   * document can declare multiple keys; the caller must say which
   * one they expect to verify against (matches the `key_id` JWT
   * claim or the `signature.key_id` field).
   */
  async resolveKey(
    didUrl: string,
    requestedAlg: 'ed25519' | 'ecdsa-p256',
  ): Promise<ResolvedKey> {
    const did = AcdpDid.stripFragment(didUrl);
    let url: string;
    try {
      url = AcdpDid.webToUrl(did);
    } catch (e) {
      throw new DidResolutionError('URL', bindingErrDetail(e));
    }

    // SSRF: scheme + IP-literal check synchronously (no DNS yet).
    try {
      this.ssrf.checkUrl(url);
    } catch (e) {
      throw new DidResolutionError(
        'SSRF',
        e instanceof SsrfPolicyError ? e.message : String(e),
      );
    }

    const doc = await this.resolveDocument(did, url);
    // Key extraction (assertionMethod gate + algorithm-downgrade defense)
    // is delegated to `acdp-rs` via the binding, so the set of documents
    // this control plane accepts matches the registry exactly.
    try {
      const k = doc.keyForAlgorithm(didUrl, requestedAlg);
      return {
        keyId: k.keyId,
        algorithm: k.algorithm as 'ed25519' | 'ecdsa-p256',
        publicKeyB64: k.publicKeyB64,
      };
    } catch (e) {
      throw new DidResolutionError('PICK', bindingErrDetail(e));
    }
  }

  /** Drop the cached document for a DID — used by admin rotation hooks. */
  invalidate(did: string): void {
    this.cache.delete(AcdpDid.stripFragment(did));
  }

  /** Visible for tests / health checks. */
  cacheSize(): number {
    return this.cache.size;
  }

  // ── internals ────────────────────────────────────────────────────────

  private async resolveDocument(did: string, url: string): Promise<AcdpDidDocument> {
    const cached = this.cache.get(did);
    if (cached && this.isFresh(cached)) {
      return cached.doc;
    }

    // DNS-time SSRF: every resolved address must pass.
    const parsed = new URL(url);
    try {
      await this.ssrf.checkResolvedHost(parsed.hostname);
    } catch (e) {
      throw new DidResolutionError(
        'SSRF',
        e instanceof SsrfPolicyError ? e.message : String(e),
      );
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    let resp: DidFetchResponse;
    try {
      resp = await this.fetcher.fetch(url, {
        headers: {
          Accept: 'application/did+json, application/json',
        },
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new DidResolutionError(
        'FETCH',
        `did:web fetch '${url}' failed: ${e instanceof Error ? e.message : e}`,
      );
    } finally {
      clearTimeout(t);
    }

    if (resp.status < 200 || resp.status >= 300) {
      throw new DidResolutionError(
        'STATUS',
        `did:web fetch '${url}' returned HTTP ${resp.status}`,
      );
    }
    if (!isAcceptedContentType(resp.contentType)) {
      throw new DidResolutionError(
        'CONTENT_TYPE',
        `did:web '${url}' returned content-type '${resp.contentType ?? ''}', expected application/did+json`,
      );
    }
    const bytes = await resp.body();
    if (bytes.byteLength > MAX_BODY_BYTES) {
      throw new DidResolutionError(
        'BODY_TOO_LARGE',
        `did:web '${url}' body ${bytes.byteLength}B exceeds ${MAX_BODY_BYTES}B cap`,
      );
    }
    const text = new TextDecoder('utf-8').decode(bytes);
    // Parse + `id`-match validation is delegated to the binding
    // (`AcdpDidDocument.parse`), which also surfaces malformed JSON.
    let doc: AcdpDidDocument;
    try {
      doc = AcdpDidDocument.parse(text, did);
    } catch (e) {
      throw new DidResolutionError('PARSE', bindingErrDetail(e));
    }

    this.cache.set(did, { doc, cachedAt: Date.now() });
    return doc;
  }

  private isFresh(entry: CacheEntry): boolean {
    return Date.now() - entry.cachedAt < this.cacheTtlSeconds * 1000;
  }
}

function isAcceptedContentType(raw: string | null): boolean {
  if (!raw) return false;
  // Strip parameters like `; charset=utf-8`.
  const bare = raw.split(';')[0]!.trim().toLowerCase();
  return ACCEPTED_CONTENT_TYPES.includes(bare);
}
