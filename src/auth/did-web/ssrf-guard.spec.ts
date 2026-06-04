import { SsrfPolicy, SsrfPolicyError, isUnsafeIPv4, isUnsafeIPv6 } from './ssrf-guard';

describe('SsrfPolicy.checkUrl', () => {
  const p = new SsrfPolicy();

  it('accepts an https URL with a public hostname', () => {
    expect(() => p.checkUrl('https://registry.example.com/.well-known/did.json')).not.toThrow();
  });

  it('rejects http by default', () => {
    expect(() => p.checkUrl('http://registry.example.com')).toThrow(SsrfPolicyError);
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => p.checkUrl('file:///etc/passwd')).toThrow(SsrfPolicyError);
  });

  it('rejects IPv4 literal authorities', () => {
    expect(() => p.checkUrl('https://192.168.1.1/x')).toThrow(SsrfPolicyError);
  });

  it('rejects IPv6 literal authorities', () => {
    expect(() => p.checkUrl('https://[::1]/x')).toThrow(SsrfPolicyError);
    expect(() => p.checkUrl('https://[fe80::1]/x')).toThrow(SsrfPolicyError);
  });

  it('allowHttp permits http://', () => {
    const lax = new SsrfPolicy({ allowHttp: true });
    expect(() => lax.checkUrl('http://stub.test/')).not.toThrow();
  });

  it('allowLoopback still rejects IP literals (cert-chain reason)', () => {
    const lax = new SsrfPolicy({ allowLoopback: true });
    expect(() => lax.checkUrl('https://127.0.0.1/x')).toThrow(SsrfPolicyError);
  });
});

describe('isUnsafeIPv4', () => {
  // Forbidden ranges from acdp-rs/src/safe_http.rs.
  it.each([
    ['0.0.0.0'],
    ['10.0.0.1'],
    ['10.255.255.255'],
    ['100.64.0.1'],
    ['127.0.0.1'],
    ['169.254.169.254'],   // AWS/GCP IMDS
    ['172.16.0.1'],
    ['172.31.255.255'],
    ['192.0.0.1'],
    ['192.168.1.1'],
    ['198.18.0.1'],
    ['198.19.255.255'],
    ['224.0.0.1'],
    ['239.0.0.1'],
    ['240.0.0.1'],
    ['255.255.255.255'],
  ])('forbids %s', (ip) => {
    expect(isUnsafeIPv4(ip)).toBe(true);
  });

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['203.0.113.1'],
    ['172.32.0.1'],        // just outside RFC 1918
    ['100.128.0.1'],       // just outside CGNAT
    ['199.0.0.1'],         // just past benchmarking
    ['223.255.255.255'],   // just before multicast
  ])('allows %s', (ip) => {
    expect(isUnsafeIPv4(ip)).toBe(false);
  });
});

describe('isUnsafeIPv6', () => {
  it.each([
    ['::1'],
    ['::'],
    ['ff02::1'],
    ['fc00::1'],
    ['fd00::1'],
    ['fe80::1'],
    ['::ffff:127.0.0.1'],
    // IPv4-mapped in canonical HEX form — the shape dns.lookup returns for
    // 169.254.169.254 (IMDS). The old `::ffff:` substring check missed this.
    ['::ffff:a9fe:a9fe'],
    ['::ffff:7f00:1'],
    // IPv4-compatible (deprecated) — ::127.0.0.1 normalises to ::7f00:1.
    ['::7f00:1'],
    ['::127.0.0.1'],
    // NAT64 64:ff9b::/96 reaching IMDS / RFC1918 via a NAT64 gateway.
    ['64:ff9b::a9fe:a9fe'],
    ['64:ff9b::169.254.169.254'],
    ['64:ff9b::a00:1'],
    // ULA upper half (fd00–fdff) and link-local upper (febf).
    ['fdff::1'],
    ['febf::1'],
  ])('forbids %s', (ip) => {
    expect(isUnsafeIPv6(ip)).toBe(true);
  });

  it.each([
    ['2606:4700:4700::1111'], // public (Cloudflare)
    ['2001:4860:4860::8888'], // public (Google DNS)
    // A NAT64-prefix-looking but public-embedded address is still NAT64 → unsafe,
    // so we assert a genuinely public global-unicast address here instead.
    ['2400:cb00::1'],
  ])('allows public %s', (ip) => {
    expect(isUnsafeIPv6(ip)).toBe(false);
  });
});
