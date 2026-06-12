 
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';

import {
  CHALLENGE_REPOSITORY,
} from './challenge-repository';
import { ChallengeStore } from './challenge-store.service';
import { InMemoryChallengeRepository } from './in-memory-challenge.repository';
import { InMemoryRevocationRepository } from './in-memory-revocation.repository';
import { PinnedKeysService } from './pinned-keys.service';
import {
  REVOCATION_REPOSITORY,
  RevocationRepository,
} from './revocation-repository';
import { RevokeController } from './revoke.controller';
import { SigningMaterialService } from './signing-material.service';
import { TokenIssuer } from './token-issuer.service';
import { AppConfigService } from '../config/app-config.service';

const SECRET = 'a'.repeat(64);
const ISS = 'cp.test';

function fakeConfig(): any {
  return {
    jwtSecret: SECRET,
    jwtAuthority: ISS,
    jwtTtlSeconds: 3600,
    challengeTtlSeconds: 300,
    authSweepIntervalSeconds: 0, // disabled in tests
    jwtSigningAlg: 'HS256',
    jwtPrivateKeyPem: '',
    jwtKid: '',
  };
}

function freshClaims(jti = 'jti-1', exp?: number) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISS,
    sub: 'did:web:alice',
    jti,
    iat: now,
    exp: exp ?? now + 3600,
    acdp: { registry: ISS, key_id: 'k1' },
  };
}

function tokenFor(claims: ReturnType<typeof freshClaims>): string {
  return jwt.sign(claims, SECRET, { algorithm: 'HS256', noTimestamp: true });
}

describe('RevokeController', () => {
  let controller: RevokeController;
  let revocations: InMemoryRevocationRepository;
  let issuer: TokenIssuer;

  beforeEach(async () => {
    revocations = new InMemoryRevocationRepository();
    const cfg = fakeConfig();
    const mod = await Test.createTestingModule({
      controllers: [RevokeController],
      providers: [
        { provide: AppConfigService, useValue: cfg },
        { provide: CHALLENGE_REPOSITORY, useValue: new InMemoryChallengeRepository() },
        { provide: REVOCATION_REPOSITORY, useValue: revocations },
        ChallengeStore,
        PinnedKeysService,
        SigningMaterialService,
        TokenIssuer,
      ],
    }).compile();
    controller = mod.get(RevokeController);
    issuer = mod.get(TokenIssuer);
  });

  function req(actorId = 'admin-1') {
    // Default to admin so the legacy tests (which predate the
    // subject-match gate) keep exercising the happy path.
    return { actorId, actorType: 'api-key', actorIsAdmin: true } as any;
  }

  /** Non-admin api-key caller — used by the negative-authorization tests. */
  function nonAdminReq() {
    return {
      actorId: 'rando-1',
      actorType: 'api-key',
      actorIsAdmin: false,
    } as any;
  }

  /** Self-revoke JWT caller (actorDid matches claims.sub). */
  function selfReq(sub: string) {
    return {
      actorId: sub,
      actorType: 'jwt',
      actorIsAdmin: false,
      actorDid: sub,
    } as any;
  }

  it('revokes a valid JWT and reports revoked=true', async () => {
    const tok = tokenFor(freshClaims('jti-good'));
    const res = await controller.revoke({ token: tok, reason: 'admin_revoke' }, req());
    expect(res.revoked).toBe(true);
    expect(await revocations.isRevoked('jti-good')).toBe(true);
    const rec = await revocations.get('jti-good');
    expect(rec?.reason).toBe('admin_revoke');
    expect(rec?.revokedBy).toBe('admin-1');
  });

  it('a second revoke for the same token returns revoked=false (idempotent)', async () => {
    const tok = tokenFor(freshClaims('jti-dup'));
    await controller.revoke({ token: tok }, req());
    const res = await controller.revoke({ token: tok }, req());
    expect(res.revoked).toBe(false);
  });

  it('still reports a no-op success for a token that does not validate (RFC 7009 §2.2)', async () => {
    // Signed with the wrong secret — verifyJwt will reject but decodeJwt
    // still pulls out the jti for the deny list.
    const wrongSecretToken = jwt.sign(freshClaims('jti-bad-sig'), 'b'.repeat(64), {
      algorithm: 'HS256',
      noTimestamp: true,
    });
    const res = await controller.revoke({ token: wrongSecretToken }, req());
    expect(res.revoked).toBe(true); // newly added to deny list
    expect(await revocations.isRevoked('jti-bad-sig')).toBe(true);
  });

  it('returns revoked=false for an un-decodable garbage token', async () => {
    const res = await controller.revoke({ token: 'not-a-jwt' }, req());
    expect(res.revoked).toBe(false);
  });

  it('revoked token is rejected by verifyJwt even before exp', async () => {
    const tok = tokenFor(freshClaims('jti-soon-revoked'));
    // Sanity: verifies cleanly before revocation.
    const claims = await issuer.verifyJwt(tok);
    expect(claims.sub).toBe('did:web:alice');
    await controller.revoke({ token: tok }, req());
    await expect(issuer.verifyJwt(tok)).rejects.toThrow(/revoked/);
  });

  // ── authorization gate ───────────────────────────────────────────────

  it('403s a non-admin api-key caller (cannot revoke a token they did not own)', async () => {
    const tok = tokenFor(freshClaims('jti-gated'));
    await expect(
      controller.revoke({ token: tok, reason: 'admin_revoke' }, nonAdminReq()),
    ).rejects.toThrow(/not authorized/);
    expect(await revocations.isRevoked('jti-gated')).toBe(false);
  });

  it('allows JWT self-revoke when actorDid matches claims.sub', async () => {
    const tok = tokenFor(freshClaims('jti-self'));
    const res = await controller.revoke(
      { token: tok, reason: 'user_logout' },
      selfReq('did:web:alice'),
    );
    expect(res.revoked).toBe(true);
  });

  it('403s a JWT caller whose actorDid does not match claims.sub', async () => {
    const tok = tokenFor(freshClaims('jti-not-mine'));
    await expect(
      controller.revoke(
        { token: tok, reason: 'admin_revoke' },
        selfReq('did:web:eve'),
      ),
    ).rejects.toThrow(/not authorized/);
    expect(await revocations.isRevoked('jti-not-mine')).toBe(false);
  });

  it('still returns 200 + revoked=false for un-decodable token even from a non-admin (no oracle)', async () => {
    // The 403 gate runs AFTER decode; if decode fails we short-circuit
    // to revoked:false, which is harmless because there's nothing to
    // deny-list. Confirms no inadvertent oracle on the gate.
    const res = await controller.revoke({ token: 'not-a-jwt' }, nonAdminReq());
    expect(res.revoked).toBe(false);
  });
});

// Demonstrate the contract: revocations.isRevoked is a contract that the
// repository (not the controller) is responsible for satisfying.
describe('RevocationRepository sanity (in-memory)', () => {
  let repo: RevocationRepository;
  beforeEach(() => {
    repo = new InMemoryRevocationRepository();
  });
  it('isRevoked is true after revoke', async () => {
    await repo.revoke({
      jti: 'x',
      sub: 'did:web:alice',
      iss: ISS,
      exp: Math.floor(Date.now() / 1000) + 60,
      revokedBy: 't',
      reason: 'admin_revoke',
    });
    expect(await repo.isRevoked('x')).toBe(true);
  });
});
