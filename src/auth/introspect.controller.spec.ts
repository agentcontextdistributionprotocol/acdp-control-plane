 
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';

import { AppConfigService } from '../config/app-config.service';
import { CrossIssuerValidator } from './cross-issuer-validator.service';
import { InMemoryRevocationRepository } from './in-memory-revocation.repository';
import { IntrospectController } from './introspect.controller';
import { REVOCATION_REPOSITORY } from './revocation-repository';
import { SigningMaterialService } from './signing-material.service';
import { TrustedIssuerRegistry } from './trusted-issuers';

const SECRET = 'a'.repeat(64);
const ISS = 'cp.test';

function fakeConfig(): any {
  return {
    jwtSecret: SECRET,
    jwtAuthority: ISS,
    jwtTtlSeconds: 3600,
    challengeTtlSeconds: 300,
    jwtSigningAlg: 'HS256',
    jwtPrivateKeyPem: '',
    jwtKid: '',
  };
}

function freshClaims(overrides: Partial<{
  jti: string;
  sub: string;
  iss: string;
  aud: string;
  exp: number;
  keyId: string;
  registry: string;
}> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: overrides.iss ?? ISS,
    sub: overrides.sub ?? 'did:web:alice',
    jti: overrides.jti ?? 'jti-1',
    iat: now,
    exp: overrides.exp ?? now + 3600,
    ...(overrides.aud !== undefined ? { aud: overrides.aud } : {}),
    acdp: {
      registry: overrides.registry ?? ISS,
      key_id: overrides.keyId ?? 'did:web:alice#key-1',
    },
  };
}

function tokenFor(claims: ReturnType<typeof freshClaims>, secret = SECRET): string {
  return jwt.sign(claims, secret, { algorithm: 'HS256', noTimestamp: true });
}

