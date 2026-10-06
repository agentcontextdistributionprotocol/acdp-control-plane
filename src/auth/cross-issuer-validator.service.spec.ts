import { UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { CrossIssuerValidator } from './cross-issuer-validator.service';
import { generateKeyPairSync } from 'node:crypto';
import { signJwt } from './jwt-codec';
import { buildSigningMaterial } from './jwt-signing';
import { TrustedIssuerRegistry } from './trusted-issuers';

const LOCAL_SECRET = 'L'.repeat(64);
const PEER_SECRET = 'P'.repeat(64);
const LOCAL_ISS = 'cp.local';
const PEER_ISS = 'registry-a.peer';

function fakeConfig(): any {
  return { jwtSecret: LOCAL_SECRET, jwtAuthority: LOCAL_ISS };
}

function fakeSigning() {
  return {
    material: buildSigningMaterial({ algorithm: 'HS256', hsSecret: LOCAL_SECRET }),
  } as any;
}

function mint(
  iss: string,
  secret: string,
  overrides: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss,
    sub: 'did:web:alice',
    jti: 'jti-test',
    iat: now,
    nbf: now,
    exp: now + 3600,
    acdp: { registry: iss, key_id: 'k1' },
    ...overrides,
  };
  // jsonwebtoken refuses `exp: undefined`; an undefined override means "omit".
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  return jwt.sign(
    payload,
    secret,
    { algorithm: 'HS256', noTimestamp: true },
  );
}

function makeValidator(
  opts: {
    peers?: ConstructorParameters<typeof TrustedIssuerRegistry>[0];
    revocations?: { isRevoked: jest.Mock };
  } = {},
) {
  const registry = new TrustedIssuerRegistry(opts.peers ?? []);
  return new CrossIssuerValidator(
    fakeConfig(),
    registry,
    fakeSigning(),
    (opts.revocations as any) ?? null,
  );
}

