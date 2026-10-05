 
/**
 * TokenIssuer × DidWebResolverService — fallback-chain integration spec.
 *
 * Tests the wiring added per deferred-plan §1 step 6: when the agent
 * isn't in the pinned directory AND the agent_id is a did:web DID,
 * the issuer falls through to the resolver. Pinned-keys-first is
 * preserved so emergency revocations stage locally.
 */
import { UnauthorizedException } from '@nestjs/common';
import { ErrorCode } from '../errors/error-codes';
import { generateKeyPairSync, sign } from 'node:crypto';
import { ChallengeStore } from './challenge-store.service';
import { DidFetchResponse, DidWebResolverService } from './did-web/did-web-resolver.service';
import { InMemoryChallengeRepository } from './in-memory-challenge.repository';
import { buildSigningMaterial } from './jwt-signing';
import { PinnedKeysService } from './pinned-keys.service';
import { SsrfPolicy } from './did-web/ssrf-guard';
import { TokenIssuer } from './token-issuer.service';

function fakeConfig(): any {
  return {
    jwtSecret: 'a'.repeat(64),
    jwtAuthority: 'cp.test',
    jwtTtlSeconds: 3600,
    challengeTtlSeconds: 300,
    authPersistence: 'memory',
    tenantAgentsRaw: '',
  };
}

/** Build an Ed25519 pair + the base64url-no-pad `x` for a DID document JWK. */
function ed25519Pair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const raw = Buffer.from(spki.subarray(spki.length - 32));
  return { privateKey, raw, xB64Url: raw.toString('base64url') };
}

function signEd25519(privateKey: ReturnType<typeof ed25519Pair>['privateKey'], msg: string) {
  return sign(null, Buffer.from(msg, 'utf-8'), privateKey).toString('base64');
}

/** DNS check that always passes — we're using a stub fetcher anyway. */
class TestSsrfPolicy extends SsrfPolicy {
  async checkResolvedHost() {
    return ['203.0.113.1'];
  }
}

/** Stub fetcher that always returns the same DID document. */
function stubFetcher(json: unknown) {
  return {
    async fetch(_url: string): Promise<DidFetchResponse> {
      return {
        status: 200,
        contentType: 'application/did+json',
        body: async () => new TextEncoder().encode(JSON.stringify(json)),
      };
    },
  };
}

