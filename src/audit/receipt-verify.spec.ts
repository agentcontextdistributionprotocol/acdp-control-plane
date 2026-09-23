import { AcdpCanonicalizer, AcdpProducer, AcdpVerifier } from '@agentcontextdistributionprotocol/acdp';
import {
  classifyReceiptFailure,
  explainHashMismatch,
  fingerprintEd25519B64,
  isCanonicalCtxId,
  ReceiptSurface,
  sdkSupportsReceipts,
  verifyBodyOffline,
  verifyContentHash,
  verifyReceipt,
} from './receipt-verify';

// ── Type-level pin: the shim is DERIVED from the binding, not hand-copied ──
//
// `ReceiptSurface` is `Pick<typeof AcdpVerifier, …>`, so its `verifyReceipt`
// IS the installed binding's declaration. Two compile-time assertions hold
// that, and both are enforced by `npm test` as well as `tsc --noEmit`, because
// ts-jest type-checks and `tsconfig.json`'s `include` covers `src/**/*`:
//
//  1. an exact function-type equality against the binding's own static — a
//     hand-written interface that drifts from the SDK (the `as unknown as`
//     pattern this file used to carry) fails here the moment the SDK moves; and
//  2. a `@ts-expect-error` on a deliberately wrong-arity call. If the shim ever
//     reverts to `as unknown as` (or degrades to `any`), that call stops being
//     an error, the directive becomes unused (TS2578), and the build fails.
//
// (2) is also what caught the `acdp` 0.8.5 → 0.14.1 break: `verifyReceipt`
// gained `bodyJson` as its SECOND positional parameter, so the five-argument
// form below is now one short rather than complete.
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type _ReceiptSurfaceIsBindingDerived = Expect<
  Equal<ReceiptSurface['verifyReceipt'], typeof AcdpVerifier.verifyReceipt>
>;

declare const _receiptSurface: ReceiptSurface;
// Never called — it exists only so the compiler evaluates the call below.
function _wrongArityMustNotTypecheck(): void {
  // @ts-expect-error — one argument short of the binding's verifyReceipt.
  _receiptSurface.verifyReceipt('{}', '{}', 'a2V5', 'acdp://r/c', `sha256:${'a'.repeat(64)}`);
}

// A canonical ctx_id under the SDK's `CtxId::parse`: `acdp://` + lowercase
// DNS authority + lowercase v4 UUID. Everything that talks to `verifyReceipt`
// must use this shape now, because a non-canonical one throws before any
// receipt check runs.
const CTX_UUID = 'abcdef01-2345-4678-9abc-def012345678';
const CTX_ID = `acdp://reg.example/${CTX_UUID}`;