describe('IntrospectController', () => {
  let controller: IntrospectController;

  let trustedRegistry: TrustedIssuerRegistry;

  beforeEach(async () => {
    const cfg = fakeConfig();
    // Per-test registry — defaults to empty (no peer issuers). Tests
    // that want federation seed peers via `trustedRegistry.list()`
    // (or rebuild with the right ctor args).
    trustedRegistry = new TrustedIssuerRegistry([]);
    const mod = await Test.createTestingModule({
      controllers: [IntrospectController],
      providers: [
        { provide: AppConfigService, useValue: cfg },
        { provide: TrustedIssuerRegistry, useValue: trustedRegistry },
        SigningMaterialService,
        CrossIssuerValidator,
      ],
    }).compile();
    controller = mod.get(IntrospectController);
  });

  it('returns active=true and full claim set for a valid token', async () => {
    const tok = tokenFor(freshClaims({ jti: 'jti-active', sub: 'did:web:alice' }));
    const res = await controller.introspect({ token: tok });
    expect(res.active).toBe(true);
    expect(res.iss).toBe(ISS);
    expect(res.sub).toBe('did:web:alice');
    expect(res.jti).toBe('jti-active');
    expect(res.key_id).toBe('did:web:alice#key-1');
    expect(res.registry).toBe(ISS);
    expect(res.token_type).toBe('Bearer');
    expect(res.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('returns ONLY {active: false} for a signature-invalid token (RFC 7662 §2.2)', async () => {
    // Signed with the wrong secret — verifyJwt rejects.
    const wrongSecretToken = tokenFor(freshClaims(), 'b'.repeat(64));
    const res = await controller.introspect({ token: wrongSecretToken });
    expect(res.active).toBe(false);
    // No other fields leak.
    expect(res.iss).toBeUndefined();
    expect(res.sub).toBeUndefined();
    expect(res.jti).toBeUndefined();
    expect(res.exp).toBeUndefined();
    expect(res.key_id).toBeUndefined();
  });

  it('returns active=false for a token with a wrong issuer', async () => {
    const otherIssToken = tokenFor(freshClaims({ iss: 'someone-else' }));
    const res = await controller.introspect({ token: otherIssToken });
    expect(res.active).toBe(false);
  });

  it('returns active=false for an expired token', async () => {
    const expired = tokenFor(freshClaims({ exp: Math.floor(Date.now() / 1000) - 60 }));
    const res = await controller.introspect({ token: expired });
    expect(res.active).toBe(false);
  });

  it('returns active=false for un-decodable garbage', async () => {
    const res = await controller.introspect({ token: 'not-a-jwt-at-all' });
    expect(res.active).toBe(false);
  });

  it('returns the same shape for two distinct failure modes (no oracle)', async () => {
    // Per RFC 7662 §2.2, the response for any failure must be
    // indistinguishable from any other failure.
    const wrongSig = await controller.introspect({
      token: tokenFor(freshClaims(), 'wrong-secret-xxxxxxxxxxxxxxxxxxxxxx'),
    });
    const wrongIss = await controller.introspect({
      token: tokenFor(freshClaims({ iss: 'attacker.example' })),
    });
    expect(wrongSig).toEqual(wrongIss);
    expect(wrongSig).toEqual({ active: false });
  });

  // ── federation (CrossIssuerValidator dispatch) ──────────────────────

  it('accepts a token issued by a trusted peer (federation)', async () => {
    const PEER_ISS = 'registry-a.peer';
    const PEER_SECRET = 'P'.repeat(64);
    const cfg = fakeConfig();
    const peerRegistry = new TrustedIssuerRegistry([
      { iss: PEER_ISS, alg: 'HS256', secret: PEER_SECRET, audience: PEER_ISS },
    ]);
    const mod = await Test.createTestingModule({
      controllers: [IntrospectController],
      providers: [
        { provide: AppConfigService, useValue: cfg },
        { provide: TrustedIssuerRegistry, useValue: peerRegistry },
        SigningMaterialService,
        CrossIssuerValidator,
      ],
    }).compile();
    const c = mod.get(IntrospectController);

    const peerToken = tokenFor(
      freshClaims({ iss: PEER_ISS, sub: 'did:web:federated-bob', aud: PEER_ISS }),
      PEER_SECRET,
    );
    const res = await c.introspect({ token: peerToken });
    expect(res.active).toBe(true);
    expect(res.iss).toBe(PEER_ISS);
    expect(res.sub).toBe('did:web:federated-bob');
  });

  it('rejects a token from an UN-trusted issuer (no oracle leak)', async () => {
    // Default registry is empty — no peers trusted.
    const stranger = tokenFor(freshClaims({ iss: 'attacker.example' }));
    const res = await controller.introspect({ token: stranger });
    expect(res).toEqual({ active: false });
  });

  it('returns active=false for a revoked local token (revocation gated through introspect)', async () => {
    const cfg = fakeConfig();
    const revocations = new InMemoryRevocationRepository();
    const mod = await Test.createTestingModule({
      controllers: [IntrospectController],
      providers: [
        { provide: AppConfigService, useValue: cfg },
        { provide: TrustedIssuerRegistry, useValue: new TrustedIssuerRegistry([]) },
        { provide: REVOCATION_REPOSITORY, useValue: revocations },
        SigningMaterialService,
        CrossIssuerValidator,
      ],
    }).compile();
    const c = mod.get(IntrospectController);
    const claims = freshClaims({ jti: 'jti-revoked' });
    const tok = tokenFor(claims);
    // Pre-revoke.
    await revocations.revoke({
      jti: claims.jti,
      sub: claims.sub,
      iss: claims.iss,
      exp: claims.exp,
      revokedBy: 'test',
      reason: 'admin_revoke',
    });
    const res = await c.introspect({ token: tok });
    expect(res).toEqual({ active: false });
  });

  it('DOES reject a trusted-peer token whose jti is in the local revocation list', async () => {
    // Cross-issuer revocation propagation (plan §9, now implemented): the
    // RevocationPollerService imports each peer's revocations into the local
    // store, so a single isRevoked(jti) check honors propagated revocations.
    // The introspect path therefore reports a revoked peer token as inactive.
    const PEER_ISS = 'registry-a.peer';
    const PEER_SECRET = 'P'.repeat(64);
    const cfg = fakeConfig();
    const peerRegistry = new TrustedIssuerRegistry([
      { iss: PEER_ISS, alg: 'HS256', secret: PEER_SECRET, audience: PEER_ISS },
    ]);
    const revocations = new InMemoryRevocationRepository();
    // Simulate a revocation imported from the peer's feed (iss = the peer).
    await revocations.revoke({
      jti: 'jti-peer-revoked',
      sub: 'did:web:federated-bob',
      iss: PEER_ISS,
      exp: Math.floor(Date.now() / 1000) + 3600,
      revokedBy: `cross-issuer-poll:${PEER_ISS}`,
      reason: 'unspecified',
    });
    const mod = await Test.createTestingModule({
      controllers: [IntrospectController],
      providers: [
        { provide: AppConfigService, useValue: cfg },
        { provide: TrustedIssuerRegistry, useValue: peerRegistry },
        { provide: REVOCATION_REPOSITORY, useValue: revocations },
        SigningMaterialService,
        CrossIssuerValidator,
      ],
    }).compile();
    const c = mod.get(IntrospectController);
    const peerToken = tokenFor(
      freshClaims({
        iss: PEER_ISS,
        sub: 'did:web:federated-bob',
        aud: PEER_ISS,
        jti: 'jti-peer-revoked',
      }),
      PEER_SECRET,
    );
    const res = await c.introspect({ token: peerToken });
    expect(res).toEqual({ active: false });
  });
});