describe('TokenIssuer × DidWebResolverService (fallback chain)', () => {
  const did = 'did:web:agents.example.com:alice';
  const keyId = `${did}#key-1`;
  let priv: ReturnType<typeof ed25519Pair>['privateKey'];
  let didDocJson: unknown;

  beforeEach(() => {
    const pair = ed25519Pair();
    priv = pair.privateKey;
    didDocJson = {
      id: did,
      verificationMethod: [
        {
          id: keyId,
          controller: did,
          type: 'JsonWebKey2020',
          publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: pair.xB64Url },
        },
      ],
      assertionMethod: [keyId],
    };
  });

  function buildIssuer(opts: { pinned?: string; withResolver?: boolean }) {
    const store = new ChallengeStore(new InMemoryChallengeRepository());
    const pinned = new PinnedKeysService();
    if (opts.pinned) pinned.load(opts.pinned);
    const resolver = opts.withResolver
      ? new DidWebResolverService(new TestSsrfPolicy(), stubFetcher(didDocJson))
      : null;
    const cfg = fakeConfig();
    return new TokenIssuer(
      cfg,
      store,
      pinned,
      { material: buildSigningMaterial({ algorithm: 'HS256', hsSecret: cfg.jwtSecret }) } as any,
      null, // revocations
      null, // ledger
      resolver,
    );
  }

  it('pinned-key match wins even when did:web resolver is configured', async () => {
    // Pin a DIFFERENT key under the same DID — the issuer should
    // verify against this pinned key, never call the resolver.
    const otherPair = ed25519Pair();
    const issuer = buildIssuer({
      pinned: `${did}=${otherPair.raw.toString('base64')}`,
      withResolver: true,
    });

    const ch = await issuer.issueChallenge(did);
    // Signature from the OTHER (pinned) key — should verify.
    const sig = signEd25519(otherPair.privateKey, ch.signingInput);
    const out = await issuer.issueToken({
      agentDid: did,
      keyId,
      nonce: ch.nonce,
      expiresAt: ch.expiresAt,
      algorithm: 'ed25519',
      signature: sig,
    });
    expect(out.tokenType).toBe('Bearer');
  });

  it('falls through to did:web when no pinned entry exists', async () => {
    const issuer = buildIssuer({ withResolver: true });
    const ch = await issuer.issueChallenge(did);
    // Signature from the DID-document key (priv) — should verify
    // via the resolver fallback.
    const sig = signEd25519(priv, ch.signingInput);
    const out = await issuer.issueToken({
      agentDid: did,
      keyId,
      nonce: ch.nonce,
      expiresAt: ch.expiresAt,
      algorithm: 'ed25519',
      signature: sig,
    });
    expect(out.tokenType).toBe('Bearer');
  });

  it('still rejects when neither pinned nor did:web resolves the agent', async () => {
    const issuer = buildIssuer({ withResolver: false });
    const ch = await issuer.issueChallenge(did);
    await expect(
      issuer.issueToken({
        agentDid: did,
        keyId,
        nonce: ch.nonce,
        expiresAt: ch.expiresAt,
        algorithm: 'ed25519',
        signature: signEd25519(priv, ch.signingInput),
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('does NOT try did:web resolution for non-did:web agent_ids', async () => {
    const nonDidWeb = 'did:key:abcdef';
    const issuer = buildIssuer({ withResolver: true });
    const ch = await issuer.issueChallenge(nonDidWeb);
    await expect(
      issuer.issueToken({
        agentDid: nonDidWeb,
        keyId: 'k',
        nonce: ch.nonce,
        expiresAt: ch.expiresAt,
        algorithm: 'ed25519',
        signature: 'AAAA',
      }),
    ).rejects.toThrow(/no pinned public key/);
  });

  it('did:web wrong-signature rejects normally', async () => {
    const issuer = buildIssuer({ withResolver: true });
    const ch = await issuer.issueChallenge(did);
    // Sign with a completely different key — DID doc won't verify it.
    const otherPair = ed25519Pair();
    await expect(
      issuer.issueToken({
        agentDid: did,
        keyId,
        nonce: ch.nonce,
        expiresAt: ch.expiresAt,
        algorithm: 'ed25519',
        signature: signEd25519(otherPair.privateKey, ch.signingInput),
      }),
    ).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_SIGNATURE, status: 401 });
  });

  describe('key_id ↔ agent_id binding (#221)', () => {
    /** Resolver whose resolveKey is a spy returning the attacker's key. */
    function buildAttackIssuer(attackerRaw: Buffer, pinnedSpec?: string) {
      const resolveKey = jest.fn(async (keyUrl: string) => ({
        keyId: keyUrl,
        algorithm: 'ed25519' as const,
        publicKeyB64: attackerRaw.toString('base64'),
      }));
      const ledger = { record: jest.fn() };
      const store = new ChallengeStore(new InMemoryChallengeRepository());
      const pinned = new PinnedKeysService();
      if (pinnedSpec) pinned.load(pinnedSpec);
      const cfg = fakeConfig();
      const issuer = new TokenIssuer(
        cfg,
        store,
        pinned,
        { material: buildSigningMaterial({ algorithm: 'HS256', hsSecret: cfg.jwtSecret }) } as any,
        null,
        ledger as any,
        { resolveKey } as any,
      );
      return { issuer, resolveKey, ledger };
    }

    async function attempt(
      agentDid: string,
      keyIdValue: string,
      opts: { pinnedSpec?: string } = {},
    ) {
      const attacker = ed25519Pair();
      const { issuer, resolveKey, ledger } = buildAttackIssuer(attacker.raw, opts.pinnedSpec);
      const ch = await issuer.issueChallenge(agentDid);
      const out = issuer.issueToken({
        agentDid,
        keyId: keyIdValue,
        nonce: ch.nonce,
        expiresAt: ch.expiresAt,
        algorithm: 'ed25519',
        signature: signEd25519(attacker.privateKey, ch.signingInput),
      });
      return { out, resolveKey, ledger };
    }

    it('rejects a key_id naming a sibling-suffixed host (did:web:example.com.attacker.net)', async () => {
      const { out, resolveKey, ledger } = await attempt(
        'did:web:example.com',
        'did:web:example.com.attacker.net#k',
      );
      await expect(out).rejects.toBeInstanceOf(UnauthorizedException);
      expect(resolveKey).not.toHaveBeenCalled();
      expect(ledger.record).toHaveBeenCalledTimes(1);
      expect(ledger.record.mock.calls[0][0].decision).toBe('reject_key_id_mismatch');
    });

    it('rejects a key_id naming a path-prefixed sibling (…:alice vs …:alicebob)', async () => {
      const { out, resolveKey, ledger } = await attempt(
        'did:web:host:agents:alice',
        'did:web:host:agents:alicebob#k',
      );
      await expect(out).rejects.toBeInstanceOf(UnauthorizedException);
      expect(resolveKey).not.toHaveBeenCalled();
      expect(ledger.record).toHaveBeenCalledTimes(1);
      expect(ledger.record.mock.calls[0][0].decision).toBe('reject_key_id_mismatch');
    });

    it.each([
      ['full DID URL without a fragment', 'did:web:example.com'],
      ['empty fragment', 'did:web:example.com#'],
      ['bare empty fragment', ''],
      ['fragment containing #', 'did:web:example.com#a#b'],
      ['empty DID portion', '#key-1'],
      ['bare id that looks like a DID (case/space/encoding)', 'DID:web:other'],
      ['leading-space DID', ' did:web:other'],
    ])('rejects a malformed key_id: %s', async (_n, bad) => {
      const { out, resolveKey, ledger } = await attempt('did:web:example.com', bad);
      await expect(out).rejects.toBeInstanceOf(UnauthorizedException);
      expect(resolveKey).not.toHaveBeenCalled();
      expect(ledger.record).toHaveBeenCalledTimes(1);
      expect(ledger.record.mock.calls[0][0].decision).toBe('reject_key_id_malformed');
    });

    it('still mints for the full DID URL form and for a bare fragment', async () => {
      for (const k of ['did:web:example.com#key-1', 'key-1']) {
        const { out, resolveKey } = await attempt('did:web:example.com', k);
        await expect(out).resolves.toMatchObject({ tokenType: 'Bearer' });
        expect(resolveKey).toHaveBeenCalledWith(
          'did:web:example.com#key-1',
          'ed25519',
        );
      }
    });

    it('applies on the pinned-key path: a foreign DID key_id is rejected even with a valid pinned-key signature', async () => {
      const pinnedPair = ed25519Pair();
      const store = new ChallengeStore(new InMemoryChallengeRepository());
      const pinned = new PinnedKeysService();
      pinned.load(`did:web:example.com=${pinnedPair.raw.toString('base64')}`);
      const ledger = { record: jest.fn() };
      const cfg = fakeConfig();
      const issuer = new TokenIssuer(
        cfg,
        store,
        pinned,
        { material: buildSigningMaterial({ algorithm: 'HS256', hsSecret: cfg.jwtSecret }) } as any,
        null,
        ledger as any,
        null,
      );
      const mint = async (keyIdValue: string) => {
        const ch = await issuer.issueChallenge('did:web:example.com');
        return issuer.issueToken({
          agentDid: 'did:web:example.com',
          keyId: keyIdValue,
          nonce: ch.nonce,
          expiresAt: ch.expiresAt,
          algorithm: 'ed25519',
          signature: signEd25519(pinnedPair.privateKey, ch.signingInput),
        });
      };
      await expect(mint('did:web:other#k')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(ledger.record).toHaveBeenCalledTimes(1);
      expect(ledger.record.mock.calls[0][0].decision).toBe('reject_key_id_mismatch');

      // Bare fragment: mints, acdp.key_id = the supplied value.
      const out = await mint('key-1');
      const claims = JSON.parse(
        Buffer.from(out.token.split('.')[1], 'base64url').toString(),
      );
      expect(claims.acdp.key_id).toBe('key-1');
    });
  });
});
