import { SigningMaterialService } from './signing-material.service';
import { generateEd25519Pem, JwtSigningConfigError } from './jwt-signing';

function fakeConfig(overrides: Record<string, unknown> = {}): any {
  return {
    jwtSigningAlg: 'HS256',
    jwtSecret: 'a'.repeat(64),
    jwtPrivateKeyPem: '',
    jwtKid: '',
    ...overrides,
  };
}

describe('SigningMaterialService', () => {
  it('builds HS256 material from config with a derived stable kid and no public JWK', () => {
    const svc = new SigningMaterialService(fakeConfig());

    expect(svc.material.algorithm).toBe('HS256');
    expect(svc.material.signingKey).toBe('a'.repeat(64));
    expect(svc.material.verifyKey).toBe('a'.repeat(64));
    expect(svc.material.publicJwk).toBeNull();
    // kid is derived from the secret fingerprint — same secret, same kid.
    const again = new SigningMaterialService(fakeConfig());
    expect(again.material.kid).toBe(svc.material.kid);
  });

  it('builds EdDSA material with an OKP/Ed25519 public JWK sharing the kid', () => {
    const { privatePem } = generateEd25519Pem();
    const svc = new SigningMaterialService(
      fakeConfig({ jwtSigningAlg: 'EdDSA', jwtSecret: '', jwtPrivateKeyPem: privatePem }),
    );

    expect(svc.material.algorithm).toBe('EdDSA');
    expect(svc.material.publicJwk).toMatchObject({
      kty: 'OKP',
      crv: 'Ed25519',
      alg: 'EdDSA',
      use: 'sig',
    });
    expect(svc.material.publicJwk!.kid).toBe(svc.material.kid);
    expect(typeof svc.material.publicJwk!.x).toBe('string');
  });

  it('honors an explicit JWT_KID override', () => {
    const svc = new SigningMaterialService(fakeConfig({ jwtKid: 'ops-key-1' }));
    expect(svc.material.kid).toBe('ops-key-1');
  });

  it('treats an empty JWT_KID as unset (derives instead of using "")', () => {
    const svc = new SigningMaterialService(fakeConfig({ jwtKid: '' }));
    expect(svc.material.kid).not.toBe('');
  });

  it('throws at construction on invalid config (short HS256 secret)', () => {
    expect(() => new SigningMaterialService(fakeConfig({ jwtSecret: 'short' }))).toThrow(
      JwtSigningConfigError,
    );
  });

  it('throws at construction when EdDSA is selected without a private key PEM', () => {
    expect(
      () => new SigningMaterialService(fakeConfig({ jwtSigningAlg: 'EdDSA', jwtPrivateKeyPem: '' })),
    ).toThrow(JwtSigningConfigError);
  });
});
