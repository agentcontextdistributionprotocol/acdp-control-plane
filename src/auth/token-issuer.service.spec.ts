 
import {
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { generateKeyPairSync, sign } from 'node:crypto';
import jwt from 'jsonwebtoken';

import { ChallengeStore } from './challenge-store.service';
import { InMemoryChallengeRepository } from './in-memory-challenge.repository';
import { InMemoryRevocationRepository } from './in-memory-revocation.repository';
import { IssuanceLedgerService } from './issuance-ledger.service';
import { buildSigningMaterial } from './jwt-signing';
import { PinnedKeysService } from './pinned-keys.service';
import { TokenIssuer, AcdpBearerClaims } from './token-issuer.service';

function fakeConfig(): any {
  return {
    jwtSecret: 'a'.repeat(64),
    jwtAuthority: 'cp.test',
    jwtAudience: 'cp.test',
    jwtTtlSeconds: 3600,
    challengeTtlSeconds: 300,
    tenantAgentsRaw: '',
  };
}

function generateAgent() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const rawPubB64 = Buffer.from(spki.subarray(spki.length - 32)).toString(
    'base64',
  );
  return { privateKey, rawPubB64 };
}

describe('TokenIssuer', () => {
  let store: ChallengeStore;
  let pinned: PinnedKeysService;
  let revocations: InMemoryRevocationRepository;
  let ledger: IssuanceLedgerService;
  let issuer: TokenIssuer;
  const did = 'did:web:cp.test:agents:alice';
  let priv: ReturnType<typeof generateAgent>['privateKey'];

  beforeEach(() => {
    store = new ChallengeStore(new InMemoryChallengeRepository());
    pinned = new PinnedKeysService();
    const cfg = fakeConfig();
    cfg.authPersistence = 'memory';
    revocations = new InMemoryRevocationRepository();
    ledger = new IssuanceLedgerService(cfg, {} as any);
    const { privateKey, rawPubB64 } = generateAgent();
    priv = privateKey;
    pinned.load(`${did}=${rawPubB64}`);
    issuer = new TokenIssuer(
      cfg,
      store,
      pinned,
      { material: buildSigningMaterial({ algorithm: 'HS256', hsSecret: cfg.jwtSecret }) } as any,
      revocations,
      ledger,
    );
  });

  function signChallenge(signingInput: string): string {
    return sign(null, Buffer.from(signingInput), priv).toString('base64');
  }

  it('issues a JWT for a correctly-signed challenge', async () => {
    const ch = await issuer.issueChallenge(did);
    const out = await issuer.issueToken({
      agentDid: did,
      keyId: `${did}#key-1`,
      nonce: ch.nonce,
      expiresAt: ch.expiresAt,
      algorithm: 'ed25519',
      signature: signChallenge(ch.signingInput),
    });
    expect(out.tokenType).toBe('Bearer');
    expect(out.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const decoded = jwt.verify(out.token, fakeConfig().jwtSecret, {
      algorithms: ['HS256'],
      issuer: 'cp.test',
    }) as AcdpBearerClaims;
    expect(decoded.sub).toBe(did);
    expect(decoded.acdp.registry).toBe('cp.test');
    expect(decoded.acdp.key_id).toBe(`${did}#key-1`);
    expect(decoded.jti).toBeTruthy();
    // Unlisted agent gets the default tenant claim.
    expect(decoded.tenant).toBe('default');
  });

  it('stamps the agent\'s tenant claim from TENANT_AGENTS', async () => {
    const cfg = fakeConfig();
    cfg.tenantAgentsRaw = `tenant-blue:${did}`;
    const localStore = new ChallengeStore(new InMemoryChallengeRepository());
    const localPinned = new PinnedKeysService();
    const { privateKey, rawPubB64 } = generateAgent();
    localPinned.load(`${did}=${rawPubB64}`);
    const localRevocations = new InMemoryRevocationRepository();
    const localLedger = new IssuanceLedgerService(cfg, {} as any);
    const localIssuer = new TokenIssuer(
      cfg,
      localStore,
      localPinned,
      { material: buildSigningMaterial({ algorithm: 'HS256', hsSecret: cfg.jwtSecret }) } as any,
      localRevocations,
      localLedger,
    );
    const ch = await localIssuer.issueChallenge(did);
    const out = await localIssuer.issueToken({
      agentDid: did,
      keyId: `${did}#key-1`,
      nonce: ch.nonce,
      expiresAt: ch.expiresAt,
      algorithm: 'ed25519',
      signature: sign(null, Buffer.from(ch.signingInput), privateKey).toString('base64'),
    });
    const decoded = jwt.verify(out.token, cfg.jwtSecret, {
      algorithms: ['HS256'],
      issuer: 'cp.test',
    }) as AcdpBearerClaims;
    expect(decoded.tenant).toBe('tenant-blue');
  });

  it('rejects an unsupported algorithm', async () => {
    const ch = await issuer.issueChallenge(did);
    await expect(
      issuer.issueToken({
        agentDid: did,
        keyId: 'k',
        nonce: ch.nonce,
        expiresAt: ch.expiresAt,
        algorithm: 'rsa-sha256',
        signature: signChallenge(ch.signingInput),
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects an unknown nonce', async () => {
    await expect(
      issuer.issueToken({
        agentDid: did,
        keyId: 'k',
        nonce: 'never-issued',
        expiresAt: 0,
        algorithm: 'ed25519',
        signature: 'ZmFrZQ==',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects reuse of the same nonce (replay defense)', async () => {
    const ch = await issuer.issueChallenge(did);
    await issuer.issueToken({
      agentDid: did,
      keyId: 'k',
      nonce: ch.nonce,
      expiresAt: ch.expiresAt,
      algorithm: 'ed25519',
      signature: signChallenge(ch.signingInput),
    });
    await expect(
      issuer.issueToken({
        agentDid: did,
        keyId: 'k',
        nonce: ch.nonce,
        expiresAt: ch.expiresAt,
        algorithm: 'ed25519',
        signature: signChallenge(ch.signingInput),
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token request whose agent_id mismatches the challenge owner', async () => {
    const ch = await issuer.issueChallenge(did);
    await expect(
      issuer.issueToken({
        agentDid: 'did:web:other',
        keyId: 'k',
        nonce: ch.nonce,
        expiresAt: ch.expiresAt,
        algorithm: 'ed25519',
        signature: signChallenge(ch.signingInput),
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an unpinned agent_did', async () => {
    pinned.load('');
    const ch = await issuer.issueChallenge(did);
    await expect(
      issuer.issueToken({
        agentDid: did,
        keyId: 'k',
        nonce: ch.nonce,
        expiresAt: ch.expiresAt,
        algorithm: 'ed25519',
        signature: signChallenge(ch.signingInput),
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a bad signature', async () => {
    const ch = await issuer.issueChallenge(did);
    await expect(
      issuer.issueToken({
        agentDid: did,
        keyId: 'k',
        nonce: ch.nonce,
        expiresAt: ch.expiresAt,
        algorithm: 'ed25519',
        signature: signChallenge('TAMPERED-INPUT'),
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('verifyJwt accepts a token it issued', async () => {
    const ch = await issuer.issueChallenge(did);
    const out = await issuer.issueToken({
      agentDid: did,
      keyId: 'k',
      nonce: ch.nonce,
      expiresAt: ch.expiresAt,
      algorithm: 'ed25519',
      signature: signChallenge(ch.signingInput),
    });
    const claims = await issuer.verifyJwt(out.token);
    expect(claims.sub).toBe(did);
  });

  it('mints an aud claim bound to the configured audience', async () => {
    const ch = await issuer.issueChallenge(did);
    const out = await issuer.issueToken({
      agentDid: did,
      keyId: 'k',
      nonce: ch.nonce,
      expiresAt: ch.expiresAt,
      algorithm: 'ed25519',
      signature: signChallenge(ch.signingInput),
    });
    const decoded = jwt.decode(out.token) as AcdpBearerClaims;
    expect(decoded.aud).toBe('cp.test');
  });

  it('verifyJwt rejects a token minted for a different audience', async () => {
    // A token that is otherwise valid (right iss/alg) but carries a foreign
    // aud must be rejected — audience binding is enforced on local verify.
    const foreign = jwt.sign(
      { iss: 'cp.test', sub: did, aud: 'other-cp', jti: 'x', iat: 0, exp: 99999999999 },
      fakeConfig().jwtSecret,
      { algorithm: 'HS256' },
    );
    await expect(issuer.verifyJwt(foreign)).rejects.toThrow(UnauthorizedException);
  });

  it('verifyJwt rejects a token with a wrong issuer', async () => {
    const otherToken = jwt.sign(
      { iss: 'someone-else', sub: did, jti: 'x', iat: 0, exp: 99999999999 },
      fakeConfig().jwtSecret,
      { algorithm: 'HS256' },
    );
    await expect(issuer.verifyJwt(otherToken)).rejects.toThrow(UnauthorizedException);
  });

  it('verifyJwt rejects a revoked token even if not yet expired', async () => {
    const ch = await issuer.issueChallenge(did);
    const out = await issuer.issueToken({
      agentDid: did,
      keyId: 'k',
      nonce: ch.nonce,
      expiresAt: ch.expiresAt,
      algorithm: 'ed25519',
      signature: signChallenge(ch.signingInput),
    });
    const claims = await issuer.verifyJwt(out.token);

    await revocations.revoke({
      jti: claims.jti,
      sub: claims.sub,
      iss: claims.iss,
      exp: claims.exp,
      revokedBy: 'unit-test',
      reason: 'admin_revoke',
    });

    await expect(issuer.verifyJwt(out.token)).rejects.toThrow(/revoked/);
  });

  it('issueToken is single-use even under concurrent requests (in-memory map race-window)', async () => {
    const ch = await issuer.issueChallenge(did);
    const both = await Promise.allSettled([
      issuer.issueToken({
        agentDid: did,
        keyId: 'k',
        nonce: ch.nonce,
        expiresAt: ch.expiresAt,
        algorithm: 'ed25519',
        signature: signChallenge(ch.signingInput),
      }),
      issuer.issueToken({
        agentDid: did,
        keyId: 'k',
        nonce: ch.nonce,
        expiresAt: ch.expiresAt,
        algorithm: 'ed25519',
        signature: signChallenge(ch.signingInput),
      }),
    ]);
    const fulfilled = both.filter((r) => r.status === 'fulfilled');
    const rejected = both.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  // ── ledger integration ────────────────────────────────────────────────

  it('writes a mint row to the ledger on success, carrying the signer IP', async () => {
    const ch = await issuer.issueChallenge(did);
    await issuer.issueToken(
      {
        agentDid: did,
        keyId: 'k',
        nonce: ch.nonce,
        expiresAt: ch.expiresAt,
        algorithm: 'ed25519',
        signature: signChallenge(ch.signingInput),
      },
      { signerIp: '10.0.0.1' },
    );
    const snap = ledger.__snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].row.decision).toBe('mint');
    expect(snap[0].row.sub).toBe(did);
    expect(snap[0].row.signerIp).toBe('10.0.0.1');
    expect(snap[0].row.jti).toBeTruthy();
  });

  it('writes reject_alg when an unsupported algorithm is used', async () => {
    const ch = await issuer.issueChallenge(did);
    await expect(
      issuer.issueToken({
        agentDid: did,
        keyId: 'k',
        nonce: ch.nonce,
        expiresAt: ch.expiresAt,
        algorithm: 'rsa-sha256',
        signature: signChallenge(ch.signingInput),
      }),
    ).rejects.toThrow(BadRequestException);
    const snap = ledger.__snapshot();
    expect(snap.map((s) => s.row.decision)).toContain('reject_alg');
  });

  it('writes reject_signature when the signature is forged', async () => {
    const ch = await issuer.issueChallenge(did);
    await expect(
      issuer.issueToken({
        agentDid: did,
        keyId: 'k',
        nonce: ch.nonce,
        expiresAt: ch.expiresAt,
        algorithm: 'ed25519',
        signature: signChallenge('TAMPERED-INPUT'),
      }),
    ).rejects.toThrow(UnauthorizedException);
    const snap = ledger.__snapshot();
    expect(snap[snap.length - 1].row.decision).toBe('reject_signature');
  });

  it('writes reject_unpinned when the agent has no pinned key', async () => {
    pinned.load('');
    const ch = await issuer.issueChallenge(did);
    await expect(
      issuer.issueToken({
        agentDid: did,
        keyId: 'k',
        nonce: ch.nonce,
        expiresAt: ch.expiresAt,
        algorithm: 'ed25519',
        signature: signChallenge(ch.signingInput),
      }),
    ).rejects.toThrow(UnauthorizedException);
    const decisions = ledger.__snapshot().map((s) => s.row.decision);
    expect(decisions).toContain('reject_unpinned');
  });

  it('keeps the hash chain intact across mixed mint + reject decisions', async () => {
    // Three rejections then one mint — the chain must still verify.
    pinned.load(''); // first 3 calls will reject_unpinned
    for (let i = 0; i < 3; i++) {
      const ch = await issuer.issueChallenge(did);
      await expect(
        issuer.issueToken({
          agentDid: did,
          keyId: 'k',
          nonce: ch.nonce,
          expiresAt: ch.expiresAt,
          algorithm: 'ed25519',
          signature: signChallenge(ch.signingInput),
        }),
      ).rejects.toThrow();
    }
    // Restore pinned key for the mint.
    const { privateKey, rawPubB64 } = generateAgent();
    priv = privateKey;
    pinned.load(`${did}=${rawPubB64}`);
    const ch = await issuer.issueChallenge(did);
    await issuer.issueToken({
      agentDid: did,
      keyId: 'k',
      nonce: ch.nonce,
      expiresAt: ch.expiresAt,
      algorithm: 'ed25519',
      signature: signChallenge(ch.signingInput),
    });
    const v = await ledger.verifyChain();
    expect(v.ok).toBe(true);
    expect(v.total).toBe(4);
  });

  // ── ECDSA-P256 + algorithm-downgrade defense (parity with registry #10) ──

  it('issues a JWT for a correctly-signed ECDSA-P256 challenge', async () => {
    const { generateKeyPairSync: gen, sign: nodeSign } = await import('node:crypto');
    const { publicKey, privateKey } = gen('ec', { namedCurve: 'P-256' });
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    const sec1 = Buffer.from(spki.subarray(spki.length - 65)).toString('base64');
    const p256Did = 'did:web:cp.test:agents:p256-bob';
    // Reload pinned dir with the P-256 entry (suffix `:ecdsa-p256`).
    pinned.load(`${p256Did}=${sec1}:ecdsa-p256`);

    const ch = await issuer.issueChallenge(p256Did);
    const sig = nodeSign(
      'sha256',
      Buffer.from(ch.signingInput, 'utf-8'),
      { key: privateKey, dsaEncoding: 'ieee-p1363' },
    ).toString('base64');

    const out = await issuer.issueToken({
      agentDid: p256Did,
      keyId: `${p256Did}#key-1`,
      nonce: ch.nonce,
      expiresAt: ch.expiresAt,
      algorithm: 'ecdsa-p256',
      signature: sig,
    });
    expect(out.tokenType).toBe('Bearer');
  });

  it('downgrade defense: ed25519 sig against P-256 pinned key → rejected', async () => {
    const { generateKeyPairSync: gen } = await import('node:crypto');
    const { publicKey } = gen('ec', { namedCurve: 'P-256' });
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    const sec1 = Buffer.from(spki.subarray(spki.length - 65)).toString('base64');
    const p256Did = 'did:web:cp.test:agents:p256-charlie';
    pinned.load(`${p256Did}=${sec1}:ecdsa-p256`);

    const ch = await issuer.issueChallenge(p256Did);
    await expect(
      issuer.issueToken({
        agentDid: p256Did,
        keyId: 'k',
        nonce: ch.nonce,
        expiresAt: ch.expiresAt,
        algorithm: 'ed25519',
        signature: signChallenge(ch.signingInput), // ed25519 sig
      }),
    ).rejects.toThrow(/does not match pinned algorithm/);
  });
});
