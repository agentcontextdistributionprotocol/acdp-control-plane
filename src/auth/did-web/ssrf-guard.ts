/**
 * SSRF policy for outbound did:web / federation / webhook fetches.
 *
 * The security-critical classification — the HTTPS-only rule, the
 * IP-literal rejection, and the full forbidden-range tables (loopback,
 * RFC 1918 / 4193, link-local, IMDS, CGNAT, IETF-protocol, benchmarking,
 * multicast, reserved, IPv4-mapped/compat IPv6, ULA, NAT64) — is no
 * longer hand-ported here. It lives in `acdp-rs::safe_http::SsrfPolicy`
 * and is exposed verbatim through the `acdp` SDK's `AcdpSsrfPolicy`, so
 * the control plane refuses exactly the same targets the Rust registry
 * does, with no parallel range table to drift (RFC-ACDP-0006 §7,
 * RFC-ACDP-0008 §4.8).
 *
 * This wrapper keeps the host-owned half — the "HTTP belongs to the
 * host" split the binding is designed around:
 *
 *   1. `checkUrl()` — scheme gate (honoring the `allowHttp` opt-in) plus
 *      IP-literal *detection* via stdlib `net.isIP`; range classification
 *      of a literal host is delegated to the binding.
 *   2. `checkResolvedHost()` — DNS the hostname, then run every resolved
 *      address through the binding's `checkIp`. Any one in a forbidden
 *      range aborts the whole resolution (mixed-answer rule).
 *   3. `checkRedirectAuthority()` — same-authority redirect check
 *      (scheme + host + effective port) via the binding.
 *
 * V1 limitation (unchanged): a TOCTOU race between `checkResolvedHost()`
 * and the subsequent connect — a hostile DNS could flip the answer in
 * between. The Rust resolver closes this with reqwest IP pinning; the
 * Node host doesn't yet (would need an undici Dispatcher). The threat
 * model stays "operator-trusted DNS resolver".
 */
import * as dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { AcdpSsrfPolicy } from '@agentcontextdistributionprotocol/acdp';

export interface SsrfPolicyOptions {
  /** Allow `http://` (testing only). Default false. */
  allowHttp?: boolean;
  /** Allow IPv4 `127.0.0.0/8` and IPv6 `::1` (testing only). Default false. */
  allowLoopback?: boolean;
}

export class SsrfPolicyError extends Error {
  readonly code:
    | 'SCHEME'
    | 'IP_LITERAL'
    | 'FORBIDDEN_RANGE'
    | 'NO_DNS'
    | 'INVALID_URL'
    | 'CROSS_AUTHORITY';
  constructor(code: SsrfPolicyError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Translate the binding's stable snake_case `.code` into this module's
 * existing `SsrfPolicyError` taxonomy, so consumers that branch on the
 * code (and their tests) keep working unchanged.
 */
function mapBindingCode(code: string): SsrfPolicyError['code'] {
  switch (code) {
    case 'non_https':
      return 'SCHEME';
    case 'ip_literal':
    case 'invalid_ip':
      return 'IP_LITERAL';
    case 'invalid_url':
      return 'INVALID_URL';
    case 'cross_authority':
      return 'CROSS_AUTHORITY';
    case 'loopback':
    case 'imds':
    case 'private':
    case 'multicast_or_reserved':
    default:
      return 'FORBIDDEN_RANGE';
  }
}

function bindingErr(e: unknown): SsrfPolicyError {
  const code =
    e && typeof e === 'object' && 'code' in e
      ? String((e as { code: unknown }).code)
      : '';
  const msg = e instanceof Error ? e.message : String(e);
  return new SsrfPolicyError(mapBindingCode(code), `SSRF policy: ${msg}`);
}

export class SsrfPolicy {
  readonly allowHttp: boolean;
  readonly allowLoopback: boolean;
  private readonly acdp: AcdpSsrfPolicy;

  constructor(opts: SsrfPolicyOptions = {}) {
    this.allowHttp = opts.allowHttp ?? false;
    this.allowLoopback = opts.allowLoopback ?? false;
    // `allowTestLoopback` permits 127.0.0.0/8 and ::1 through `checkIp`
    // so a test harness can resolve `did:web:localhost` to a local
    // listener; production refuses them.
    this.acdp = this.allowLoopback
      ? AcdpSsrfPolicy.allowTestLoopback()
      : AcdpSsrfPolicy.production();
  }

  /** Scheme + IP-literal-authority check. Synchronous, no DNS. */
  checkUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e) {
      throw new SsrfPolicyError('INVALID_URL', `invalid URL '${url}': ${e}`);
    }
    // Scheme: https-only, unless `allowHttp` is opted in (testing).
    if (
      parsed.protocol !== 'https:' &&
      !(this.allowHttp && parsed.protocol === 'http:')
    ) {
      throw new SsrfPolicyError(
        'SCHEME',
        `SSRF policy: scheme '${parsed.protocol}' is not https`,
      );
    }
    // Refuse IP-literal authorities outright — a literal host can't
    // present a cert that chains, and it would bypass the DNS-time range
    // gate. Detection is stdlib (`net.isIP`); the forbidden-range tables
    // stay in the binding (`checkIp`). We reject ALL literals here even
    // when `allowLoopback` is set, matching the prior cert-chain reason.
    const host = parsed.hostname.replace(/^\[|\]$/g, ''); // strip [] for v6
    if (isIP(host) !== 0) {
      throw new SsrfPolicyError(
        'IP_LITERAL',
        `SSRF policy: IP-literal authority '${host}' is not allowed (cert chain won't validate)`,
      );
    }
  }

  /** Range check for a single resolved IP. Throws on forbidden ranges. */
  checkIp(ip: string): void {
    try {
      this.acdp.checkIp(ip);
    } catch (e) {
      throw bindingErr(e);
    }
  }

  /**
   * Resolve `hostname` and assert that EVERY returned address passes the
   * range check. Returns the resolved addresses so the caller can pin
   * them (V2 hardening).
   *
   * RFC-ACDP-0006 §7.1 / 4.8: if ANY resolved address is in a forbidden
   * range, the WHOLE resolution is rejected.
   */
  async checkResolvedHost(hostname: string): Promise<string[]> {
    const addrs = await dns.lookup(hostname, { all: true, verbatim: true });
    if (addrs.length === 0) {
      throw new SsrfPolicyError(
        'NO_DNS',
        `DNS lookup for '${hostname}' returned no addresses`,
      );
    }
    for (const a of addrs) {
      this.checkIp(a.address);
    }
    return addrs.map((a) => a.address);
  }

  /**
   * Assert a redirect target stays within the origin's fetch authority
   * (identical scheme, host, and effective port — an explicit `:443`
   * equals the implicit https default). Throws `CROSS_AUTHORITY` when it
   * differs. Delegated to the binding so the port-normalization rule
   * matches the Rust resolver exactly.
   */
  checkRedirectAuthority(fromUrl: string, toUrl: string): void {
    try {
      this.acdp.checkRedirectAuthority(fromUrl, toUrl);
    } catch (e) {
      throw bindingErr(e);
    }
  }
}
