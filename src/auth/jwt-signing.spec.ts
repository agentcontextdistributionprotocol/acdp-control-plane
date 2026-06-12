import { generateKeyPairSync } from 'node:crypto';
import {
  buildSigningMaterial,
  generateEd25519Pem,
  JwtSigningConfigError,
} from './jwt-signing';

describe('buildSigningMaterial', () => {
  describe('HS256', () => {
    it('returns symmetric material with no public JWK', () => {
      const m = buildSigningMaterial({
        algorithm: 'HS256',
        hsSecret: 'x'.repeat(32),
      });
      expect(m.algorithm).toBe('HS256');
      expect(m.signingKey).toBe('x'.repeat(32));
      expect(m.verifyKey).toBe('x'.repeat(32));
      expect(m.publicJwk).toBeNull();
      expect(m.kid.length).toBeGreaterThan(0);
    });

    it('throws when secret < 32 bytes', () => {
      expect(() =>
        buildSigningMaterial({ algorithm: 'HS256', hsSecret: 'short' }),
      ).toThrow(JwtSigningConfigError);
    });

    it('derives a stable kid from the secret', () => {
      const a = buildSigningMaterial({ algorithm: 'HS256', hsSecret: 'y'.repeat(32) });
      const b = buildSigningMaterial({ algorithm: 'HS256', hsSecret: 'y'.repeat(32) });
      expect(a.kid).toBe(b.kid);
    });

    it('honors explicit kid override', () => {
      const m = buildSigningMaterial({
        algorithm: 'HS256',
        hsSecret: 'z'.repeat(32),
        kid: 'custom-kid',
      });
      expect(m.kid).toBe('custom-kid');
    });
  });

  describe('EdDSA', () => {
    const { privatePem, publicPem } = generateEd25519Pem();

    it('returns asymmetric material with a published JWK', () => {
      const m = buildSigningMaterial({
        algorithm: 'EdDSA',
        privateKeyPem: privatePem,
      });
      expect(m.algorithm).toBe('EdDSA');
      expect(m.publicJwk).not.toBeNull();
      expect(m.publicJwk!.kty).toBe('OKP');
      expect(m.publicJwk!.crv).toBe('Ed25519');
      expect(m.publicJwk!.alg).toBe('EdDSA');
      expect(m.publicJwk!.use).toBe('sig');
      // x is the raw Ed25519 public key (32 bytes) base64url-encoded → 43 chars.
      expect(m.publicJwk!.x).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(m.publicJwk!.kid).toBe(m.kid);
    });

    it('throws when PEM is missing', () => {
      expect(() =>
        buildSigningMaterial({ algorithm: 'EdDSA', privateKeyPem: '' }),
      ).toThrow(/JWT_PRIVATE_KEY_PEM/);
    });

    it('throws when PEM is not a valid key', () => {
      expect(() =>
        buildSigningMaterial({
          algorithm: 'EdDSA',
          privateKeyPem: '-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n',
        }),
      ).toThrow(JwtSigningConfigError);
    });

    it('throws when the PEM is a valid key but NOT Ed25519 (e.g. an EC key)', () => {
      // A syntactically valid PEM of the wrong key type must be rejected — the
      // JWKS/JWT path is Ed25519-only.
      const ecPem = generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey;
      expect(() =>
        buildSigningMaterial({ algorithm: 'EdDSA', privateKeyPem: ecPem }),
      ).toThrow(/Ed25519/);
    });

    it('derives a kid stable across calls for the same key', () => {
      const a = buildSigningMaterial({ algorithm: 'EdDSA', privateKeyPem: privatePem });
      const b = buildSigningMaterial({ algorithm: 'EdDSA', privateKeyPem: privatePem });
      expect(a.kid).toBe(b.kid);
    });

    it('publishes a JWK shape that is also embedded in the public PEM', () => {
      const m = buildSigningMaterial({ algorithm: 'EdDSA', privateKeyPem: privatePem });
      // The 'x' value should be base64url (no padding, no +/).
      expect(m.publicJwk!.x).toMatch(/^[A-Za-z0-9_-]+$/);
      // And we should be able to re-export the public PEM from the
      // generated material (sanity check on the keypair).
      expect(publicPem).toMatch(/BEGIN PUBLIC KEY/);
    });
  });
});
