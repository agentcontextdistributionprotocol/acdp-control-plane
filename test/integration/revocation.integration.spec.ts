/**
 * RFC-ACDP-0014 producer key-revocation (Phase 12) integration coverage:
 * ingest a `key-revocation` webhook envelope (both accepted context-type
 * spellings), run `RevocationAuditService.sweep()` against a real, genuinely
 * signed retrieval body served by a stubbed `SafeFederationClient`, and
 * confirm the verified fact lands in `key_revocations` with the right trust
 * class — end to end through the real app graph, the way
 * `log-witness.integration.spec.ts` exercises its own sweep.
 *
 * The federation FETCH boundary is stubbed (this registry is not a real
 * host); the SIGNATURE VERIFICATION is real — bodies are minted with the
 * genuine `acdp` SDK the same way `revocation-verify.spec.ts` does. The
 * did:web registry-attested case additionally stubs `DidWebResolverService
 * .resolveKey` (the DID-document HTTP boundary) while still running a real
 * Ed25519 signature check against the resolved key.
 */
import { AcdpProducer } from '@agentcontextdistributionprotocol/acdp';
import { DidWebResolverService } from '../../src/auth/did-web/did-web-resolver.service';
import { RevocationAuditService } from '../../src/audit/revocation-audit.service';
import { fingerprintEd25519B64 } from '../../src/audit/receipt-verify';
import { SafeFederationClient, FederationResponse } from '../../src/contexts/safe-federation-client';
import { KeyRevocationRepository } from '../../src/storage/key-revocation.repository';
import { createTestApp, TestAppContext } from '../helpers/test-app';

const SECRET = 'integration-test-secret';
const LINEAGE_ID = 'lin:sha256:' + '6'.repeat(64);
const REGISTRY_CREATED_AT = '2026-05-02T08:00:00.000Z';
const COMPROMISED_SINCE = '2026-05-01T00:00:00.000Z';

/**
 * Each test that probes `/.well-known/acdp.json` gets its OWN authority.
 * `RegistryProfileService` caches capabilities per (tenant, authority) for
 * 10 minutes IN-MEMORY, and this app instance is shared across every test in
 * this file (only the DB is truncated between them) — reusing an authority
 * across tests would silently serve a stale cached `registry_did` from an
 * earlier test instead of the one this test just stubbed.
 */
function fixtureFor(authority: string) {
  const baseUrl = `https://${authority}`;
  const ctxId = `acdp://${authority}/9f1e2d3c-5a6b-4c7d-8e9f-0a1b2c3d4e5f`;
  return { authority, baseUrl, ctxId };
}

function webhookPayload(
  fixture: { authority: string; baseUrl: string; ctxId: string },
  overrides: Record<string, unknown> = {},
) {
  return {
    type: 'context_published',
    ctx_id: fixture.ctxId,
    lineage_id: LINEAGE_ID,
    agent_id: 'did:key:PLACEHOLDER',
    context_type: 'key-revocation',
    visibility: 'public',
    version: 1,
    derived_from: [],
    registry_authority: fixture.authority,
    registry_base_url: fixture.baseUrl,
    created_at: REGISTRY_CREATED_AT,
    ...overrides,
  };
}

