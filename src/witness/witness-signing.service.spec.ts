/**
 * WitnessSigningService — the RFC-ACDP-0015 §9 witness identity / key material.
 *
 * Covers: disabled = inert; startup validation (enabled requires a valid
 * Ed25519 key + a well-formed did:web/did:key + a key_id under the DID); and the
 * served identity docs, including that the DID document's assertionMethod key is
 * RESOLVABLE through the SDK's `AcdpDidDocument` (the exact path a consumer uses
 * to resolve signature.key_id when verifying a cosignature, §8 step 2).
 */
import { AcdpDidDocument } from 'acdp';
import { generateEd25519Pem } from '../auth/jwt-signing';
import { WitnessConfigError, WitnessSigningService } from './witness-signing.service';

const WITNESS_ID = 'did:web:witness.example.org';

function makeConfig(over: Partial<Record<string, unknown>> = {}): any {
  return {
    witnessCosigningEnabled: true,
    witnessId: WITNESS_ID,
    witnessSigningPrivateKeyPem: generateEd25519Pem().privatePem,
    witnessKeyId: '',
    ...over,
  };
}

describe('WitnessSigningService', () => {
  it('is inert when cosigning is disabled', () => {
    const svc = new WitnessSigningService(makeConfig({ witnessCosigningEnabled: false }) as never);
    expect(svc.enabled).toBe(false);
    expect(svc.signer).toBeNull();
    expect(() => svc.didDocument()).toThrow(WitnessConfigError);
    expect(() => svc.capabilities([])).toThrow(WitnessConfigError);
  });

  it('builds a signer + identity from a valid Ed25519 PEM', () => {
    const svc = new WitnessSigningService(makeConfig() as never);
    expect(svc.enabled).toBe(true);
    expect(svc.witnessId).toBe(WITNESS_ID);
    expect(svc.keyId).toBe(`${WITNESS_ID}#witness-key-1`);
    expect(Buffer.from(svc.publicKeyB64, 'base64')).toHaveLength(32);
    expect(svc.publicKeyMultibase.startsWith('z')).toBe(true);
    expect(svc.signer?.witnessId).toBe(WITNESS_ID);
  });

  it('honors a custom WITNESS_KEY_ID under the witness DID', () => {
    const svc = new WitnessSigningService(
      makeConfig({ witnessKeyId: `${WITNESS_ID}#cosign-2026` }) as never,
    );
    expect(svc.keyId).toBe(`${WITNESS_ID}#cosign-2026`);
  });

  it('the served DID document assertionMethod key is resolvable via the SDK', () => {
    const svc = new WitnessSigningService(makeConfig() as never);
    const doc = svc.didDocument();
    expect(doc.assertionMethod).toEqual([svc.keyId]);

    // Resolve exactly as a consumer would when verifying a cosignature (§8).
    const parsed = AcdpDidDocument.parse(JSON.stringify(doc), WITNESS_ID);
    const key = parsed.keyForAlgorithm(svc.keyId, 'ed25519');
    expect(key.publicKeyB64).toBe(svc.publicKeyB64);
  });

  it('serves an acdp-log-witness capabilities document', () => {
    const svc = new WitnessSigningService(makeConfig() as never);
    const caps = svc.capabilities(['did:web:registry.example.com/log/1']);
    expect(caps).toEqual({
      witness_id: WITNESS_ID,
      profiles: ['acdp-log-witness'],
      covered_logs: ['did:web:registry.example.com/log/1'],
      cosignature_endpoint: '/log/witness',
    });
  });

  // ── Startup validation ─────────────────────────────────────────────────

  it('throws when enabled without a key', () => {
    expect(
      () => new WitnessSigningService(makeConfig({ witnessSigningPrivateKeyPem: '' }) as never),
    ).toThrow(/WITNESS_SIGNING_PRIVATE_KEY_PEM/);
  });

  it('throws on a non-Ed25519 key', () => {
    // A valid PEM but wrong curve — an RSA/EC key must be rejected.
    const { generateKeyPairSync } = require('node:crypto');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(
      () => new WitnessSigningService(makeConfig({ witnessSigningPrivateKeyPem: pem }) as never),
    ).toThrow(/must be an Ed25519 key/);
  });

  it('throws on a malformed witness DID', () => {
    expect(
      () => new WitnessSigningService(makeConfig({ witnessId: 'not-a-did' }) as never),
    ).toThrow(/WITNESS_ID must be a did:web or did:key/);
  });

  it('throws when key_id is not under the witness DID', () => {
    expect(
      () =>
        new WitnessSigningService(
          makeConfig({ witnessKeyId: 'did:web:other.example.org#k1' }) as never,
        ),
    ).toThrow(/must be a DID URL under WITNESS_ID/);
  });

  // ── did:web WITNESS_ID ↔ PUBLIC_HOST binding (RFC-ACDP-0015 §9) ─────────

  it('throws when the did:web witness host does not match PUBLIC_HOST', () => {
    expect(
      () =>
        new WitnessSigningService(
          makeConfig({
            witnessId: 'did:web:witness.example.org',
            publicHost: 'some-other-host.example.com',
          }) as never,
        ),
    ).toThrow(/does not match this control plane's PUBLIC_HOST/);
  });

  it('accepts a did:web witness whose host matches PUBLIC_HOST', () => {
    const svc = new WitnessSigningService(
      makeConfig({
        witnessId: 'did:web:witness.example.org',
        publicHost: 'https://Witness.Example.ORG/', // scheme/case/slash are normalized away
      }) as never,
    );
    expect(svc.enabled).toBe(true);
    expect(svc.witnessId).toBe('did:web:witness.example.org');
  });

  it('accepts a did:web witness with a %3A-encoded port matching PUBLIC_HOST', () => {
    const svc = new WitnessSigningService(
      makeConfig({
        witnessId: 'did:web:witness.example.org%3A8443',
        witnessKeyId: '',
        publicHost: 'witness.example.org:8443',
      }) as never,
    );
    expect(svc.enabled).toBe(true);
  });

  it('warns but does not throw when PUBLIC_HOST is unset (cannot verify the binding)', () => {
    const svc = new WitnessSigningService(
      makeConfig({ witnessId: 'did:web:witness.example.org', publicHost: '' }) as never,
    );
    expect(svc.enabled).toBe(true);
  });

  it('exempts a did:key witness from the host binding (self-describing)', () => {
    const svc = new WitnessSigningService(
      makeConfig({
        witnessId: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        witnessKeyId: '',
        publicHost: 'anything.example.com', // ignored for did:key
      }) as never,
    );
    expect(svc.enabled).toBe(true);
    expect(svc.witnessId).toBe('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK');
  });
});
