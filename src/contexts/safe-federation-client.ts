/**
 * SSRF-safe HTTP client for the federation proxy.
 *
 * Brings `GET /contexts/*` to parity with the `acdp-rs` consumer-profile
 * defenses (RFC-ACDP-0006 §7, RFC-ACDP-0008): the registry `base_url`
 * comes from untrusted webhook payloads, so every outbound hop is gated
 * by the same `SsrfPolicy` the did:web resolver uses —
 *
 *   1. `checkUrl()`        — https-only + reject IP-literal authorities.
 *   2. `checkResolvedHost()` — DNS every hop; ALL addresses must pass.
 *   3. Manual redirects     — ≤ 3 follows, same-authority only.
 *   4. Body cap             — 1 MB for context retrievals.
 *   5. Connect/request deadline.
 *
 * The DNS-rebinding TOCTOU between step 2 and the connect is the same
 * V2 follow-up documented in `ssrf-guard.ts` (undici IP pinning).
 *
 * `fetchImpl` is injectable so tests drive it without a network.
 */
import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { SsrfPolicy } from '../auth/did-web/ssrf-guard';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB — RFC-ACDP-0006 context retrievals
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export class FederationFetchError extends Error {
  readonly code: 'SSRF' | 'FETCH' | 'REDIRECT' | 'BODY_TOO_LARGE';
  constructor(code: FederationFetchError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface FederationResponse {
  status: number;
  contentType: string | null;
  body: string;
}

@Injectable()
export class SafeFederationClient {
  private readonly logger = new Logger(SafeFederationClient.name);
  private readonly ssrf: SsrfPolicy;
  private readonly fetchImpl: typeof fetch;

  constructor(@Optional() ssrf?: SsrfPolicy, @Optional() fetchImpl?: typeof fetch) {
    this.ssrf = ssrf ?? new SsrfPolicy();
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /**
   * GET `rawUrl` through the SSRF gate, following at most {@link MAX_REDIRECTS}
   * same-authority redirects. Throws {@link FederationFetchError} on any
   * policy violation, transport error, or oversized body.
   */
  async get(rawUrl: string): Promise<FederationResponse> {
    let url = rawUrl;
    const origin = safeOrigin(rawUrl);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // 1. scheme + IP-literal (synchronous, no DNS).
      try {
        this.ssrf.checkUrl(url);
      } catch (e) {
        throw new FederationFetchError('SSRF', errMsg(e));
      }
      // 2. DNS-time: every resolved address must pass.
      const parsed = new URL(url);
      try {
        await this.ssrf.checkResolvedHost(parsed.hostname);
      } catch (e) {
        throw new FederationFetchError('SSRF', errMsg(e));
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
      let resp: Response;
      try {
        resp = await this.fetchImpl(url, {
          signal: ctrl.signal,
          redirect: 'manual', // we enforce same-authority below
        });
      } catch (e) {
        throw new FederationFetchError('FETCH', `GET '${url}' failed: ${errMsg(e)}`);
      } finally {
        clearTimeout(timer);
      }

      // 3. Manual redirect handling — same authority only.
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (!location) {
          throw new FederationFetchError(
            'REDIRECT',
            `redirect from '${url}' had no Location header`,
          );
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch (e) {
          throw new FederationFetchError('REDIRECT', `invalid redirect target: ${errMsg(e)}`);
        }
        if (safeOrigin(next.toString()) !== origin) {
          throw new FederationFetchError(
            'REDIRECT',
            `cross-authority redirect '${url}' → '${next.host}' rejected`,
          );
        }
        url = next.toString();
        continue;
      }

      // 3a. Upstream rate-limit — surface a clear 503 rather than relaying a
      // bare 429 the caller can't act on. The upstream `Retry-After` hint
      // (if any) is logged and echoed so operators can correlate the limit.
      if (resp.status === 429) {
        const retryAfter = resp.headers.get('retry-after');
        const host = safeHost(url);
        this.logger.warn(
          `federation upstream '${host}' returned 429 Too Many Requests` +
            (retryAfter ? ` (Retry-After: ${retryAfter})` : ' (no Retry-After)'),
        );
        throw new AppException(
          ErrorCode.FEDERATION_UPSTREAM_RATE_LIMITED,
          `upstream '${host}' is rate limiting` +
            (retryAfter ? ` (Retry-After: ${retryAfter})` : ''),
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      // 4. Read body with a hard cap.
      const body = await this.readCapped(resp, url);
      return {
        status: resp.status,
        contentType: resp.headers.get('content-type'),
        body,
      };
    }

    throw new FederationFetchError(
      'REDIRECT',
      `exceeded ${MAX_REDIRECTS} redirects fetching '${rawUrl}'`,
    );
  }

  /** Read the response body, aborting once {@link MAX_BODY_BYTES} is exceeded. */
  private async readCapped(resp: Response, url: string): Promise<string> {
    const declared = Number(resp.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      throw new FederationFetchError(
        'BODY_TOO_LARGE',
        `'${url}' Content-Length ${declared}B exceeds ${MAX_BODY_BYTES}B cap`,
      );
    }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES) {
      throw new FederationFetchError(
        'BODY_TOO_LARGE',
        `'${url}' body ${bytes.byteLength}B exceeds ${MAX_BODY_BYTES}B cap`,
      );
    }
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Scheme + host + port, or '' if unparseable — the redirect-authority key. */
function safeOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/** Host[:port] for log/error context, or '<unknown>' if unparseable. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '<unknown>';
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