describe('producer key-revocation sweep (RFC-ACDP-0014, integration)', () => {
  let ctx: TestAppContext;
  let revocationSvc: RevocationAuditService;
  let revocationRepo: KeyRevocationRepository;
  let federationGetSpy: jest.SpyInstance;

  beforeAll(async () => {
    ctx = await createTestApp({ webhookSecret: SECRET });
    revocationSvc = ctx.module.get(RevocationAuditService);
    revocationRepo = ctx.module.get(KeyRevocationRepository);
  });

  beforeEach(async () => {
    await ctx.cleanup();
    federationGetSpy = jest.spyOn(ctx.module.get(SafeFederationClient), 'get');
  });

  afterEach(() => {
    federationGetSpy.mockRestore();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  function stubRetrieval(fixture: { baseUrl: string; ctxId: string }, body: Record<string, unknown>) {
    federationGetSpy.mockImplementation(async (url: string): Promise<FederationResponse> => {
      if (url === `${fixture.baseUrl}/contexts/${encodeURIComponent(fixture.ctxId)}`) {
        return { status: 200, contentType: 'application/json', body: JSON.stringify({ body }) };
      }
      throw new Error(`unexpected federation fetch in test: ${url}`);
    });
  }

  function stubRetrievalAndCapabilities(
    fixture: { baseUrl: string; ctxId: string },
    body: Record<string, unknown>,
    registryDid: string,
  ) {
    federationGetSpy.mockImplementation(async (url: string): Promise<FederationResponse> => {
      if (url === `${fixture.baseUrl}/contexts/${encodeURIComponent(fixture.ctxId)}`) {
        return { status: 200, contentType: 'application/json', body: JSON.stringify({ body }) };
      }
      if (url === `${fixture.baseUrl}/.well-known/acdp.json`) {
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            profiles: [],
            registry_did: registryDid,
            acdp_version: '0.3.0',
          }),
        };
      }
      throw new Error(`unexpected federation fetch in test: ${url}`);
    });
  }

  /** Signed did:key producer_signed revocation body, registry-assigned fields merged in. */
  function producerSignedBody(
    fixture: { authority: string; ctxId: string },
    producer: InstanceType<typeof AcdpProducer>,
    revokedFp: string,
    contextType: 'key-revocation' | 'acdp:key-revocation' = 'key-revocation',
  ): Record<string, unknown> {
    const requestJson = producer.buildPublishRequest({
      title: 'Key revocation — key compromised',
      contextType,
      metadata: JSON.stringify({
        revoked_key_fingerprint: revokedFp,
        compromised_since: COMPROMISED_SINCE,
        reason: 'laptop theft',
      }),
    });
    return {
      ...(JSON.parse(requestJson) as Record<string, unknown>),
      ctx_id: fixture.ctxId,
      lineage_id: LINEAGE_ID,
      origin_registry: fixture.authority,
      created_at: REGISTRY_CREATED_AT,
    };
  }

  it('discovers, verifies, and persists a producer-signed did:key revocation ingested via webhook', async () => {
    const fixture = fixtureFor('reg-producer-signed.example');
    const producer = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 3));
    const revokedKey = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 4));
    const revokedFp = fingerprintEd25519B64(revokedKey.publicKeyB64);

    const res = await ctx.client.ingest(
      webhookPayload(fixture, { agent_id: producer.agentDid }),
      { runId: 'run-rev-1', secret: SECRET },
    );
    expect(res.status).toBe(204);

    stubRetrieval(fixture, producerSignedBody(fixture, producer, revokedFp));

    const n = await revocationSvc.sweep();
    expect(n).toBe(1);

    const facts = await revocationRepo.findByFingerprint(revokedFp, 'default');
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      ctxId: fixture.ctxId,
      revokedKeyFingerprint: revokedFp,
      compromisedSince: expect.stringContaining('2026-05-01'),
      publisher: producer.agentDid,
      trustClass: 'producer_signed',
      lineageId: LINEAGE_ID,
      originAuthority: fixture.authority,
      contextType: 'key-revocation',
    });
  });

  it('discovers a revocation under the pre-0.3.0 interim spelling acdp:key-revocation', async () => {
    const fixture = fixtureFor('reg-interim-spelling.example');
    const producer = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 5));
    const revokedKey = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 6));
    const revokedFp = fingerprintEd25519B64(revokedKey.publicKeyB64);

    await ctx.client.ingest(
      webhookPayload(fixture, { agent_id: producer.agentDid, context_type: 'acdp:key-revocation' }),
      { runId: 'run-rev-2', secret: SECRET },
    );
    stubRetrieval(fixture, producerSignedBody(fixture, producer, revokedFp, 'acdp:key-revocation'));

    const n = await revocationSvc.sweep();
    expect(n).toBe(1);
    const facts = await revocationRepo.findByFingerprint(revokedFp, 'default');
    expect(facts).toHaveLength(1);
    expect(facts[0].contextType).toBe('acdp:key-revocation');
  });

  it('verifies and persists a registry_attested revocation whose §6 binding passes', async () => {
    const fixture = fixtureFor('reg-attested-ok.example');
    const registry = AcdpProducer.generate(`did:web:${fixture.authority}`, `did:web:${fixture.authority}#key-1`);
    const producerControllerDid = 'did:web:agents.example.com:affected-producer';
    const revokedKey = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 7));
    const revokedFp = fingerprintEd25519B64(revokedKey.publicKeyB64);

    await ctx.client.ingest(
      webhookPayload(fixture, { agent_id: registry.agentDid }),
      { runId: 'run-rev-3', secret: SECRET },
    );

    const requestJson = registry.buildPublishRequest({
      title: 'Key revocation — registry attested (lost everything)',
      contextType: 'key-revocation',
      metadata: JSON.stringify({
        revoked_key_fingerprint: revokedFp,
        compromised_since: COMPROMISED_SINCE,
        revoked_key_controller: producerControllerDid,
      }),
    });
    const body = {
      ...(JSON.parse(requestJson) as Record<string, unknown>),
      ctx_id: fixture.ctxId,
      lineage_id: LINEAGE_ID,
      origin_registry: fixture.authority,
      created_at: REGISTRY_CREATED_AT,
    };
    stubRetrievalAndCapabilities(fixture, body, registry.agentDid);

    jest.spyOn(ctx.module.get(DidWebResolverService), 'resolveKey').mockResolvedValue({
      keyId: registry.keyId,
      algorithm: 'ed25519',
      publicKeyB64: registry.publicKeyB64,
    });

    const n = await revocationSvc.sweep();
    expect(n).toBe(1);
    const facts = await revocationRepo.findByFingerprint(revokedFp, 'default');
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      trustClass: 'registry_attested',
      publisher: registry.agentDid,
      revokedKeyController: producerControllerDid,
    });
  });

  it('does NOT persist a registry_attested claim whose §6 binding fails (foreign registry_did)', async () => {
    const fixture = fixtureFor('reg-attested-fail.example');
    const registry = AcdpProducer.generate(`did:web:${fixture.authority}`, `did:web:${fixture.authority}#key-1`);
    const revokedKey = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 8));
    const revokedFp = fingerprintEd25519B64(revokedKey.publicKeyB64);

    await ctx.client.ingest(
      webhookPayload(fixture, { agent_id: registry.agentDid }),
      { runId: 'run-rev-4', secret: SECRET },
    );

    const requestJson = registry.buildPublishRequest({
      title: 'Key revocation — registry attested, mismatched capabilities',
      contextType: 'key-revocation',
      metadata: JSON.stringify({
        revoked_key_fingerprint: revokedFp,
        compromised_since: COMPROMISED_SINCE,
        revoked_key_controller: 'did:web:agents.example.com:affected-producer',
      }),
    });
    const body = {
      ...(JSON.parse(requestJson) as Record<string, unknown>),
      ctx_id: fixture.ctxId,
      lineage_id: LINEAGE_ID,
      origin_registry: fixture.authority,
      created_at: REGISTRY_CREATED_AT,
    };
    // The registry's own /.well-known/acdp.json disagrees with the publisher
    // it actually signed under — the §6 cross-check must fail closed.
    stubRetrievalAndCapabilities(fixture, body, 'did:web:a-different-registry.example');

    jest.spyOn(ctx.module.get(DidWebResolverService), 'resolveKey').mockResolvedValue({
      keyId: registry.keyId,
      algorithm: 'ed25519',
      publicKeyB64: registry.publicKeyB64,
    });

    const n = await revocationSvc.sweep();
    expect(n).toBe(1); // the candidate WAS processed
    const facts = await revocationRepo.findByFingerprint(revokedFp, 'default');
    expect(facts).toHaveLength(0); // but not persisted
  });

  it('is idempotent: a verified fact is never re-fetched or re-verified on a later sweep', async () => {
    const fixture = fixtureFor('reg-idempotent.example');
    const producer = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 9));
    const revokedKey = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 10));
    const revokedFp = fingerprintEd25519B64(revokedKey.publicKeyB64);

    await ctx.client.ingest(
      webhookPayload(fixture, { agent_id: producer.agentDid }),
      { runId: 'run-rev-5', secret: SECRET },
    );
    stubRetrieval(fixture, producerSignedBody(fixture, producer, revokedFp));

    expect(await revocationSvc.sweep()).toBe(1);
    expect(await revocationRepo.findByFingerprint(revokedFp, 'default')).toHaveLength(1);

    // Second pass: findCandidates excludes the now-recorded ctx_id, so the
    // federation client must not be hit again.
    federationGetSpy.mockClear();
    expect(await revocationSvc.sweep()).toBe(0);
    expect(federationGetSpy).not.toHaveBeenCalled();
    expect(await revocationRepo.findByFingerprint(revokedFp, 'default')).toHaveLength(1);
  });

  it('does not persist a tampered body (signature verification fails)', async () => {
    const fixture = fixtureFor('reg-tampered.example');
    const producer = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 11));
    const revokedKey = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 12));
    const revokedFp = fingerprintEd25519B64(revokedKey.publicKeyB64);

    await ctx.client.ingest(
      webhookPayload(fixture, { agent_id: producer.agentDid }),
      { runId: 'run-rev-6', secret: SECRET },
    );
    const tampered = producerSignedBody(fixture, producer, revokedFp);
    tampered.title = 'a different title than what was signed';
    stubRetrieval(fixture, tampered);

    const n = await revocationSvc.sweep();
    expect(n).toBe(1);
    expect(await revocationRepo.findByFingerprint(revokedFp, 'default')).toHaveLength(0);
  });
});
