import {
  RegistryProfileService,
  RECEIPTS_PROFILE,
  TRANSPARENCY_LOG_PROFILE,
} from './registry-profile.service';

describe('RegistryProfileService', () => {
  let registryRepo: any;
  let federationClient: any;
  let svc: RegistryProfileService;

  beforeEach(() => {
    registryRepo = {
      findByAuthority: jest
        .fn()
        .mockResolvedValue({ authority: 'reg.example', baseUrl: 'https://reg.example' }),
    };
    federationClient = {
      get: jest.fn().mockResolvedValue({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          acdp_version: '0.2.0',
          profiles: ['acdp-registry-core', RECEIPTS_PROFILE],
        }),
      }),
    };
    svc = new RegistryProfileService(registryRepo, federationClient);
  });

  it('reads the receipts profile from /.well-known/acdp.json', async () => {
    await expect(svc.advertisesReceipts('reg.example', 'default')).resolves.toBe(true);
    expect(federationClient.get).toHaveBeenCalledWith(
      'https://reg.example/.well-known/acdp.json',
    );
  });

  it('returns false for a 0.1.0 registry without the profile', async () => {
    federationClient.get.mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ acdp_version: '0.1.0', profiles: ['acdp-registry-core'] }),
    });
    await expect(svc.advertisesReceipts('reg.example', 'default')).resolves.toBe(false);
  });

  it('returns null (never a flag) when the registry is unknown or unreachable', async () => {
    registryRepo.findByAuthority.mockResolvedValue(null);
    await expect(svc.advertisesReceipts('ghost.example', 'default')).resolves.toBeNull();

    registryRepo.findByAuthority.mockResolvedValue({
      authority: 'reg.example',
      baseUrl: 'https://reg.example',
    });
    federationClient.get.mockRejectedValue(new Error('SSRF: forbidden range'));
    await expect(svc.advertisesReceipts('down.example', 'default')).resolves.toBeNull();
  });

  it('caches per (tenant, authority)', async () => {
    await svc.advertisesReceipts('reg.example', 'default');
    await svc.advertisesReceipts('reg.example', 'default');
    expect(federationClient.get).toHaveBeenCalledTimes(1);

    await svc.advertisesReceipts('reg.example', 'tenant-b');
    expect(federationClient.get).toHaveBeenCalledTimes(2);
    expect(svc.cacheSize()).toBe(2);
  });

  it('detects the transparency-log profile (RFC-ACDP-0012 §11) off the same probe', async () => {
    federationClient.get.mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        acdp_version: '0.3.0',
        profiles: ['acdp-registry-core', RECEIPTS_PROFILE, TRANSPARENCY_LOG_PROFILE],
      }),
    });
    await expect(svc.advertisesTransparencyLog('reg.example', 'default')).resolves.toBe(true);
    // Both questions answered from ONE cached probe.
    await expect(svc.advertisesReceipts('reg.example', 'default')).resolves.toBe(true);
    expect(federationClient.get).toHaveBeenCalledTimes(1);
  });

  it('a receipts-only 0.2.0 registry does not advertise the log', async () => {
    await expect(svc.advertisesTransparencyLog('reg.example', 'default')).resolves.toBe(false);
    await expect(svc.advertisesReceipts('reg.example', 'default')).resolves.toBe(true);
  });

  describe('registryCapabilities (RFC-ACDP-0014 §6)', () => {
    it('extracts registry_did and acdp_version off the same document, at no extra HTTP cost', async () => {
      federationClient.get.mockResolvedValue({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          acdp_version: '0.3.0',
          registry_did: 'did:web:reg.example',
          profiles: ['acdp-registry-core', RECEIPTS_PROFILE],
        }),
      });

      await expect(svc.registryCapabilities('reg.example', 'default')).resolves.toEqual({
        registryDid: 'did:web:reg.example',
        acdpVersion: '0.3.0',
      });

      // A second query (and a query of the unrelated profiles tri-state)
      // reuses the same cached entry — one HTTP fetch total.
      await svc.advertisesReceipts('reg.example', 'default');
      await svc.registryCapabilities('reg.example', 'default');
      expect(federationClient.get).toHaveBeenCalledTimes(1);
    });

    it('returns both fields as null (tri-stated together) when the document is unreadable', async () => {
      registryRepo.findByAuthority.mockResolvedValue(null);
      await expect(svc.registryCapabilities('ghost.example', 'default')).resolves.toEqual({
        registryDid: null,
        acdpVersion: null,
      });
    });

    it('returns registryDid null (acdpVersion unaffected) when the document omits registry_did', async () => {
      // The beforeEach fixture has no registry_did — an older/partial
      // capabilities document must not crash the probe, and the two fields
      // are extracted independently (one missing does not null the other).
      await expect(svc.registryCapabilities('reg.example', 'default')).resolves.toEqual({
        registryDid: null,
        acdpVersion: '0.2.0',
      });
    });

    it('ignores a non-string registry_did rather than propagating a malformed value', async () => {
      federationClient.get.mockResolvedValue({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ registry_did: 12345, profiles: [] }),
      });
      await expect(svc.registryCapabilities('reg.example', 'default')).resolves.toEqual({
        registryDid: null,
        acdpVersion: null,
      });
    });
  });
});
