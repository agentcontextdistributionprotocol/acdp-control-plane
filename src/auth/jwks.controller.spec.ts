import { JwksController } from './jwks.controller';
import { buildSigningMaterial, generateEd25519Pem } from './jwt-signing';

describe('JwksController', () => {
  it('publishes the single active Ed25519 key as an OKP JWK under EdDSA', () => {
    const { privatePem } = generateEd25519Pem();
    const material = buildSigningMaterial({ algorithm: 'EdDSA', privateKeyPem: privatePem });
    const controller = new JwksController({ material } as any);

    const body = controller.jwks();

    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({
      kty: 'OKP',
      crv: 'Ed25519',
      alg: 'EdDSA',
      use: 'sig',
      kid: material.kid,
    });
  });

  it('publishes an EMPTY key set under HS256 — symmetric secrets never leave the process', () => {
    const material = buildSigningMaterial({ algorithm: 'HS256', hsSecret: 'a'.repeat(64) });
    const controller = new JwksController({ material } as any);

    const body = controller.jwks();

    expect(body.keys).toEqual([]);
    // Regression guard: no field of the response may carry the secret.
    expect(JSON.stringify(body)).not.toContain('a'.repeat(32));
  });
});
