import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { signJwt, verifyJwt } from './jwt-codec';

const HS_SECRET = 'h'.repeat(48);
const NOW = Math.floor(Date.now() / 1000);

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: 'cp.test',
    sub: 'did:web:alice',
    aud: 'cp.test',
    jti: 'jti-1',
    iat: NOW,
    nbf: NOW,
    exp: NOW + 3600,
    ...overrides,
  };
}

describe('jwt-codec', () => {
  describe('HS256', () => {
    it('signs a token jsonwebtoken can verify (interop)', () => {
      const token = signJwt(claims(), { algorithm: 'HS256', key: HS_SECRET, keyid: 'k1' });
      const decoded = jwt.verify(token, HS_SECRET, {
        algorithms: ['HS256'],
        issuer: 'cp.test',
        audience: 'cp.test',
      }) as Record<string, unknown>;
      expect(decoded.sub).toBe('did:web:alice');
      // kid is carried in the header.
      const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
      expect(header.kid).toBe('k1');
      expect(header.alg).toBe('HS256');
    });

    it('round-trips through the codec', () => {
      const token = signJwt(claims(), { algorithm: 'HS256', key: HS_SECRET });
      const decoded = verifyJwt(token, {
        algorithms: ['HS256'],
        key: HS_SECRET,
        issuer: 'cp.test',
        audience: 'cp.test',
      });
      expect(decoded.sub).toBe('did:web:alice');
    });

    it('verifies a jsonwebtoken-signed token (interop, reverse)', () => {
      const token = jwt.sign(claims(), HS_SECRET, { algorithm: 'HS256', noTimestamp: true });
      const decoded = verifyJwt(token, { algorithms: ['HS256'], key: HS_SECRET, issuer: 'cp.test' });
      expect(decoded.sub).toBe('did:web:alice');
    });
  });

  describe('EdDSA (Ed25519) — unsupported by jsonwebtoken, native here', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    it('signs and verifies an EdDSA token round-trip (KeyObject keys)', () => {
      const token = signJwt(claims(), { algorithm: 'EdDSA', key: privateKey, keyid: 'ed-1' });
      const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
      expect(header.alg).toBe('EdDSA');
      expect(header.kid).toBe('ed-1');

      const decoded = verifyJwt(token, {
        algorithms: ['EdDSA'],
        key: publicKey,
        issuer: 'cp.test',
        audience: 'cp.test',
      });
      expect(decoded.sub).toBe('did:web:alice');
    });

    it('verifies an EdDSA token against a PEM public key (JWKS shape)', () => {
      const token = signJwt(claims(), { algorithm: 'EdDSA', key: createPrivateKey(privPem) });
      const decoded = verifyJwt(token, { algorithms: ['EdDSA'], key: pubPem, issuer: 'cp.test' });
      expect(decoded.sub).toBe('did:web:alice');
    });

    it('rejects an EdDSA token signed by a different key', () => {
      const other = generateKeyPairSync('ed25519');
      const token = signJwt(claims(), { algorithm: 'EdDSA', key: other.privateKey });
      expect(() =>
        verifyJwt(token, { algorithms: ['EdDSA'], key: createPublicKey(pubPem) }),
      ).toThrow(/invalid signature/);
    });

    it('rejects an expired EdDSA token', () => {
      const token = signJwt(claims({ exp: NOW - 10 }), { algorithm: 'EdDSA', key: privateKey });
      expect(() => verifyJwt(token, { algorithms: ['EdDSA'], key: publicKey })).toThrow(/expired/);
    });

    it('rejects a not-yet-valid (future nbf) EdDSA token', () => {
      const token = signJwt(claims({ nbf: NOW + 600 }), { algorithm: 'EdDSA', key: privateKey });
      expect(() => verifyJwt(token, { algorithms: ['EdDSA'], key: publicKey })).toThrow(/not active/);
    });

    it('rejects an issuer mismatch', () => {
      const token = signJwt(claims(), { algorithm: 'EdDSA', key: privateKey });
      expect(() =>
        verifyJwt(token, { algorithms: ['EdDSA'], key: publicKey, issuer: 'someone-else' }),
      ).toThrow(/issuer invalid/);
    });

    it('rejects an audience mismatch (and a missing aud when one is required)', () => {
      const token = signJwt(claims(), { algorithm: 'EdDSA', key: privateKey });
      expect(() =>
        verifyJwt(token, { algorithms: ['EdDSA'], key: publicKey, audience: 'other-aud' }),
      ).toThrow(/audience invalid/);

      const noAud = signJwt(claims({ aud: undefined }), { algorithm: 'EdDSA', key: privateKey });
      expect(() =>
        verifyJwt(noAud, { algorithms: ['EdDSA'], key: publicKey, audience: 'cp.test' }),
      ).toThrow(/audience invalid/);
    });

    it('honors clock tolerance on exp', () => {
      const token = signJwt(claims({ exp: NOW - 5 }), { algorithm: 'EdDSA', key: privateKey });
      // 5s past exp, but a 30s tolerance keeps it valid.
      const decoded = verifyJwt(token, {
        algorithms: ['EdDSA'],
        key: publicKey,
        clockToleranceSec: 30,
      });
      expect(decoded.sub).toBe('did:web:alice');
    });
  });

  describe('algorithm gating', () => {
    it('rejects a token whose header alg is not in the allowed set', () => {
      const token = signJwt(claims(), { algorithm: 'HS256', key: HS_SECRET });
      // Allow only EdDSA → an HS256 token is refused before any verify path.
      const { publicKey } = generateKeyPairSync('ed25519');
      expect(() => verifyJwt(token, { algorithms: ['EdDSA'], key: publicKey })).toThrow(
        /not in the allowed set/,
      );
    });

    it('rejects a malformed token', () => {
      expect(() => verifyJwt('not-a-jwt', { algorithms: ['HS256'], key: HS_SECRET })).toThrow();
    });
  });
});
