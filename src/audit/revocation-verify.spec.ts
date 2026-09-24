import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AcdpCanonicalizer, AcdpProducer, AcdpVerifier } from '@agentcontextdistributionprotocol/acdp';
import { verifySignatureB64 } from '../auth/acdp-verify';
import { fingerprintEd25519B64, verifyBodyOffline, verifyContentHash } from './receipt-verify';
import { parseKeyRevocation, RevocationSurface, sdkSupportsRevocations } from './revocation-verify';

// ── Type-level pin, same discipline as receipt-verify.spec.ts ──────────────
//
// `RevocationSurface` is `Pick<typeof AcdpVerifier, 'parseKeyRevocation'>`, so
// it IS the installed binding's own declared signature — a hand-copied
// interface laundered through `as unknown as` would NOT catch a future SDK
// narrowing/widening `parseKeyRevocation`'s parameters, which is exactly what
// CLAUDE.md's CI grep rule #6 exists to prevent.
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type _RevocationSurfaceIsBindingDerived = Expect<
  Equal<RevocationSurface['parseKeyRevocation'], typeof AcdpVerifier.parseKeyRevocation>
>;

describe('revocation-verify (SDK feature detection)', () => {
  const preRevocationSdk = !sdkSupportsRevocations();
  const describePre = preRevocationSdk ? describe : describe.skip;
  const describeRevocations = preRevocationSdk ? describe.skip : describe;

  describePre('with a pre-revocation SDK installed', () => {
    it('parseKeyRevocation refuses loudly rather than pretending to parse', () => {
      expect(() => parseKeyRevocation('{}', 'sha256:' + 'a'.repeat(64))).toThrow(
        /no parseKeyRevocation/,
      );
    });
  });

  // ── The critical trap this wrapper exists to close ───────────────────────
  it('throws a TypeError on an empty signerFingerprint — BEFORE reaching the SDK', () => {
    // Asserted even under a pre-revocation SDK: the empty-fingerprint guard
    // must fire first, regardless of what's installed.
    expect(() => parseKeyRevocation('{}', '')).toThrow(TypeError);
    expect(() => parseKeyRevocation('{}', '')).toThrow(/non-empty signerFingerprint/);
  });

  describeRevocations('with the revocation-capable SDK installed', () => {
    const REASON = 'laptop theft; private key material presumed exfiltrated';
    const COMPROMISED_SINCE = '2026-05-01T00:00:00.000Z';

    /** A did:web producer whose body signature requires DID resolution (no native did:key check). */
    const producer = AcdpProducer.generate(
      'did:web:agents.example.com:test-producer',
      'did:web:agents.example.com:test-producer#key-1',
    );
    const producerFp = fingerprintEd25519B64(producer.publicKeyB64);

    /** A distinct key standing in for the REVOKED key (never the signer). */
    const revokedKey = AcdpProducer.generate(
      'did:web:agents.example.com:test-producer',
      'did:web:agents.example.com:test-producer#key-0',
    );
    const revokedFp = fingerprintEd25519B64(revokedKey.publicKeyB64);

    function buildRevocationBody(metadataOverrides: Record<string, unknown> = {}): string {
      const metadata = JSON.stringify({
        revoked_key_fingerprint: revokedFp,
        compromised_since: COMPROMISED_SINCE,
        reason: REASON,
        ...metadataOverrides,
      });
      const requestJson = producer.buildPublishRequest({
        title: 'Key revocation — key-0 compromised',
        contextType: 'key-revocation',
        metadata,
      });
      // Registry-assigned fields, merged on top exactly as a retrieval would
      // (rev-001-revocation-context-golden.json's publish_request_body vs
      // registry_assigned split) — outside the content_hash preimage, so
      // adding them here does not invalidate the signature/hash.
      const request = JSON.parse(requestJson) as Record<string, unknown>;
      return JSON.stringify({
        ...request,
        ctx_id: 'acdp://registry.example.com/9f1e2d3c-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
        lineage_id: 'lin:sha256:' + '6'.repeat(64),
        origin_registry: 'registry.example.com',
        created_at: '2026-05-02T08:00:00.000Z',
      });
    }

    it('parses a genuine producer-signed revocation end-to-end', () => {
      const bodyJson = buildRevocationBody();
      // Sanity: this is a real, independently-verifiable signed body, not a
      // hand-typed fixture — the same pipeline the sweep would run.
      expect(verifyBodyOffline(bodyJson).ok).toBe(false); // did:web — not offline-verifiable
      const bodyObj = JSON.parse(bodyJson) as { content_hash: string };
      expect(verifyContentHash(bodyJson, bodyObj.content_hash)).toEqual({ ok: true });

      const out = parseKeyRevocation(bodyJson, producerFp);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.revocation).toEqual({
        revokedKeyFingerprint: revokedFp,
        compromisedSince: COMPROMISED_SINCE,
        reason: REASON,
        revokedKeyId: null,
        revokedKeyController: producer.agentDid,
        publisher: producer.agentDid,
        trustClass: 'producer_signed',
      });
    });

    it('derives registry_attested when metadata.revoked_key_controller differs from agent_id', () => {
      const controllerDid = 'did:web:agents.example.com:other-producer';
      const bodyJson = buildRevocationBody({ revoked_key_controller: controllerDid });
      const out = parseKeyRevocation(bodyJson, producerFp);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.revocation.trustClass).toBe('registry_attested');
      expect(out.revocation.revokedKeyController).toBe(controllerDid);
      // publisher is always the BODY's agent_id — the identity it was
      // actually published under — never the controller (§6: the two must
      // never be collapsed).
      expect(out.revocation.publisher).toBe(producer.agentDid);
    });

    it('rejects §4 shape violations with code schema_violation (missing compromised_since)', () => {
      // `parseKeyRevocation` deserializes a full retrieval `Body`
      // (registry-assigned fields required), so the fixture must be the
      // merged form `buildRevocationBody` produces, not a bare
      // PublishRequest — a missing registry-assigned field fails
      // deserialization as `invalid_input` before the §4 shape check ever
      // runs, which would silently test the wrong failure mode.
      const bodyJson = buildRevocationBody({ compromised_since: undefined });
      const out = parseKeyRevocation(bodyJson, producerFp);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.code).toBe('schema_violation');
    });

    it('rejects a malformed revoked_key_fingerprint (not sha256: + 64 lowercase hex)', () => {
      const bodyJson = buildRevocationBody({ revoked_key_fingerprint: 'not-a-real-fingerprint' });
      const out = parseKeyRevocation(bodyJson, producerFp);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.code).toBe('schema_violation');
    });

    it('rejects a non-canonical compromised_since (not millisecond-precision RFC 3339 UTC)', () => {
      const bodyJson = buildRevocationBody({ compromised_since: '2026-05-01' });
      const out = parseKeyRevocation(bodyJson, producerFp);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.code).toBe('schema_violation');
    });

    it('rejects a reason exceeding 1024 characters', () => {
      const bodyJson = buildRevocationBody({ reason: 'x'.repeat(1025) });
      const out = parseKeyRevocation(bodyJson, producerFp);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.code).toBe('schema_violation');
    });

    it('rejects a non-public visibility (a revocation is a safety broadcast — audience-restricted protects nobody outside it)', () => {
      const requestJson = producer.buildPublishRequest({
        title: 'Key revocation — restricted (invalid)',
        contextType: 'key-revocation',
        visibility: 'restricted',
        audience: ['did:web:someone.example'],
        metadata: JSON.stringify({
          revoked_key_fingerprint: revokedFp,
          compromised_since: COMPROMISED_SINCE,
        }),
      });
      const request = JSON.parse(requestJson) as Record<string, unknown>;
      const bodyJson = JSON.stringify({
        ...request,
        ctx_id: 'acdp://registry.example.com/00000000-0000-4000-8000-000000000001',
        lineage_id: 'lin:sha256:' + '8'.repeat(64),
        origin_registry: 'registry.example.com',
        created_at: '2026-05-02T08:00:00.000Z',
      });
      const out = parseKeyRevocation(bodyJson, producerFp);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.code).toBe('schema_violation');
    });

    // ── did:key signer, offline path, genuine positive case ──────────────
    it('parses a valid producer-signed revocation from a did:key signer (offline-verifiable)', () => {
      const keyProducer = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 42));
      const someoneElsesKey = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 43));
      const someoneElsesFp = fingerprintEd25519B64(someoneElsesKey.publicKeyB64);
      const keyFp = fingerprintEd25519B64(keyProducer.publicKeyB64);

      const requestJson = keyProducer.buildPublishRequest({
        title: 'Key revocation — did:key producer, genuinely revoking another key',
        contextType: 'key-revocation',
        metadata: JSON.stringify({
          revoked_key_fingerprint: someoneElsesFp,
          compromised_since: COMPROMISED_SINCE,
        }),
      });
      const request = JSON.parse(requestJson) as Record<string, unknown>;
      const bodyJson = JSON.stringify({
        ...request,
        ctx_id: 'acdp://registry.example.com/00000000-0000-4000-8000-000000000002',
        lineage_id: 'lin:sha256:' + '9'.repeat(64),
        origin_registry: 'registry.example.com',
        created_at: '2026-05-02T08:00:00.000Z',
      });

      expect(verifyBodyOffline(bodyJson)).toEqual({ ok: true });
      const out = parseKeyRevocation(bodyJson, keyFp);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.revocation).toEqual({
        revokedKeyFingerprint: someoneElsesFp,
        compromisedSince: COMPROMISED_SINCE,
        reason: null,
        revokedKeyId: null,
        revokedKeyController: keyProducer.agentDid,
        publisher: keyProducer.agentDid,
        trustClass: 'producer_signed',
      });
    });

    // ── The §5 step 2 not-self-signed defence ────────────────────────────
    it('rejects a did:web revocation signed by the very key it revokes (key_not_authorized)', () => {
      const bodyJson = buildRevocationBody();
      // The signer IS the revoked key (self-attestation of compromise).
      const out = parseKeyRevocation(bodyJson, revokedFp);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.code).toBe('key_not_authorized');
    });

    it('CRITICAL: the wrapper actually FORWARDS a non-empty signerFingerprint to the binding', () => {
      // This is the trap this wrapper exists to close: the raw binding's
      // `signerFingerprint` parameter is OPTIONAL, and the not-self-signed
      // check for a did:web signer runs ONLY when it is supplied
      // (bindings/acdp-node/src/v030.rs:588-590). A did:key fixture would
      // pass this assertion even if the wrapper silently dropped the
      // argument (the native check inside `KeyRevocation::from_body` would
      // still catch it) — so this test uses a did:web body specifically,
      // and proves the forwarding two ways:
      const bodyJson = buildRevocationBody();

      // 1. Calling the RAW SDK binding with signerFingerprint OMITTED does
      //    NOT reject a self-signed did:web revocation — proving the check
      //    is opt-in at the binding layer, exactly as documented.
      const rawWithoutFingerprint = AcdpVerifier.parseKeyRevocation(bodyJson);
      expect(() => JSON.parse(rawWithoutFingerprint)).not.toThrow();
      const parsedWithoutCheck = JSON.parse(rawWithoutFingerprint) as { trust_class: string };
      expect(parsedWithoutCheck.trust_class).toBe('producer_signed');

      // 2. This wrapper, given the SAME self-signed scenario, rejects it —
      //    which is only possible if it threaded `revokedFp` through as
      //    `signerFingerprint`.
      const wrapped = parseKeyRevocation(bodyJson, revokedFp);
      expect(wrapped.ok).toBe(false);
      if (!wrapped.ok) expect(wrapped.code).toBe('key_not_authorized');
    });

    it('accepts a did:key revocation whose native check runs regardless of the wrapper argument', () => {
      // A did:key signer's not-self-signed check runs NATIVELY inside
      // `KeyRevocation::from_body`, independent of `signer_fingerprint` —
      // covered here so the two code paths (native vs. resolved) are both
      // pinned, distinctly from the did:web forwarding test above.
      const keyProducer = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 9));
      const keyFp = fingerprintEd25519B64(keyProducer.publicKeyB64);
      const requestJson = keyProducer.buildPublishRequest({
        title: 'Key revocation — did:key self-signed',
        contextType: 'key-revocation',
        metadata: JSON.stringify({
          revoked_key_fingerprint: keyFp, // the signer revoking ITSELF
          compromised_since: COMPROMISED_SINCE,
        }),
      });
      const request = JSON.parse(requestJson) as Record<string, unknown>;
      const bodyJson = JSON.stringify({
        ...request,
        ctx_id: 'acdp://registry.example.com/00000000-0000-4000-8000-000000000000',
        lineage_id: 'lin:sha256:' + '7'.repeat(64),
        origin_registry: 'registry.example.com',
        created_at: '2026-05-02T08:00:00.000Z',
      });
      // Even a caller passing an unrelated, non-empty fingerprint cannot
      // paper over the native did:key check.
      const out = parseKeyRevocation(bodyJson, producerFp);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.code).toBe('key_not_authorized');
    });

    it('reports a real .code from the binding for non-JSON input, never a thrown exception', () => {
      // The wrapper's job is to turn every binding failure into an outcome
      // object, not to predict which exact code non-JSON input produces.
      const out = parseKeyRevocation('not json at all', producerFp);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(['schema_violation', 'invalid_input', 'unknown']).toContain(out.code);
        expect(out.reason.length).toBeGreaterThan(0);
      }
    });
  });
});

