 
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { generateKeyPairSync, sign } from 'node:crypto';
import { CapabilityService } from './capability.service';
import { CapabilityRepository, CapabilityRow } from './capability.repository';
import { capabilityAssertion } from './capability-uri';

class InMemoryRepo implements Pick<CapabilityRepository, 'declare' | 'findByAgent' | 'findByCapability'> {
  rows: Array<{ agentDid: string; capabilityUri: string; declaredAt: string; signedBy: string }> = [];
  async declare(row: {
    agentDid: string;
    capabilityUri: string;
    declaredAt: string;
    signedBy: string;
    signature: string;
  }): Promise<CapabilityRow> {
    const existing = this.rows.find(
      (r) => r.agentDid === row.agentDid && r.capabilityUri === row.capabilityUri,
    );
    if (existing) return existing;
    const stored = {
      agentDid: row.agentDid,
      capabilityUri: row.capabilityUri,
      declaredAt: row.declaredAt,
      signedBy: row.signedBy,
    };
    this.rows.push(stored);
    return stored;
  }
  async findByAgent(agentDid: string): Promise<CapabilityRow[]> {
    return this.rows.filter((r) => r.agentDid === agentDid);
  }
  async findByCapability(capabilityUri: string): Promise<CapabilityRow[]> {
    return this.rows.filter((r) => r.capabilityUri === capabilityUri);
  }
}

const DID = 'did:web:cp.test:agents:alice';
const URI = 'urn:acdp:cap:publish:data_snapshot:finance';

function generateAgent() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const rawPubB64 = Buffer.from(spki.subarray(spki.length - 32)).toString('base64');
  return { privateKey, rawPubB64 };
}

function signAssertion(privateKey: ReturnType<typeof generateAgent>['privateKey'], input: string): string {
  return sign(null, Buffer.from(input), privateKey).toString('base64');
}

