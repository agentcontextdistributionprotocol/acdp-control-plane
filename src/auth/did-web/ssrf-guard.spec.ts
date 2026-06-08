import { SsrfPolicy, SsrfPolicyError } from './ssrf-guard';

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

describe('SsrfPolicy.checkIp (delegated to acdp-rs AcdpSsrfPolicy)', () => {
  const p = new SsrfPolicy();

  // Representative forbidden ranges — the exhaustive range tables are
  // owned + tested in acdp-rs; here we only assert the delegation refuses
  // each class and surfaces a FORBIDDEN_RANGE code.
  it.each([
    ['127.0.0.1'], // loopback
    ['10.0.0.1'], // RFC 1918
    ['192.168.1.1'], // RFC 1918
    ['169.254.169.254'], // IMDS
    ['239.0.0.1'], // multicast
    ['fc00::1'], // ULA
    ['fe80::1'], // link-local
    ['::ffff:10.0.0.1'], // IPv4-mapped private
    ['64:ff9b::a9fe:a9fe'], // NAT64 → IMDS
  ])('forbids %s', (ip) => {
    expect(() => p.checkIp(ip)).toThrow(SsrfPolicyError);
    try {
      p.checkIp(ip);
    } catch (e) {
      expect((e as SsrfPolicyError).code).toBe('FORBIDDEN_RANGE');
    }
  });

  it.each([['8.8.8.8'], ['1.1.1.1'], ['2001:db8::1'], ['2606:4700:4700::1111']])(
    'allows public %s',
    (ip) => {
      expect(() => p.checkIp(ip)).not.toThrow();
    },
  );

  it('allowLoopback permits 127.0.0.1 / ::1 through checkIp', () => {
    const lax = new SsrfPolicy({ allowLoopback: true });
    expect(() => lax.checkIp('127.0.0.1')).not.toThrow();
    expect(() => lax.checkIp('::1')).not.toThrow();
  });
});

describe('SsrfPolicy.checkRedirectAuthority', () => {
  const p = new SsrfPolicy();

  it('allows a same-authority redirect', () => {
    expect(() =>
      p.checkRedirectAuthority('https://a.example/x', 'https://a.example/y'),
    ).not.toThrow();
  });

  it('treats an explicit :443 as the https default (same authority)', () => {
    expect(() =>
      p.checkRedirectAuthority('https://a.example/x', 'https://a.example:443/y'),
    ).not.toThrow();
  });

  it('rejects a cross-authority redirect', () => {
    expect(() =>
      p.checkRedirectAuthority('https://a.example/x', 'https://b.example/y'),
    ).toThrow(SsrfPolicyError);
    try {
      p.checkRedirectAuthority('https://a.example/x', 'https://b.example/y');
    } catch (e) {
      expect((e as SsrfPolicyError).code).toBe('CROSS_AUTHORITY');
    }
  });
});
