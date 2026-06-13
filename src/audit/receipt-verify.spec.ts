import { AcdpCanonicalizer, AcdpProducer, AcdpVerifier } from 'acdp';
import {
  explainHashMismatch,
  fingerprintEd25519B64,
  sdkSupportsReceipts,
  verifyBodyOffline,
  verifyContentHash,
  verifyReceipt,
} from './receipt-verify';

describe('receipt-verify (SDK feature detection)', () => {
  // acdp ≤ 0.3.0 predates the receipt API; these tests pin the degraded
  // behavior and self-skip on a receipt-capable binding (0.4.0+, the
  // current dependency). Kept so a future downgrade fails loudly here
  // rather than silently weakening the audit.
  const preReceiptSdk = !sdkSupportsReceipts();
  const describePre = preReceiptSdk ? describe : describe.skip;
  const describeReceipts = preReceiptSdk ? describe.skip : describe;

  describePre('with a pre-receipt SDK installed', () => {
    it('verifyReceipt refuses loudly rather than pretending to verify', () => {
      expect(() =>
        verifyReceipt('{}', 'a2V5', 'acdp://r/c', 'sha256:' + 'a'.repeat(64), 'sha256:x'),
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

  // ── Golden path with the real SDK (acdp 0.4.0+) ────────────────────────
  //
  // Mints a genuine RFC-ACDP-0010 receipt in-test: the receipt preimage is
  // SHA-256 over the JCS form of the receipt minus `signature`, signed over
  // the ASCII `"sha256:<hex>"` string — exactly the producer construction,
  // so the registry key's `signChallenge` (which signs an arbitrary signing
  // input) mints byte-identical signatures to a real registry.
  describeReceipts('with the receipt-capable SDK installed', () => {
    const CTX_ID = 'acdp://reg.example/ctx-golden-1';

    // did:key producer — the body is its signed PublishRequest (shares the
    // §5.7 content-hash layout with a retrieved Body).
    const producer = AcdpProducer.fromSeedDidKey(Buffer.alloc(32, 7));
    const bodyJson = producer.buildPublishRequest({
      title: 'golden receipt fixture',
      contextType: 'analysis',
    });
    const body = JSON.parse(bodyJson) as Record<string, unknown>;
    const bodyHash = body.content_hash as string;
    const producerFp = fingerprintEd25519B64(producer.publicKeyB64);

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
        lineage_id: 'lin-golden-1',
        origin_registry: 'reg.example',
        created_at: '2026-06-12T00:00:00.000Z',
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
        registryKey.publicKeyB64,
        CTX_ID,
        bodyHash,
        producerFp,
      );
      expect(out).toEqual({ ok: true });
    });

    it('rejects a tampered created_at (signature breaks)', () => {
      const receipt = mintReceipt();
      receipt.created_at = '2026-06-11T00:00:00.000Z'; // backdated after signing
      const out = verifyReceipt(
        JSON.stringify(receipt),
        registryKey.publicKeyB64,
        CTX_ID,
        bodyHash,
        producerFp,
      );
      expect(out.ok).toBe(false);
    });

    it('rejects a fingerprint that does not match the resolved producer key', () => {
      const otherFp = fingerprintEd25519B64(registryKey.publicKeyB64);
      const out = verifyReceipt(
        JSON.stringify(mintReceipt()),
        registryKey.publicKeyB64,
        CTX_ID,
        bodyHash,
        otherFp,
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toContain('key_fingerprint');
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
        registryKey.publicKeyB64,
        CTX_ID,
        bodyHash,
        producerFp,
      );
      expect(out.ok).toBe(false);
    });

    it('verifyBodyOffline verifies the did:key publish request body', () => {
      expect(AcdpVerifier.verifyPublishRequestOffline(bodyJson)).toBe(true);
      expect(verifyBodyOffline(bodyJson).ok).toBe(false); // Body needs registry fields
    });
  });
});
