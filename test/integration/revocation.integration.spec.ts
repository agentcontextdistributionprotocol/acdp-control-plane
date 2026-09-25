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
import { AcdpP256Producer, AcdpProducer } from '@agentcontextdistributionprotocol/acdp';
import { DidWebResolverService } from '../../src/auth/did-web/did-web-resolver.service';
import { RevocationAuditService } from '../../src/audit/revocation-audit.service';
import { fingerprintEd25519B64 } from '../../src/audit/receipt-verify';
import { SafeFederationClient, FederationResponse } from '../../src/contexts/safe-federation-client';
import { KeyRevocationRepository } from '../../src/storage/key-revocation.repository';
import { InstrumentationService } from '../../src/telemetry/instrumentation.service';
import { createTestApp, TestAppContext } from '../helpers/test-app';

/**
 * Reads one `{status}` label's current value off the real, process-global
 * `keyRevocationLineageMembersTotal` counter. Callers must assert a DELTA
 * (before/after a `sweep()` under test), never an absolute value — the
 * counter is shared across every test in this file and is never reset
 * between them (see the P-256 mixed-lineage test below).
 */
async function lineageMemberCount(instrumentation: InstrumentationService, status: string): Promise<number> {
  const metric = await instrumentation.keyRevocationLineageMembersTotal.get();
  return metric.values.find((v) => v.labels['status'] === status)?.value ?? 0;
}

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

  /**
   * The `/lineages/{lineage_id}` response for a fixture whose lineage
   * contains only the one context under test — a single-member `FullContext`
   * array (RFC-ACDP-0014 §7's lineage walk fetches this after every
   * newly-verified fact; see revocation-lineage.spec.ts for the walk's own
   * dedicated coverage). Kept separate from `stubRetrieval` so a test can
   * override just this response when it wants to exercise a multi-member
   * lineage instead.
   */
  function lineageOf(fixture: { ctxId: string }, body: Record<string, unknown>): FederationResponse {
    return {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ body, registry_state: { status: 'active' } }]),
    };
  }

  function stubRetrieval(fixture: { baseUrl: string; ctxId: string }, body: Record<string, unknown>) {
    federationGetSpy.mockImplementation(async (url: string): Promise<FederationResponse> => {
      if (url === `${fixture.baseUrl}/contexts/${encodeURIComponent(fixture.ctxId)}`) {
        return { status: 200, contentType: 'application/json', body: JSON.stringify({ body }) };
      }
      if (url.startsWith(`${fixture.baseUrl}/lineages/`)) {
        return lineageOf(fixture, body);
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
      if (url.startsWith(`${fixture.baseUrl}/lineages/`)) {
        return lineageOf(fixture, body);
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

  // ── §7 lineage walk (Phase 13) ──────────────────────────────────────────
  describe('lineage walk', () => {
    it('discovers an EARLIER revocation in the same lineage that was never itself delivered via webhook', async () => {
      const fixture = fixtureFor('reg-lineage-walk.example');
      const producer = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 13));
      const revokedKey = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 14));
      const revokedFp = fingerprintEd25519B64(revokedKey.publicKeyB64);

      // R1: the EARLIEST revocation in the lineage — exists only inside the
      // lineage array below, never webhooked on its own (the realistic case:
      // a registry's webhook fires for the lineage HEAD, R2, and only a
      // lineage walk recovers an earlier member a webhook never announced).
      const r1CtxId = `acdp://${fixture.authority}/00000000-0000-4000-8000-000000000001`;
      const r1 = {
        ...(JSON.parse(
          producer.buildPublishRequest({
            title: 'Key revocation — earliest boundary',
            contextType: 'key-revocation',
            metadata: JSON.stringify({
              revoked_key_fingerprint: revokedFp,
              compromised_since: '2026-03-01T00:00:00.000Z',
              reason: 'earliest known compromise boundary',
            }),
          }),
        ) as Record<string, unknown>),
        ctx_id: r1CtxId,
        lineage_id: LINEAGE_ID,
        origin_registry: fixture.authority,
        created_at: '2026-03-01T00:05:00.000Z',
      };
      // R2: the lineage HEAD — this is the one the webhook actually announces.
      const r2 = producerSignedBody(fixture, producer, revokedFp);

      await ctx.client.ingest(
        webhookPayload(fixture, { agent_id: producer.agentDid }),
        { runId: 'run-rev-lineage-1', secret: SECRET },
      );
      federationGetSpy.mockImplementation(async (url: string): Promise<FederationResponse> => {
        if (url === `${fixture.baseUrl}/contexts/${encodeURIComponent(fixture.ctxId)}`) {
          return { status: 200, contentType: 'application/json', body: JSON.stringify({ body: r2 }) };
        }
        if (url === `${fixture.baseUrl}/lineages/${encodeURIComponent(LINEAGE_ID)}`) {
          return {
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([
              { body: r1, registry_state: { status: 'superseded' } },
              { body: r2, registry_state: { status: 'active' } },
            ]),
          };
        }
        throw new Error(`unexpected federation fetch in test: ${url}`);
      });

      const n = await revocationSvc.sweep();
      expect(n).toBe(1);

      const facts = await revocationRepo.findByFingerprint(revokedFp, 'default');
      expect(facts.map((f) => f.ctxId).sort()).toEqual([r1CtxId, fixture.ctxId].sort());
      const r1Fact = facts.find((f) => f.ctxId === r1CtxId);
      expect(r1Fact).toMatchObject({ compromisedSince: expect.stringContaining('2026-03-01'), lineageId: LINEAGE_ID });

      // A cursor marks this lineage as freshly walked — a later sweep within
      // the TTL must not re-walk it (the same idempotency guarantee the
      // per-event path already has, extended to the lineage walk).
      federationGetSpy.mockClear();
      expect(await revocationSvc.sweep()).toBe(0);
      expect(federationGetSpy).not.toHaveBeenCalled();
    });

    it(
      'a P-256 member sharing a lineage does not abort the walk — an EARLIER Ed25519 member ' +
        'is still discovered and persisted (issue #170)',
      async () => {
        const fixture = fixtureFor('reg-lineage-p256.example');
        const producer = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 20));
        const revokedKey = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 21));
        const revokedFp = fingerprintEd25519B64(revokedKey.publicKeyB64);

        // R1: the EARLIEST revocation — exists only inside the lineage array,
        // never webhooked on its own (same shape as the "discovers an
        // EARLIER revocation" test above). This is the fact that must still
        // be discovered despite the P-256 member sharing the lineage. Note:
        // pre-fix, a did:key P-256 member (the flavor this test uses)
        // classified 'invalid', not 'unavailable' — so THIS specific
        // combination would already have dropped-not-aborted even before
        // this fix. The did:web P-256 branch is the one that pre-fix
        // classified 'unavailable' and would have aborted the whole walk
        // (Rule 3) here — that abort-vs-drop routing is proven directly (and
        // for BOTH branches' real outcomes) by revocation-lineage.spec.ts's
        // unit-level "member verifying as unsupported... does NOT abort"
        // test, since walkRevocationLineage's Rule 2/3 routing depends only
        // on the verdict's `status`, never on which DID method produced it.
        // What THIS test proves is the thing unit tests can't: that a REAL,
        // genuinely-signed P-256 body flows through the real crypto pipeline
        // end to end to an 'unsupported' verdict, and that the surrounding
        // lineage still persists correctly around it.
        const r1CtxId = `acdp://${fixture.authority}/00000000-0000-4000-8000-0000000000a1`;
        const r1 = {
          ...(JSON.parse(
            producer.buildPublishRequest({
              title: 'Key revocation — earliest boundary',
              contextType: 'key-revocation',
              metadata: JSON.stringify({
                revoked_key_fingerprint: revokedFp,
                compromised_since: '2026-03-01T00:00:00.000Z',
                reason: 'earliest known compromise boundary',
              }),
            }),
          ) as Record<string, unknown>),
          ctx_id: r1CtxId,
          lineage_id: LINEAGE_ID,
          origin_registry: fixture.authority,
          created_at: '2026-03-01T00:05:00.000Z',
        };

        // A genuinely-signed P-256 did:key revocation body — real crypto via
        // the SDK's AcdpP256Producer, same as every other fixture in this
        // file. This pipeline has no verification path for ecdsa-p256 (no
        // SDK fingerprint helper), so it must be dropped as 'unsupported'
        // WITHOUT aborting the walk — the exact scenario issue #170 exists
        // to fix.
        const p256Producer = AcdpP256Producer.fromSeedDidKey(Buffer.alloc(32, 22));
        const p256CtxId = `acdp://${fixture.authority}/00000000-0000-4000-8000-0000000000a2`;
        const p256Member = {
          ...(JSON.parse(
            p256Producer.buildPublishRequest({
              title: 'Key revocation — P-256 signer (unsupported here)',
              contextType: 'key-revocation',
              metadata: JSON.stringify({
                revoked_key_fingerprint: revokedFp,
                compromised_since: '2026-01-01T00:00:00.000Z',
                reason: 'P-256 signer — must be dropped, must not abort the walk',
              }),
            }),
          ) as Record<string, unknown>),
          ctx_id: p256CtxId,
          lineage_id: LINEAGE_ID,
          origin_registry: fixture.authority,
          created_at: '2026-01-01T00:05:00.000Z',
        };

        // R2: the lineage HEAD — the one the webhook actually announces.
        // sweep() only queues a lineage walk after its OWN webhook candidate
        // verifies, so the Ed25519 revocation under test must be the
        // ingested/webhooked one; the P-256 member lives only in the
        // /lineages/ response.
        const r2 = producerSignedBody(fixture, producer, revokedFp);

        await ctx.client.ingest(
          webhookPayload(fixture, { agent_id: producer.agentDid }),
          { runId: 'run-rev-lineage-p256', secret: SECRET },
        );
        federationGetSpy.mockImplementation(async (url: string): Promise<FederationResponse> => {
          if (url === `${fixture.baseUrl}/contexts/${encodeURIComponent(fixture.ctxId)}`) {
            return { status: 200, contentType: 'application/json', body: JSON.stringify({ body: r2 }) };
          }
          if (url === `${fixture.baseUrl}/lineages/${encodeURIComponent(LINEAGE_ID)}`) {
            return {
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify([
                { body: r1, registry_state: { status: 'superseded' } },
                { body: p256Member, registry_state: { status: 'active' } },
                { body: r2, registry_state: { status: 'active' } },
              ]),
            };
          }
          throw new Error(`unexpected federation fetch in test: ${url}`);
        });

        // issue #173: the lineage walk's per-member verdicts land on a real
        // Prometheus counter. Delta-based — this counter is process-global
        // for the whole spec file and several earlier tests already drive
        // lineage walks, so an absolute assertion would already be wrong.
        const instrumentation = ctx.module.get(InstrumentationService);
        const verifiedBefore = await lineageMemberCount(instrumentation, 'verified');
        const unsupportedBefore = await lineageMemberCount(instrumentation, 'unsupported');

        const n = await revocationSvc.sweep();
        expect(n).toBe(1);

        // Both Ed25519 facts (the webhooked head AND the lineage-only
        // earlier member) persist. The P-256 member does NOT — it was
        // dropped as 'unsupported', and critically, it did NOT abort the
        // walk. A status of 'unavailable' WOULD have aborted here per Rule
        // 3, leaving R1 permanently undiscovered — that is the did:web
        // branch's pre-fix behavior (issue #170), proven directly by
        // revocation-lineage.spec.ts's unit-level abort-vs-drop tests;
        // this end-to-end test instead proves the did:key P-256 signature
        // genuinely verifies and the resulting 'unsupported' verdict flows
        // correctly through the real walk without aborting or folding in.
        const facts = await revocationRepo.findByFingerprint(revokedFp, 'default');
        expect(facts.map((f) => f.ctxId).sort()).toEqual([r1CtxId, fixture.ctxId].sort());

        // The lineage has three key-revocation-typed members (r1, p256Member,
        // r2 — the type filter drops none of them), so the walk's tally is
        // two 'verified' (r1, r2 — r2 is re-verified by the walk even though
        // its own fact was already recorded by the webhook-candidate path;
        // revocationRepo.record's onConflictDoNothing is what makes that
        // re-observation idempotent) and one 'unsupported' (the P-256 member).
        expect((await lineageMemberCount(instrumentation, 'verified')) - verifiedBefore).toBe(2);
        expect((await lineageMemberCount(instrumentation, 'unsupported')) - unsupportedBefore).toBe(1);

        // A cursor still marks this lineage as freshly walked despite the
        // dropped P-256 member — same idempotency guarantee as the
        // all-Ed25519 lineage-walk test above. Reading the "after" values
        // above BEFORE this second sweep is deliberate — it asserts 0
        // candidates and no federation calls, so the tally must not move.
        federationGetSpy.mockClear();
        expect(await revocationSvc.sweep()).toBe(0);
        expect(federationGetSpy).not.toHaveBeenCalled();
      },
    );

    it('cursor semantics against the real database: zero facts for a lineage forces a walk even once a cursor already exists', async () => {
      const fixture = fixtureFor('reg-lineage-cursor.example');
      const producer = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 15));
      // A cursor claiming this lineage was "already walked" — but with NO
      // matching key_revocations rows, which must never be enough to skip a
      // walk (migration 0022's header; see revocation-audit.service.ts's
      // file-level doc comment on this exact rule).
      await revocationRepo.recordLineageWalk('default', LINEAGE_ID, fixture.authority);
      expect(await revocationRepo.countByLineage('default', LINEAGE_ID)).toBe(0);
      expect(await revocationRepo.findFreshLineageCursor('default', LINEAGE_ID, fixture.authority, 60 * 60 * 1000)).toBe(true);

      const revokedKey = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 16));
      const revokedFp = fingerprintEd25519B64(revokedKey.publicKeyB64);
      await ctx.client.ingest(
        webhookPayload(fixture, { agent_id: producer.agentDid }),
        { runId: 'run-rev-lineage-2', secret: SECRET },
      );
      stubRetrieval(fixture, producerSignedBody(fixture, producer, revokedFp));

      const n = await revocationSvc.sweep();
      expect(n).toBe(1);
      // The lineage endpoint WAS hit despite the pre-existing fresh cursor.
      expect(federationGetSpy).toHaveBeenCalledWith(`${fixture.baseUrl}/lineages/${encodeURIComponent(LINEAGE_ID)}`);
      expect(await revocationRepo.findByFingerprint(revokedFp, 'default')).toHaveLength(1);
    });
  });
});