describe('CrossIssuerValidator', () => {
  it('accepts a locally-issued token (iss == self)', async () => {
    const v = makeValidator();
    const tok = mint(LOCAL_ISS, LOCAL_SECRET);
    const claims = await v.verify(tok);
    expect(claims.iss).toBe(LOCAL_ISS);
    expect(claims.sub).toBe('did:web:alice');
  });

  it('rejects a token with a wrong-iss + wrong-secret (unrelated peer)', async () => {
    const v = makeValidator();
    const tok = mint('unknown.peer', LOCAL_SECRET);
    await expect(v.verify(tok)).rejects.toThrow(/not trusted/);
  });

  it('accepts a peer-issued token when peer is in trusted_issuers', async () => {
    const v = makeValidator({
      peers: [{ iss: PEER_ISS, alg: 'HS256', secret: PEER_SECRET }] as any,
    });
    const tok = mint(PEER_ISS, PEER_SECRET);
    const claims = await v.verify(tok);
    expect(claims.iss).toBe(PEER_ISS);
  });

  it('rejects a peer-iss token signed with the wrong secret', async () => {
    const v = makeValidator({
      peers: [{ iss: PEER_ISS, alg: 'HS256', secret: PEER_SECRET }] as any,
    });
    const wrong = mint(PEER_ISS, 'X'.repeat(64));
    await expect(v.verify(wrong)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token whose nbf is in the future', async () => {
    const v = makeValidator();
    const future = Math.floor(Date.now() / 1000) + 600;
    const tok = mint(LOCAL_ISS, LOCAL_SECRET, { nbf: future, iat: future });
    await expect(v.verify(tok)).rejects.toThrow(UnauthorizedException);
  });

  it('enforces required audience when declared on the peer', async () => {
    const v = makeValidator({
      peers: [
        {
          iss: PEER_ISS,
          alg: 'HS256',
          secret: PEER_SECRET,
          audience: 'control-plane',
        },
      ] as any,
    });
    // Without aud → rejected.
    await expect(v.verify(mint(PEER_ISS, PEER_SECRET))).rejects.toThrow(/audience mismatch/);
    // With matching aud (string) → accepted.
    const okStr = mint(PEER_ISS, PEER_SECRET, { aud: 'control-plane' });
    expect((await v.verify(okStr)).aud).toBe('control-plane');
    // With matching aud (array) → accepted.
    const okArr = mint(PEER_ISS, PEER_SECRET, { aud: ['x', 'control-plane'] });
    expect((await v.verify(okArr)).aud).toEqual(['x', 'control-plane']);
  });

  it('enforces required scope when declared on the peer', async () => {
    const v = makeValidator({
      peers: [
        {
          iss: PEER_ISS,
          alg: 'HS256',
          secret: PEER_SECRET,
          requiredScope: 'publish read:restricted',
        },
      ] as any,
    });
    // Missing scope → rejected.
    await expect(v.verify(mint(PEER_ISS, PEER_SECRET, { scp: 'publish' }))).rejects.toThrow(
      /missing required scope/,
    );
    // All scopes present → accepted.
    const ok = mint(PEER_ISS, PEER_SECRET, { scp: 'publish read:restricted other' });
    expect((await v.verify(ok)).scp).toContain('publish');
  });

  it('requiredScope reads scope / scopes / array-scp too, and rejects a token with none (#225)', async () => {
    const v = makeValidator({
      peers: [{ iss: PEER_ISS, alg: 'HS256', secret: PEER_SECRET, requiredScope: 'publish' }] as any,
    });
    for (const claim of [
      { scp: 'publish' },
      { scope: 'publish' },
      { scopes: ['publish'] },
      { scp: ['publish'] },
    ]) {
      await expect(v.verify(mint(PEER_ISS, PEER_SECRET, claim))).resolves.toBeDefined();
    }
    // No scope claim at all (what an ACDP registry mints) → 401.
    await expect(v.verify(mint(PEER_ISS, PEER_SECRET))).rejects.toThrow(/missing required scope/);
  });

  it('rejects garbage tokens without leaking which step failed', async () => {
    const v = makeValidator();
    await expect(v.verify('not-a-jwt')).rejects.toThrow(UnauthorizedException);
    await expect(v.verify('a.b.c')).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token with no iss claim', async () => {
    const v = makeValidator();
    // jsonwebtoken refuses to sign without iss in our shape, so build by hand:
    const tok = jwt.sign({ sub: 'x', jti: 'j', iat: 0, exp: 99999999999 }, LOCAL_SECRET);
    await expect(v.verify(tok)).rejects.toThrow(/missing iss/);
  });

  describe('revocation check (applies to every issuer)', () => {
    it('rejects a token whose jti is revoked locally', async () => {
      const revocations = { isRevoked: jest.fn().mockResolvedValue(true) };
      const v = makeValidator({ revocations });
      const tok = mint(LOCAL_ISS, LOCAL_SECRET, { jti: 'jti-revoked' });
      await expect(v.verify(tok)).rejects.toThrow(/revoked/);
      expect(revocations.isRevoked).toHaveBeenCalledWith(LOCAL_ISS, 'jti-revoked');
    });

    it('looks a peer token up under the PEER issuer, never the local one (#232)', async () => {
      const revocations = { isRevoked: jest.fn().mockResolvedValue(false) };
      const peers = [{ iss: PEER_ISS, alg: 'HS256', secret: PEER_SECRET }] as any;
      const v = makeValidator({ revocations, peers });
      await v.verify(mint(PEER_ISS, PEER_SECRET, { jti: 'same-jti' }));
      expect(revocations.isRevoked).toHaveBeenCalledWith(PEER_ISS, 'same-jti');
      expect(revocations.isRevoked).not.toHaveBeenCalledWith(LOCAL_ISS, 'same-jti');
    });

    it('accepts a token whose jti is NOT revoked', async () => {
      const revocations = { isRevoked: jest.fn().mockResolvedValue(false) };
      const v = makeValidator({ revocations });
      const claims = await v.verify(mint(LOCAL_ISS, LOCAL_SECRET));
      expect(claims.iss).toBe(LOCAL_ISS);
      expect(revocations.isRevoked).toHaveBeenCalled();
    });
  });

  it('cross-issuer round-trip: peer-A issues, validator with peer-A in trust accepts', async () => {
    // The integration scenario the federation story is built for.
    const peerToken = mint(PEER_ISS, PEER_SECRET, { sub: 'did:web:federated:bob' });
    const v = makeValidator({
      peers: [{ iss: PEER_ISS, alg: 'HS256', secret: PEER_SECRET }] as any,
    });
    const claims = await v.verify(peerToken);
    expect(claims.sub).toBe('did:web:federated:bob');
    expect(claims.iss).toBe(PEER_ISS);
  });

  describe('tokens without exp are rejected (#221)', () => {
    it('local issuer (HS256)', async () => {
      const token = mint(LOCAL_ISS, LOCAL_SECRET, { exp: undefined });
      await expect(makeValidator().verify(token)).rejects.toThrow(/exp claim is required/);
    });

    it('local issuer (EdDSA)', async () => {
      const kp = generateKeyPairSync('ed25519');
      const pem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const v = new CrossIssuerValidator(
        { jwtSecret: LOCAL_SECRET, jwtAuthority: LOCAL_ISS } as any,
        new TrustedIssuerRegistry([]),
        { material: buildSigningMaterial({ algorithm: 'EdDSA', privateKeyPem: pem }) } as any,
        null,
      );
      const base = {
        iss: LOCAL_ISS,
        sub: 'did:web:alice',
        jti: 'j',
        iat: Math.floor(Date.now() / 1000),
      };
      const noExp = signJwt(base, { algorithm: 'EdDSA', key: kp.privateKey });
      await expect(v.verify(noExp)).rejects.toThrow(/exp claim is required/);
      // Control: with exp the same key/claims verify.
      const withExp = signJwt(
        { ...base, exp: base.iat + 300 },
        { algorithm: 'EdDSA', key: kp.privateKey },
      );
      expect((await v.verify(withExp)).sub).toBe('did:web:alice');
    });

    it('trusted HS256 peer', async () => {
      const token = mint(PEER_ISS, PEER_SECRET, { exp: undefined });
      const v = makeValidator({
        peers: [{ iss: PEER_ISS, alg: 'HS256', secret: PEER_SECRET }] as any,
      });
      await expect(v.verify(token)).rejects.toThrow(/exp claim is required/);
    });
  });

  describe('verifyWithProvenance (#225)', () => {
    it('reports trusted=null for the local issuer and the entry for a trusted peer; verify() is unchanged', async () => {
      const peers = [{ iss: PEER_ISS, alg: 'HS256', secret: PEER_SECRET }] as any;
      const v = makeValidator({ peers });
      const local = await v.verifyWithProvenance(mint(LOCAL_ISS, LOCAL_SECRET));
      expect(local.trusted).toBeNull();
      expect(local.claims.iss).toBe(LOCAL_ISS);
      const peer = await v.verifyWithProvenance(mint(PEER_ISS, PEER_SECRET));
      expect(peer.trusted).toMatchObject({ iss: PEER_ISS, alg: 'HS256' });
      expect((await v.verify(mint(PEER_ISS, PEER_SECRET))).iss).toBe(PEER_ISS);
    });

    it('still rejects an untrusted issuer', async () => {
      await expect(
        makeValidator().verifyWithProvenance(mint('stranger', PEER_SECRET)),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('EdDSA trusted peer (JWKS), verified via the acdp SDK', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const now = Math.floor(Date.now() / 1000);
    const peerClaims = () => ({
      iss: PEER_ISS,
      sub: 'did:web:federated:carol',
      jti: 'jti-eddsa',
      iat: now,
      nbf: now,
      exp: now + 3600,
    });

    function edValidator(jwksKeyPem: string) {
      const v = makeValidator({
        peers: [{ iss: PEER_ISS, alg: 'EdDSA', jwksUrl: 'https://peer.example/jwks.json' }] as any,
      });
      // Stub the JWKS fetch: the codec is what's under test, not the network.
      (v as any).jwksClients.set(PEER_ISS, { getSigningKey: async () => jwksKeyPem });
      return v;
    }

    it('accepts a token signed by the JWKS key', async () => {
      const token = signJwt(peerClaims(), { algorithm: 'EdDSA', key: privateKey });
      const claims = await edValidator(pubPem).verify(token);
      expect(claims.sub).toBe('did:web:federated:carol');
    });

    it('rejects an EdDSA peer token with no exp', async () => {
      const token = signJwt(((c) => (delete c.exp, c))({ ...peerClaims() } as Record<string, unknown>), {
        algorithm: 'EdDSA',
        key: privateKey,
      });
      await expect(edValidator(pubPem).verify(token)).rejects.toThrow(/exp claim is required/);
    });

    it('rejects a token signed by a different key', async () => {
      const other = generateKeyPairSync('ed25519');
      const token = signJwt(peerClaims(), { algorithm: 'EdDSA', key: other.privateKey });
      await expect(edValidator(pubPem).verify(token)).rejects.toThrow(UnauthorizedException);
    });
  });
});
