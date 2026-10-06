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
        readOnly: false,
      },
    ]);
  });

  describe('flags (6th field, #225)', () => {
    const base = `reg-a|HS256|${OK_SECRET}|aud`;

    it('read_only with an empty scope: iss|alg|mat|aud||read_only', () => {
      const [e] = parseTrustedIssuers(`${base}||read_only`);
      expect(e!.readOnly).toBe(true);
      expect(e!.requiredScope).toBeUndefined();
    });

    it('read_only together with a scope', () => {
      const [e] = parseTrustedIssuers(`${base}|scp1|read_only`);
      expect(e!.readOnly).toBe(true);
      expect(e!.requiredScope).toBe('scp1');
    });

    it('defaults to false for 4-, 5- and trailing-empty-field entries', () => {
      for (const raw of [base, `${base}|scp1`, `${base}||`, `${base}|scp1|`]) {
        expect(parseTrustedIssuers(raw)[0]!.readOnly).toBe(false);
      }
    });

    it('applies per entry (one read-only peer, one read-write peer)', () => {
      const out = parseTrustedIssuers(
        `ro|HS256|${OK_SECRET}|ro.example||read_only,rw|HS256|${OK_SECRET}|rw.example`,
      );
      expect(out.map((e) => [e.iss, e.readOnly])).toEqual([
        ['ro', true],
        ['rw', false],
      ]);
    });

    it('works for EdDSA entries too', () => {
      const [e] = parseTrustedIssuers('reg-b|EdDSA|https://reg-b.example/jwks.json|aud||read_only');
      expect(e!.readOnly).toBe(true);
    });

    it('rejects unknown flags (case-sensitive) and duplicates', () => {
      for (const bad of ['ro', 'READ_ONLY', 'true', 'read_only extra']) {
        expect(() => parseTrustedIssuers(`${base}||${bad}`)).toThrow(/unknown flag/);
      }
      expect(() => parseTrustedIssuers(`${base}||read_only read_only`)).toThrow(/duplicate flag/);
    });

    it('rejects read_only in the scope slot, with a hint', () => {
      expect(() => parseTrustedIssuers(`${base}|read_only`)).toThrow(/6th field/);
    });

    it('rejects more than six fields', () => {
      expect(() => parseTrustedIssuers(`${base}||read_only|extra`)).toThrow(/maximum is/);
    });

    it('never echoes the HS256 secret in any boot error', () => {
      const secret = 'S3cr3t-'.repeat(8);
      const bad = [
        `reg-a|HS256|${secret}|`, // missing audience
        `reg-a|HS256|${secret}`, // too few fields
        `reg-a|RS256|${secret}|aud`, // bad alg
        `reg-a|HS256|${secret}|aud||ro`, // bad flag
        `reg-a|HS256|${secret}|aud|read_only`, // flag in scope slot
        `reg-a|HS256|${secret}|aud||read_only|x`, // too many
        `|HS256|${secret}|aud`, // empty iss
        `reg-a|EdDSA|${secret}|aud`, // HS256 entry with alg flipped
        `reg-a|${secret}|x|aud`, // mis-ordered: secret in the alg slot
        `reg-a|HS256|part|${secret}||x`, // a '|' inside the secret shifts it into flags
      ];
      for (const raw of bad) {
        let msg = '';
        try {
          parseTrustedIssuers(raw);
        } catch (e) {
          msg = (e as Error).message;
        }
        expect(msg).not.toBe('');
        expect(msg).not.toContain(secret);
      }
    });
  });

  it('rejects EdDSA entries whose material is not a URL', () => {
    expect(() => parseTrustedIssuers('reg-b|EdDSA|not-a-url|aud')).toThrow(
      /must be an http\(s\) JWKS URL/,
    );
  });
});

describe('TrustedIssuerRegistry', () => {
  it('lookup by iss', () => {
    const reg = new TrustedIssuerRegistry([
      { iss: 'reg-a', alg: 'HS256', secret: OK_SECRET, audience: 'reg-a.example', readOnly: false },
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
          { iss: 'reg-a', alg: 'HS256', secret: OK_SECRET, audience: 'reg-a.example', readOnly: false },
          { iss: 'reg-a', alg: 'HS256', secret: OK_SECRET, audience: 'reg-a.example', readOnly: false },
        ]),
    ).toThrow(/duplicate trusted issuer/);
  });
});
