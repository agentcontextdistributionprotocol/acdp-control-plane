/**
 * SSRF policy for outbound did:web fetches.
 *
 * Ported from `acdp-rs/src/safe_http.rs::SsrfPolicy` so the control
 * plane refuses the same set of dangerous targets as the Rust
 * registry: loopback, RFC 1918 / 4193 private ranges, link-local,
 * AWS/GCP IMDS (169.254.169.254), CGNAT, IETF-protocol, benchmarking,
 * multicast, reserved, IPv4-mapped IPv6, ULA, link-local IPv6.
 *
 * Two-stage check, matching the Rust SDK's design:
 *
 *   1. `checkUrl()` — synchronous scheme + IP-literal-authority check.
 *      Catches `did:web:127.0.0.1` / `did:web:[::1]` BEFORE any DNS work.
 *   2. `checkResolvedHost()` — DNS the hostname, validate EVERY returned
 *      address. Any one in a forbidden range aborts the resolution —
 *      an attacker MUST NOT bypass the filter by mixing a public and
 *      a private answer in a single DNS response.
 *
 * V1 limitation: there's a TOCTOU race between `checkResolvedHost()`
 * and the subsequent HTTPS connect — a hostile authoritative DNS
 * could flip the answer in between. The Rust SDK closes this via
 * `reqwest::Client::resolve(host, addr)` IP pinning; the Node port
 * doesn't yet (would require an undici Dispatcher). A V2 follow-up
 * adds pinning; for V1, the DNS-result cache shrinks the window and
 * the threat model is "operator-trusted DNS resolver" (the same
 * model as basically every Nest app).
 */
import * as dns from 'node:dns/promises';

export interface SsrfPolicyOptions {
  /** Allow `http://` (testing only). Default false. */
  allowHttp?: boolean;
  /** Allow IPv4 `127.0.0.0/8` and IPv6 `::1` (testing only). Default false. */
  allowLoopback?: boolean;
}

export class SsrfPolicyError extends Error {
  readonly code: 'SCHEME' | 'IP_LITERAL' | 'FORBIDDEN_RANGE' | 'NO_DNS' | 'INVALID_URL';
  constructor(code: SsrfPolicyError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export class SsrfPolicy {
  readonly allowHttp: boolean;
  readonly allowLoopback: boolean;

  constructor(opts: SsrfPolicyOptions = {}) {
    this.allowHttp = opts.allowHttp ?? false;
    this.allowLoopback = opts.allowLoopback ?? false;
  }

  /** Scheme + IP-literal-authority check. Synchronous, no DNS. */
  checkUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e) {
      throw new SsrfPolicyError('INVALID_URL', `invalid URL '${url}': ${e}`);
    }
    if (!this.allowHttp && parsed.protocol !== 'https:') {
      throw new SsrfPolicyError(
        'SCHEME',
        `SSRF policy: scheme '${parsed.protocol}' is not https`,
      );
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new SsrfPolicyError(
        'SCHEME',
        `SSRF policy: scheme '${parsed.protocol}' is not http(s)`,
      );
    }
    // Refuse IP-literal authorities outright.
    const host = parsed.hostname.replace(/^\[|\]$/g, ''); // strip [] for v6
    if (isIpLiteral(host)) {
      this.checkIp(host);
      // checkIp threw — but if the operator set allowLoopback, it
      // returned. Continue: connecting to an IP literal is still
      // refused even if the IP itself is allowed, since the cert chain
      // can't validate to an IP without a SAN that lists it.
      throw new SsrfPolicyError(
        'IP_LITERAL',
        `SSRF policy: IP-literal authority '${host}' is not allowed (cert chain won't validate)`,
      );
    }
  }

  /** Range check for a single IP literal. Throws on forbidden ranges. */
  checkIp(ip: string): void {
    if (isIPv4(ip)) {
      if (this.allowLoopback && isIPv4Loopback(ip)) return;
      if (isUnsafeIPv4(ip)) {
        throw new SsrfPolicyError(
          'FORBIDDEN_RANGE',
          `SSRF policy: IPv4 '${ip}' is in a forbidden range`,
        );
      }
      return;
    }
    if (isIPv6(ip)) {
      const norm = ip.toLowerCase();
      if (this.allowLoopback && norm === '::1') return;
      if (isUnsafeIPv6(norm)) {
        throw new SsrfPolicyError(
          'FORBIDDEN_RANGE',
          `SSRF policy: IPv6 '${ip}' is in a forbidden range`,
        );
      }
      return;
    }
    throw new SsrfPolicyError('IP_LITERAL', `not an IP literal: '${ip}'`);
  }