// ── Golden parity (fixtures required) ────────────────────────────────────
//
// Runs the RFC-ACDP-0014 §4/§5 golden vector (rev-001: a did:web producer
// revoking key-1, signed by its current key-2) through this repo's ACTUAL
// pipeline — content_hash recomputation, signature verification, and
// `parseKeyRevocation` — rather than a hand-typed fixture, proving the TS
// wrapper is byte-exact-compatible with the spec's own conformance runner.
// Graceful-skip pattern lifted verbatim from `src/audit/cosign.spec.ts:41-56`.

function conformanceDir(): string | null {
  const candidates = [
    process.env.ACDP_SPEC_DIR
      ? path.join(process.env.ACDP_SPEC_DIR, 'schemas', 'conformance')
      : null,
    path.resolve(__dirname, '../../../agentcontextdistributionprotocol/schemas/conformance'),
  ].filter((c): c is string => c !== null);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'rev-001-revocation-context-golden.json'))) return dir;
  }
  return null;
}

const CONFORMANCE_DIR = conformanceDir();
const load = (name: string): any =>
  JSON.parse(fs.readFileSync(path.join(CONFORMANCE_DIR!, name), 'utf8'));

// ACDP_REQUIRE_CONFORMANCE (set by CI's `unit` job, mirroring acdp-rs's
// ACDP_REQUIRE_CONFORMANCE): when set, a missing spec checkout is a hard
// failure instead of a graceful skip — a green run then genuinely proves
// the rev-* golden parity ran, rather than silently no-op'ing.
const REQUIRE_CONFORMANCE = typeof process.env.ACDP_REQUIRE_CONFORMANCE !== 'undefined';
const describeGolden = CONFORMANCE_DIR || REQUIRE_CONFORMANCE ? describe : describe.skip;
if (!CONFORMANCE_DIR && !REQUIRE_CONFORMANCE) {
  console.warn(
    '[revocation-verify.spec] ACDP_SPEC_DIR / sibling spec not found — SKIPPING rev-001 golden parity',
  );
}

