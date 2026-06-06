import {
  parseTrustedIssuers,
  TrustedIssuerError,
  TrustedIssuerRegistry,
} from './trusted-issuers';

const SHORT = 'short';
const OK_SECRET = 'a'.repeat(32);

describe('parseTrustedIssuers', () => {
  it('parses a minimal entry (iss|alg|secret|audience)', () => {
    const out = parseTrustedIssuers(`reg-a|HS256|${OK_SECRET}|reg-a.example`);
    expect(out).toHaveLength(1);
    expect(out[0]!.iss).toBe('reg-a');
    expect(out[0]!.alg).toBe('HS256');
    expect(out[0]!.secret).toBe(OK_SECRET);
    expect(out[0]!.audience).toBe('reg-a.example');
    expect(out[0]!.requiredScope).toBeUndefined();
  });

  it('parses scope when present', () => {
    const out = parseTrustedIssuers(`reg-a|HS256|${OK_SECRET}|control-plane|read:restricted`);
    expect(out[0]!.audience).toBe('control-plane');
    expect(out[0]!.requiredScope).toBe('read:restricted');
  });

  it('parses multiple entries separated by commas', () => {
    const out = parseTrustedIssuers(
      `reg-a|HS256|${OK_SECRET}|reg-a.example,reg-b|HS256|${'b'.repeat(40)}|reg-b.example`,
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.iss).toBe('reg-a');
    expect(out[1]!.iss).toBe('reg-b');
  });

  it('returns an empty list for an empty value', () => {
    expect(parseTrustedIssuers('')).toEqual([]);
    expect(parseTrustedIssuers('   ')).toEqual([]);
  });

  it('rejects too-few fields (audience is now required)', () => {
    expect(() => parseTrustedIssuers('reg-a|HS256')).toThrow(TrustedIssuerError);
    expect(() => parseTrustedIssuers(`reg-a|HS256|${OK_SECRET}`)).toThrow(
      TrustedIssuerError,
    );
  });

  it('rejects a missing audience', () => {
    expect(() => parseTrustedIssuers(`reg-a|HS256|${OK_SECRET}|`)).toThrow(
      /audience is required/,
    );
  });

  it('rejects an empty required field', () => {
    expect(() => parseTrustedIssuers('|HS256|secret|aud')).toThrow(TrustedIssuerError);
  });

  it('rejects unsupported algorithms', () => {
    expect(() => parseTrustedIssuers(`reg-a|RS256|${OK_SECRET}|aud`)).toThrow(
      /unsupported alg/,
    );
  });

  it('rejects HS256 secret < 32 bytes', () => {
    expect(() => parseTrustedIssuers(`reg-a|HS256|${SHORT}|aud`)).toThrow(/< 32 bytes/);
  });

  it('parses an EdDSA entry with a JWKS URL', () => {
    const parsed = parseTrustedIssuers(
      'reg-b|EdDSA|https://reg-b.example/.well-known/jwks.json|reg-b.example',
    );
    expect(parsed).toEqual([
      {
        iss: 'reg-b',
        alg: 'EdDSA',
        jwksUrl: 'https://reg-b.example/.well-known/jwks.json',
        audience: 'reg-b.example',
        requiredScope: undefined,
      },
    ]);
  });

  it('rejects EdDSA entries whose material is not a URL', () => {
    expect(() => parseTrustedIssuers('reg-b|EdDSA|not-a-url|aud')).toThrow(
      /must be a JWKS URL/,
    );
  });
});

describe('TrustedIssuerRegistry', () => {
  it('lookup by iss', () => {
    const reg = new TrustedIssuerRegistry([
      { iss: 'reg-a', alg: 'HS256', secret: OK_SECRET, audience: 'reg-a.example' },
    ]);
    expect(reg.get('reg-a')?.iss).toBe('reg-a');
    expect(reg.get('reg-z')).toBeNull();
    expect(reg.size()).toBe(1);
    expect(reg.list()).toHaveLength(1);
  });

  it('rejects duplicate issuers', () => {
    expect(
      () =>
        new TrustedIssuerRegistry([
          { iss: 'reg-a', alg: 'HS256', secret: OK_SECRET, audience: 'reg-a.example' },
          { iss: 'reg-a', alg: 'HS256', secret: OK_SECRET, audience: 'reg-a.example' },
        ]),
    ).toThrow(/duplicate trusted issuer/);
  });
});