  /**
   * Resolve `hostname` and assert that EVERY returned address passes
   * the range check. Returns the resolved addresses so the caller can
   * pin them (V2 hardening).
   *
   * RFC-ACDP-0006 §7.1 / 4.8: if ANY resolved address is in a
   * forbidden range, the WHOLE resolution is rejected.
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
}

// ── IP literal detection ─────────────────────────────────────────────────

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function isIPv4(s: string): boolean {
  const m = IPV4_RE.exec(s);
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function isIPv6(s: string): boolean {
  // Loose check — Node's net.isIPv6 would be perfect; we avoid the
  // import by using URL parsing. URL accepts a bracketed v6 host;
  // an unbracketed `::1` isn't a valid URL host, so we test it
  // through a synthetic URL.
  if (s.includes(':')) {
    try {
      new URL(`https://[${s}]`);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function isIpLiteral(s: string): boolean {
  return isIPv4(s) || isIPv6(s);
}

function isIPv4Loopback(s: string): boolean {
  return s.startsWith('127.');
}

// ── unsafe range filters (ported from Rust SDK) ──────────────────────────

export function isUnsafeIPv4(ip: string): boolean {
  const m = IPV4_RE.exec(ip);
  if (!m) return false;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return (
    o[0] === 0 ||                                  // 0.0.0.0/8       current network
    o[0] === 10 ||                                 // 10.0.0.0/8      RFC 1918
    (o[0] === 100 && (o[1] & 0xc0) === 64) ||      // 100.64.0.0/10   CGNAT
    o[0] === 127 ||                                // 127.0.0.0/8     loopback
    (o[0] === 169 && o[1] === 254) ||              // 169.254.0.0/16  link-local + IMDS
    (o[0] === 172 && (o[1] & 0xf0) === 16) ||      // 172.16.0.0/12   RFC 1918
    (o[0] === 192 && o[1] === 0 && o[2] === 0) ||  // 192.0.0.0/24    IETF protocol
    (o[0] === 192 && o[1] === 168) ||              // 192.168.0.0/16  RFC 1918
    (o[0] === 198 && (o[1] === 18 || o[1] === 19)) || // 198.18.0.0/15 benchmarking
    (o[0] >= 224 && o[0] <= 239) ||                // 224.0.0.0/4     multicast
    o[0] >= 240                                    // 240.0.0.0/4     reserved
  );
}

export function isUnsafeIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // ::, ::1, multicast
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('ff')) return true; // ff00::/8 multicast

  // Decode to 8 hextets so embedded-IPv4 forms can't slip through in
  // whatever shape DNS hands back. `dns.lookup` returns the *canonical
  // hex* form (e.g. 169.254.169.254 → `::ffff:a9fe:a9fe`), NOT the
  // dotted form, so a substring check on `::ffff:` is not enough.
  const segs = toHextets(lower);
  if (segs === null) return false; // unparseable → handled by literal checks below

  // Embedded IPv4 — two forms, both end in the low 32 bits:
  //   IPv4-mapped     ::ffff:a.b.c.d  → segs[0..4]=0, segs[5]=0xffff
  //   IPv4-compatible ::a.b.c.d       → segs[0..5]=0  (deprecated, e.g. ::127.0.0.1)
  if (
    segs[0] === 0 &&
    segs[1] === 0 &&
    segs[2] === 0 &&
    segs[3] === 0 &&
    segs[4] === 0 &&
    (segs[5] === 0 || segs[5] === 0xffff)
  ) {
    const v4 = `${segs[6] >> 8}.${segs[6] & 0xff}.${segs[7] >> 8}.${segs[7] & 0xff}`;
    // `::` and `::1` already handled above; anything else embedding a v4
    // is filtered through the v4 ranges (loopback, RFC1918, IMDS, …).
    if (!(segs[6] === 0 && segs[7] === 0)) {
      return isUnsafeIPv4(v4);
    }
  }

  // NAT64 well-known prefix 64:ff9b::/96 — `64:ff9b::a9fe:a9fe` reaches
  // IMDS via a NAT64 gateway and must be refused regardless of the
  // embedded address.
  if (segs[0] === 0x0064 && segs[1] === 0xff9b) return true;

  // fc00::/7 — unique local (fc00–fdff)
  if (segs[0] >= 0xfc00 && segs[0] <= 0xfdff) return true;
  // fe80::/10 — link-local (fe80–febf)
  if (segs[0] >= 0xfe80 && segs[0] <= 0xfebf) return true;
  return false;
}

/**
 * Expand an IPv6 string (incl. `::` compression and a trailing dotted-quad)
 * into exactly 8 16-bit hextets. Returns null if the input isn't a parseable
 * IPv6 address.
 */
function toHextets(ip: string): number[] | null {
  if (!ip.includes(':')) return null;
  // Normalise an embedded dotted-decimal tail (`…:a.b.c.d`) into two hex
  // hextets so the rest of the parser only deals with `:`-separated hex.
  let s = ip;
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isIPv4(tail)) return null;
    const o = tail.split('.').map(Number);
    const hexTail = `${(((o[0] << 8) | o[1]) >>> 0).toString(16)}:${(((o[2] << 8) | o[3]) >>> 0).toString(16)}`;
    s = ip.slice(0, lastColon + 1) + hexTail; // keeps the `::` intact
  }

  const halves = s.split('::');
  if (halves.length > 2) return null; // more than one '::' is illegal
  const parseGroup = (g: string): number[] | null => {
    if (g === '') return [];
    const parts = g.split(':');
    const out: number[] = [];
    for (const p of parts) {
      if (p === '' || p.length > 4 || !/^[0-9a-f]+$/.test(p)) return null;
      out.push(parseInt(p, 16));
    }
    return out;
  };

  const left = parseGroup(halves[0]);
  if (left === null) return null;
  let segs: number[];
  if (halves.length === 2) {
    const right = parseGroup(halves[1]);
    if (right === null) return null;
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    segs = [...left, ...new Array(fill).fill(0), ...right];
  } else {
    segs = left;
  }
  return segs.length === 8 ? segs : null;
}