function requireConformanceDir(): void {
  if (REQUIRE_CONFORMANCE && !CONFORMANCE_DIR) {
    throw new Error(
      'ACDP_REQUIRE_CONFORMANCE is set but no ACDP spec checkout was found at ' +
        'ACDP_SPEC_DIR or the sibling path — the rev-001 golden parity fixture is ' +
        'required in this mode.',
    );
  }
}

describeGolden('RFC-ACDP-0014 golden parity (rev-001)', () => {
  beforeAll(requireConformanceDir);

  it('rev-001: canonical form / content_hash / signed wire form are BYTE-EXACT to the golden', () => {
    const fixture = load('rev-001-revocation-context-golden.json');
    const vector = fixture.vectors[0];
    const expected = vector.expected;

    // 1. Canonical preimage byte-for-byte.
    const canonical = AcdpCanonicalizer.canonicalize(JSON.stringify(vector.producer_content));
    expect(canonical).toBe(expected.canonical_form);

    // 2. Re-derive with the actual producer construction this repo uses
    //    elsewhere (AcdpProducer.fromSeed — deterministic from the fixture's
    //    pinned test seed, the sig-003/rot-001 K2 seed), proving the SIGNED
    //    wire form matches too, not just the canonicalizer.
    const kp = fixture.test_keypair;
    const signer = AcdpProducer.fromSeed(
      Buffer.from(kp.private_seed_hex, 'hex'),
      vector.producer_content.agent_id,
      expected.publish_request_body.signature.key_id,
    );
    expect(signer.publicKeyB64).toBe(Buffer.from(kp.public_key_hex, 'hex').toString('base64'));

    const requestJson = signer.buildPublishRequest({
      title: vector.producer_content.title,
      contextType: vector.producer_content.type,
      summary: vector.producer_content.summary,
      metadata: JSON.stringify(vector.producer_content.metadata),
      // The fixture pins the ACDP protocol version at RFC-ACDP-0014's own
      // Final line (0.3.0); the installed SDK's default tracks its OWN
      // current pinned protocol (now 0.4.0, RFC-ACDP-0015) — override to
      // reproduce the golden's exact preimage rather than drift with it.
      acdpVersion: vector.producer_content.acdp_version,
    });
    const request = JSON.parse(requestJson) as { content_hash: string; signature: { value: string } };
    expect(request.content_hash).toBe(expected.content_hash);
    expect(request.signature.value).toBe(expected.signature_value_base64);
    expect(request).toEqual(expected.publish_request_body);
  });

  it('rev-001: the golden vector parses end-to-end through this pipeline (content_hash, signature, parseKeyRevocation)', () => {
    const fixture = load('rev-001-revocation-context-golden.json');
    const vector = fixture.vectors[0];
    const bodyJson = JSON.stringify({
      ...vector.expected.publish_request_body,
      ...vector.registry_assigned,
    });
    const bodyObj = JSON.parse(bodyJson) as {
      content_hash: string;
      signature: { algorithm: string; value: string };
    };

    // Independent content_hash recomputation via this repo's own verifier.
    expect(verifyContentHash(bodyJson, bodyObj.content_hash)).toEqual({ ok: true });

    // Signature verification, mirroring the did:web branch of
    // RevocationAuditService.verifyEventInner (the test keypair stands in
    // for the DID-resolved key, since this vector has no DID document to
    // resolve against).
    const publicKeyB64 = Buffer.from(fixture.test_keypair.public_key_hex, 'hex').toString('base64');
    expect(bodyObj.signature.algorithm).toBe('ed25519');
    expect(
      verifySignatureB64('ed25519', publicKeyB64, bodyObj.content_hash, bodyObj.signature.value),
    ).toBe(true);

    // §5 step 2 parity: the actual signer (K2) is NOT the revoked key (K1) —
    // the golden's own note 5.
    const signerFp = fixture.test_keypair.key_fingerprint as string;
    expect(signerFp).not.toBe(fixture.revoked_key.key_fingerprint);

    const out = parseKeyRevocation(bodyJson, signerFp);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.revocation).toEqual({
      revokedKeyFingerprint: fixture.revoked_key.key_fingerprint,
      compromisedSince: vector.producer_content.metadata.compromised_since,
      reason: vector.producer_content.metadata.reason,
      revokedKeyId: null,
      revokedKeyController: vector.producer_content.agent_id,
      publisher: vector.producer_content.agent_id,
      trustClass: 'producer_signed',
    });

    // §4 step 6: lineage_id MUST equal 'lin:sha256:' + hex(SHA-256(ctx_id)).
    const expectedLineage =
      'lin:sha256:' + createHash('sha256').update(vector.registry_assigned.ctx_id).digest('hex');
    expect(vector.registry_assigned.lineage_id).toBe(expectedLineage);
  });
});