describe('receipt-verify (SDK feature detection)', () => {
  // acdp ≤ 0.3.0 predates the receipt API; these tests pin the degraded
  // behavior and self-skip on a receipt-capable binding (the pinned floor is
  // ^0.14.1). Kept so a mis-resolved native optionalDependency — or a
  // downgrade — fails loudly here rather than silently weakening the audit.
  const preReceiptSdk = !sdkSupportsReceipts();
  const describePre = preReceiptSdk ? describe : describe.skip;
  const describeReceipts = preReceiptSdk ? describe.skip : describe;

  describePre('with a pre-receipt SDK installed', () => {
    it('verifyReceipt refuses loudly rather than pretending to verify', () => {
      expect(() =>
        verifyReceipt('{}', '{}', 'a2V5', CTX_ID, 'sha256:' + 'a'.repeat(64), 'sha256:x'),
      ).toThrow(/no verifyReceipt/);
    });

    it('fingerprintEd25519B64 refuses loudly', () => {
      expect(() => fingerprintEd25519B64('a2V5')).toThrow(/no fingerprintEd25519B64/);
    });

    it('verifyBodyOffline degrades to a non-throwing "not verified"', () => {
      const out = verifyBodyOffline('{}');
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toMatch(/no verifyBodyOffline/);
    });
  });

  it('verifyContentHash (available since 0.1.0) maps SDK throws to {ok:false}', () => {
    const out = verifyContentHash('{"not":"a body"}', 'sha256:' + 'a'.repeat(64));
    expect(out.ok).toBe(false);
  });

  it('explainHashMismatch returns a non-empty diagnosis on a real mismatch, never throws', () => {
    // Best-effort diagnostic: a string when the SDK has the helper, null when
    // not — either way it must not throw into the audit path.
    const out = explainHashMismatch('{"a":1}', 'sha256:' + 'a'.repeat(64));
    expect(out === null || typeof out === 'string').toBe(true);
    if (out !== null) expect(out.length).toBeGreaterThan(0);
  });

  // ── The failure taxonomy, as literal strings ───────────────────────────
  //
  // `verify_receipt` writes no RFC-ACDP-0007 `.code` (every path is
  // `Error::from_reason`, bindings/acdp-node/src/verifier.rs:344-365), so the
  // classifier prefix-matches the binding's own message. These cases pin the
  // literals; the `describeReceipts` block below pins that the REAL binding
  // still writes them.
  describe('classifyReceiptFailure', () => {
    it('maps the "invalid body JSON: " prefix to malformed_body (verifier.rs:346-347)', () => {
      expect(classifyReceiptFailure('invalid body JSON: missing field `contributors`')).toBe(
        'malformed_body',
      );
    });

    it('maps the "invalid expectedCtxId: " prefix to ctx_id_rejected (verifier.rs:356-357)', () => {
      expect(
        classifyReceiptFailure("invalid expectedCtxId: schema violation: ctx_id uuid 'c1' …"),
      ).toBe('ctx_id_rejected');
    });

    it('treats the §8 step 3 body bindings as registry dishonesty', () => {
      expect(
        classifyReceiptFailure("invalid registry receipt: receipt lineage_id 'a' ≠ body 'b'"),
      ).toBe('receipt_dishonest');
    });

    it('falls through to receipt_dishonest for an UNRECOGNISED failure, never to a note', () => {
      // Deliberately conservative: an unknown failure from the receipt
      // verifier is not quietly downgraded to "environmental".
      expect(classifyReceiptFailure('something the SDK has never said before')).toBe(
        'receipt_dishonest',
      );
      expect(classifyReceiptFailure('invalid receipt JSON: expected ident')).toBe(
        'receipt_dishonest',
      );
      expect(classifyReceiptFailure('invalid recomputedBodyHash: bad envelope')).toBe(
        'receipt_dishonest',
      );
    });

    it('does not match a prefix that merely appears mid-message', () => {
      expect(classifyReceiptFailure('GenericFailure: invalid body JSON: nope')).toBe(
        'receipt_dishonest',
      );
    });
  });

  // ── The host mirror of CtxId::parse ────────────────────────────────────
  describe('isCanonicalCtxId', () => {
    it('accepts acdp:// + lowercase DNS authority + lowercase v4 UUID', () => {
      expect(isCanonicalCtxId(CTX_ID)).toBe(true);
      expect(isCanonicalCtxId(`acdp://localhost/${CTX_UUID}`)).toBe(true);
      expect(isCanonicalCtxId(`acdp://a.b.c-d.example/${CTX_UUID}`)).toBe(true);
      expect(isCanonicalCtxId(`acdp://127.0.0.1/${CTX_UUID}`)).toBe(true);
    });

    it('rejects a PORT-bearing authority — no conformant registry can mint one', () => {
      expect(isCanonicalCtxId(`acdp://localhost:8443/${CTX_UUID}`)).toBe(false);
    });

    it('rejects uppercase, malformed authorities and non-v4 UUIDs', () => {
      expect(isCanonicalCtxId(`acdp://Reg.Example/${CTX_UUID}`)).toBe(false);
      expect(isCanonicalCtxId(`acdp://reg.example/${CTX_UUID.toUpperCase()}`)).toBe(false);
      expect(isCanonicalCtxId(`acdp://-reg.example/${CTX_UUID}`)).toBe(false);
      expect(isCanonicalCtxId(`acdp://reg-.example/${CTX_UUID}`)).toBe(false);
      expect(isCanonicalCtxId(`acdp://reg..example/${CTX_UUID}`)).toBe(false);
      expect(isCanonicalCtxId(`acdp://reg.example./${CTX_UUID}`)).toBe(false);
      expect(isCanonicalCtxId(`acdp://reg_example/${CTX_UUID}`)).toBe(false);
      expect(isCanonicalCtxId(`acdp:///${CTX_UUID}`)).toBe(false);
      // v1 UUID (version nibble 1) and a bad variant nibble.
      expect(isCanonicalCtxId('acdp://reg.example/abcdef01-2345-1678-9abc-def012345678')).toBe(
        false,
      );
      expect(isCanonicalCtxId('acdp://reg.example/abcdef01-2345-4678-cabc-def012345678')).toBe(
        false,
      );
    });

    it('rejects the legacy opaque-id form the CP used to store', () => {
      expect(isCanonicalCtxId('acdp://reg.example/c1')).toBe(false);
      expect(isCanonicalCtxId('acdp://reg.example/ctx-001')).toBe(false);
      expect(isCanonicalCtxId(`reg.example/${CTX_UUID}`)).toBe(false);
      expect(isCanonicalCtxId(`acdp://reg.example/${CTX_UUID}/extra`)).toBe(false);
    });
  });

  // ── Golden path with the real SDK (acdp ^0.14.1) ────────────────────────
  //
  // Mints a genuine RFC-ACDP-0010 receipt in-test: the receipt preimage is
  // SHA-256 over the JCS form of the receipt minus `signature`, signed over
  // the ASCII `"sha256:<hex>"` string — exactly the producer construction,
  // so the registry key's `signChallenge` (which signs an arbitrary signing
  // input) mints byte-identical signatures to a real registry.
  //
  // Since 0.14.0 `verifyReceipt` ALSO takes the served body and strictly
  // deserializes it, so the fixture is a full retrieval `Body` (the
  // registry-assigned fields included), not a bare PublishRequest.
  describeReceipts('with the receipt-capable SDK installed', () => {
    const LINEAGE_ID = 'lin:sha256:' + 'c'.repeat(64);
    const CREATED_AT = '2026-06-12T00:00:00.000Z';

    // did:key producer — its key is what the receipt's `key_fingerprint`
    // must name.
    const producer = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 7));
    const producerFp = fingerprintEd25519B64(producer.publicKeyB64);

    // The retrieved `body` member of a `FullContext`. `content_hash` is
    // computed from the SDK's own §5.7 canonical preimage, so the fixture is
    // self-consistent by construction rather than by a pasted digest.
    function makeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      const base: Record<string, unknown> = {
        ctx_id: CTX_ID,
        lineage_id: LINEAGE_ID,
        origin_registry: 'reg.example',
        created_at: CREATED_AT,
        version: 1,
        agent_id: producer.agentDid,
        contributors: [],
        title: 'golden receipt fixture',
        type: 'analysis',
        data_refs: [],
        derived_from: [],
        visibility: 'public',
        signature: { algorithm: 'ed25519', key_id: producer.keyId, value: 'AAA' },
        ...overrides,
      };
      const hash = AcdpCanonicalizer.contentHash(
        AcdpVerifier.canonicalPreimage(JSON.stringify(base)),
      );
      return { ...base, content_hash: hash };
    }

    const body = makeBody();
    const bodyJson = JSON.stringify(body);
    const bodyHash = body.content_hash as string;

    // Registry receipt-signing identity.
    const registryKey = AcdpProducer.generate(
      'did:web:reg.example',
      'did:web:reg.example#receipt-key-1',
    );

    function mintReceipt(
      overrides: Partial<Record<string, unknown>> = {},
    ): Record<string, unknown> {
      const unsigned: Record<string, unknown> = {
        registry_did: 'did:web:reg.example',
        ctx_id: CTX_ID,
        lineage_id: LINEAGE_ID,
        origin_registry: 'reg.example',
        created_at: CREATED_AT,
        content_hash: bodyHash,
        key_fingerprint: producerFp,
        ...overrides,
      };
      const preimageHash = AcdpCanonicalizer.contentHash(JSON.stringify(unsigned));
      return {
        ...unsigned,
        signature: {
          algorithm: 'ed25519',
          key_id: 'did:web:reg.example#receipt-key-1',
          value: registryKey.signChallenge(preimageHash),
        },
      };
    }

    it('verifies a genuinely minted receipt end-to-end', () => {
      expect(verifyContentHash(bodyJson, bodyHash)).toEqual({ ok: true });
      const out = verifyReceipt(
        JSON.stringify(mintReceipt()),
        bodyJson,
        registryKey.publicKeyB64,
        CTX_ID,
        bodyHash,
        producerFp,
      );
      expect(out).toEqual({ ok: true });
    });

    it('forwards bodyJson in argument slot 2, not the receipt', () => {
      // Positional pin. The SDK's §8 step 3 check names the BODY's
      // lineage_id in its message, so a distinctive body value proves which
      // argument the binding parsed as the body. Passing the receipt there
      // instead fails the strict `Body` deserialization outright.
      const otherLineage = 'lin:sha256:' + 'd'.repeat(64);
      const mismatched = verifyReceipt(
        JSON.stringify(mintReceipt()),
        JSON.stringify(makeBody({ lineage_id: otherLineage })),
        registryKey.publicKeyB64,
        CTX_ID,
        bodyHash,
        producerFp,
      );
      expect(mismatched.ok).toBe(false);
      if (!mismatched.ok) expect(mismatched.reason).toContain(otherLineage);

      const swapped = verifyReceipt(
        JSON.stringify(mintReceipt()),
        JSON.stringify(mintReceipt()), // a receipt is not a Body
        registryKey.publicKeyB64,
        CTX_ID,
        bodyHash,
        producerFp,
      );
      expect(swapped.ok).toBe(false);
      if (!swapped.ok) expect(swapped.kind).toBe('malformed_body');
    });

    it('rejects a tampered created_at (signature breaks)', () => {
      const receipt = mintReceipt();
      receipt.created_at = '2026-06-11T00:00:00.000Z'; // backdated after signing
      const out = verifyReceipt(
        JSON.stringify(receipt),
        bodyJson,
        registryKey.publicKeyB64,
        CTX_ID,
        bodyHash,
        producerFp,
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.kind).toBe('receipt_dishonest');
    });

    it('rejects a fingerprint that does not match the resolved producer key', () => {
      const otherFp = fingerprintEd25519B64(registryKey.publicKeyB64);
      const out = verifyReceipt(
        JSON.stringify(mintReceipt()),
        bodyJson,
        registryKey.publicKeyB64,
        CTX_ID,
        bodyHash,
        otherFp,
      );
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).toContain('key_fingerprint');
        expect(out.kind).toBe('receipt_dishonest');
      }
    });

    it('rejects a receipt signed by the wrong registry key', () => {
      const rogue = AcdpProducer.generate(
        'did:web:reg.example',
        'did:web:reg.example#receipt-key-1',
      );
      const receipt = mintReceipt();
      const preimage = { ...receipt } as Record<string, unknown>;
      delete preimage.signature;
      receipt.signature = {
        algorithm: 'ed25519',
        key_id: 'did:web:reg.example#receipt-key-1',
        value: rogue.signChallenge(AcdpCanonicalizer.contentHash(JSON.stringify(preimage))),
      };
      const out = verifyReceipt(
        JSON.stringify(receipt),
        bodyJson,
        registryKey.publicKeyB64,
        CTX_ID,
        bodyHash,
        producerFp,
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.kind).toBe('receipt_dishonest');
    });

    // ── The §8 step 3 body bindings (new in the 0.14.x verifier) ──────────
    //
    // A registry that serves a body disagreeing with the receipt it signed
    // is a NEW detectable failure mode, and it IS dishonesty: the receipt is
    // internally valid and correctly signed, yet contradicts what the
    // registry actually serves.
    it.each([
      ['lineage_id', { lineage_id: 'lin:sha256:' + 'e'.repeat(64) }],
      ['origin_registry', { origin_registry: 'other.example' }],
      ['created_at', { created_at: '2026-06-13T00:00:00.000Z' }],
    ])('flags a receipt whose %s disagrees with the served body', (_field, overrides) => {
      const out = verifyReceipt(
        JSON.stringify(mintReceipt(overrides)),
        bodyJson,
        registryKey.publicKeyB64,
        CTX_ID,
        bodyHash,
        producerFp,
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.kind).toBe('receipt_dishonest');
    });

    // ── The two tightenings that must NOT read as dishonesty ─────────────
    it('classifies a body the strict Body deserialization rejects as malformed_body', () => {
      // Pins the coupling to the binding's literal `"invalid body JSON: "`
      // prefix against the REAL binding, so a future SDK that rewords it
      // fails here instead of silently reclassifying the failure mode.
      const { contributors: _dropped, ...incomplete } = makeBody();
      const out = verifyReceipt(
        JSON.stringify(mintReceipt()),
        JSON.stringify(incomplete),
        registryKey.publicKeyB64,
        CTX_ID,
        bodyHash,
        producerFp,
      );
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).toContain('invalid body JSON: ');
        expect(out.kind).toBe('malformed_body');
      }
    });

    it('classifies a non-canonical expectedCtxId as ctx_id_rejected', () => {
      // Also pins that `isCanonicalCtxId` agrees with `CtxId::parse` on the
      // cases the host pre-check is there to catch.
      for (const bad of [
        `acdp://localhost:8443/${CTX_UUID}`,
        'acdp://reg.example/c1',
        `acdp://Reg.Example/${CTX_UUID}`,
      ]) {
        expect(isCanonicalCtxId(bad)).toBe(false);
        const out = verifyReceipt(
          JSON.stringify(mintReceipt()),
          bodyJson,
          registryKey.publicKeyB64,
          bad,
          bodyHash,
          producerFp,
        );
        expect(out.ok).toBe(false);
        if (!out.ok) {
          expect(out.reason).toContain('invalid expectedCtxId: ');
          expect(out.kind).toBe('ctx_id_rejected');
        }
      }
    });

    it('leaves the 63-character DNS-label bound to the SDK (documented, safe gap)', () => {
      // `isCanonicalCtxId` deliberately does NOT mirror `CtxId::parse`'s
      // per-label length limit — hand-transcribing RFC 1035 risks a subtler
      // mismatch than it prevents. This pins the boundary and the bounded
      // consequence: 63 parses on both sides; 64 passes the host pre-check
      // and is refused by the SDK, landing on `ctx_id_rejected` (→
      // `unverified:` note → `error` verdict), never a dishonesty flag.
      const ctxIdWithLabel = (n: number) => `acdp://${'a'.repeat(n)}.example/${CTX_UUID}`;
      const check = (ctxId: string) =>
        verifyReceipt(
          JSON.stringify(mintReceipt()),
          bodyJson,
          registryKey.publicKeyB64,
          ctxId,
          bodyHash,
          producerFp,
        );

      expect(isCanonicalCtxId(ctxIdWithLabel(63))).toBe(true);
      const at63 = check(ctxIdWithLabel(63));
      // Mismatches the receipt's own ctx_id, so it fails — but on the
      // cross-check, proving `CtxId::parse` accepted the 63-char label.
      expect(at63.ok).toBe(false);
      if (!at63.ok) expect(at63.kind).not.toBe('ctx_id_rejected');

      expect(isCanonicalCtxId(ctxIdWithLabel(64))).toBe(true); // the host gap
      const at64 = check(ctxIdWithLabel(64));
      expect(at64.ok).toBe(false);
      if (!at64.ok) {
        expect(at64.reason).toContain('invalid expectedCtxId: ');
        expect(at64.kind).toBe('ctx_id_rejected');
      }
    });

    it('accepts every ctx_id isCanonicalCtxId accepts (no host/SDK divergence)', () => {
      // The inverse direction: a ctx_id the host pre-check lets through must
      // never come back as `ctx_id_rejected`, or the pre-check is wrong and
      // events would be sent to the SDK only to fail there. (The one
      // documented exception is the label-length gap pinned above.)
      for (const good of [
        CTX_ID,
        `acdp://localhost/${CTX_UUID}`,
        `acdp://a.b.c-d.example/${CTX_UUID}`,
        `acdp://127.0.0.1/${CTX_UUID}`,
      ]) {
        expect(isCanonicalCtxId(good)).toBe(true);
        const out = verifyReceipt(
          JSON.stringify(mintReceipt()),
          bodyJson,
          registryKey.publicKeyB64,
          good,
          bodyHash,
          producerFp,
        );
        // Most of these mismatch the receipt's own ctx_id, which is fine —
        // what matters is that the ctx_id PARSE never rejected them.
        if (!out.ok) expect(out.kind).not.toBe('ctx_id_rejected');
      }
    });

    it('verifyBodyOffline verifies the did:key publish request body', () => {
      const publishRequestJson = producer.buildPublishRequest({
        title: 'golden receipt fixture',
        contextType: 'analysis',
      });
      expect(AcdpVerifier.verifyPublishRequestOffline(publishRequestJson)).toBe(true);
      expect(verifyBodyOffline(publishRequestJson).ok).toBe(false); // Body needs registry fields
    });
  });
});