describe('CapabilityService', () => {
  let repo: InMemoryRepo;
  let svc: CapabilityService;
  let priv: ReturnType<typeof generateAgent>['privateKey'];

  beforeEach(async () => {
    repo = new InMemoryRepo();
    const { PinnedKeysService } = await import('../auth/pinned-keys.service');
    const pinned = new PinnedKeysService();
    svc = new CapabilityService(repo as any, pinned);
    const { privateKey, rawPubB64 } = generateAgent();
    priv = privateKey;
    svc.setPinnedKeys(`${DID}=${rawPubB64}`);
  });

  it('declare() persists a valid signed declaration', async () => {
    const declaredAt = new Date().toISOString();
    const signingInput = capabilityAssertion(DID, URI, declaredAt);
    const out = await svc.declare({
      agentDid: DID,
      capabilityUri: URI,
      declaredAtIso: declaredAt,
      keyId: `${DID}#key-1`,
      algorithm: 'ed25519',
      signature: signAssertion(priv, signingInput),
    });
    expect(out.agentDid).toBe(DID);
    expect(out.capabilityUri).toBe(URI);
    expect(out.signedBy).toBe(`${DID}#key-1`);
    expect(repo.rows).toHaveLength(1);
  });

  it('declare() is idempotent (same agent+cap returns the prior row)', async () => {
    const declaredAt = new Date().toISOString();
    const signingInput = capabilityAssertion(DID, URI, declaredAt);
    const sig = signAssertion(priv, signingInput);
    await svc.declare({
      agentDid: DID, capabilityUri: URI, declaredAtIso: declaredAt,
      keyId: 'k', algorithm: 'ed25519', signature: sig,
    });
    await svc.declare({
      agentDid: DID, capabilityUri: URI, declaredAtIso: declaredAt,
      keyId: 'k', algorithm: 'ed25519', signature: sig,
    });
    expect(repo.rows).toHaveLength(1);
  });

  it('maps a malformed capability URN to BadRequestException (400, not a 500)', async () => {
    const declaredAt = new Date().toISOString();
    await expect(
      svc.declare({
        agentDid: DID,
        capabilityUri: 'not-a-urn',
        declaredAtIso: declaredAt,
        keyId: 'k',
        algorithm: 'ed25519',
        signature: 'AAA=',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects an unsupported algorithm', async () => {
    const declaredAt = new Date().toISOString();
    await expect(
      svc.declare({
        agentDid: DID, capabilityUri: URI, declaredAtIso: declaredAt,
        keyId: 'k', algorithm: 'rsa-sha256', signature: 'AAA=',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects an out-of-window declared_at (clock skew defense)', async () => {
    const tenMinutesAgo = new Date(Date.now() - 600_000).toISOString();
    const signingInput = capabilityAssertion(DID, URI, tenMinutesAgo);
    await expect(
      svc.declare({
        agentDid: DID, capabilityUri: URI, declaredAtIso: tenMinutesAgo,
        keyId: 'k', algorithm: 'ed25519',
        signature: signAssertion(priv, signingInput),
      }),
    ).rejects.toThrow(/clock skew/);
  });

  it('rejects a malformed declared_at', async () => {
    await expect(
      svc.declare({
        agentDid: DID, capabilityUri: URI, declaredAtIso: 'not-a-date',
        keyId: 'k', algorithm: 'ed25519', signature: 'AAA=',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects an unpinned agent', async () => {
    svc.setPinnedKeys('');
    const declaredAt = new Date().toISOString();
    const signingInput = capabilityAssertion(DID, URI, declaredAt);
    await expect(
      svc.declare({
        agentDid: DID, capabilityUri: URI, declaredAtIso: declaredAt,
        keyId: 'k', algorithm: 'ed25519',
        signature: signAssertion(priv, signingInput),
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a bad signature (signed for wrong capability)', async () => {
    const declaredAt = new Date().toISOString();
    const otherSig = signAssertion(
      priv,
      capabilityAssertion(DID, 'urn:acdp:cap:retrieve:doc:legal', declaredAt),
    );
    await expect(
      svc.declare({
        agentDid: DID, capabilityUri: URI, declaredAtIso: declaredAt,
        keyId: 'k', algorithm: 'ed25519', signature: otherSig,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a malformed capability URI', async () => {
    await expect(
      svc.declare({
        agentDid: DID, capabilityUri: 'not-a-urn',
        declaredAtIso: new Date().toISOString(),
        keyId: 'k', algorithm: 'ed25519', signature: 'AAA=',
      }),
    ).rejects.toThrow();
  });

  it('discovery: findAgentsWithCapability returns matching agents', async () => {
    const declaredAt = new Date().toISOString();
    await svc.declare({
      agentDid: DID, capabilityUri: URI, declaredAtIso: declaredAt,
      keyId: 'k', algorithm: 'ed25519',
      signature: signAssertion(priv, capabilityAssertion(DID, URI, declaredAt)),
    });
    const hits = await svc.findAgentsWithCapability(URI);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.agentDid).toBe(DID);
  });

  it('discovery: rejects a malformed query capability_uri', async () => {
    await expect(svc.findAgentsWithCapability('not-a-urn')).rejects.toThrow();
  });

  it('discovery: listForAgent returns the agent\'s declarations', async () => {
    const declaredAt = new Date().toISOString();
    await svc.declare({
      agentDid: DID, capabilityUri: URI, declaredAtIso: declaredAt,
      keyId: 'k', algorithm: 'ed25519',
      signature: signAssertion(priv, capabilityAssertion(DID, URI, declaredAt)),
    });
    const caps = await svc.listForAgent(DID);
    expect(caps).toHaveLength(1);
    expect(caps[0]!.capabilityUri).toBe(URI);
  });

  describe('tenant scoping', () => {
    it('threads the caller tenant into repo.declare', async () => {
      const spy = jest.spyOn(repo, 'declare');
      const declaredAt = new Date().toISOString();
      await svc.declare(
        {
          agentDid: DID, capabilityUri: URI, declaredAtIso: declaredAt,
          keyId: 'k', algorithm: 'ed25519',
          signature: signAssertion(priv, capabilityAssertion(DID, URI, declaredAt)),
        },
        'tenant-b',
      );
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-b' }),
      );
    });

    it('threads the caller tenant into repo.findByAgent', async () => {
      const spy = jest.spyOn(repo, 'findByAgent');
      await svc.listForAgent(DID, 'tenant-b');
      expect(spy).toHaveBeenCalledWith(DID, 'tenant-b');
    });

    it('threads the caller tenant into repo.findByCapability', async () => {
      const spy = jest.spyOn(repo, 'findByCapability');
      await svc.findAgentsWithCapability(URI, 'tenant-b');
      expect(spy).toHaveBeenCalledWith(URI, 'tenant-b');
    });

    it('defaults to the default tenant when none is supplied', async () => {
      const spy = jest.spyOn(repo, 'findByAgent');
      await svc.listForAgent(DID);
      expect(spy).toHaveBeenCalledWith(DID, 'default');
    });
  });
});
