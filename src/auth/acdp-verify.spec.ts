/**
 * Tests for the `acdp` SDK verification boundary. Replaces the old
 * hand-rolled ed25519.spec.ts / ecdsa-p256.spec.ts: signature
 * verification now lives in `acdp-rs` (via `AcdpVerifier`), so these
 * tests pin our thin wrapper — the throw→boolean mapping and the
 * load-time key validation — against real signatures produced by the
 * binding's own producers.
 */
import { AcdpProducer, AcdpP256Producer } from 'acdp';
import { assertValidPublicKey, verifySignatureB64 } from './acdp-verify';

const DID = 'did:web:agents.example.com';
const KEY_ID = `${DID}#key-1`;
const MESSAGE = 'acdp-registry-auth:v1:nonce123:did:web:alice:authority:1800000000';

describe('verifySignatureB64 (ed25519)', () => {
  const producer = AcdpProducer.generate(DID, KEY_ID);
  const sig = producer.signChallenge(MESSAGE);

  it('accepts a valid signature', () => {
    expect(verifySignatureB64('ed25519', producer.publicKeyB64, MESSAGE, sig)).toBe(true);
  });

  it('rejects a tampered message', () => {
    expect(verifySignatureB64('ed25519', producer.publicKeyB64, 'TAMPERED', sig)).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const other = AcdpProducer.generate(DID, KEY_ID);
    expect(verifySignatureB64('ed25519', other.publicKeyB64, MESSAGE, sig)).toBe(false);
  });

  it('returns false (never throws) on malformed base64 / wrong length', () => {
    expect(verifySignatureB64('ed25519', producer.publicKeyB64, MESSAGE, '!!!not-base64!!!')).toBe(false);
    expect(verifySignatureB64('ed25519', 'AAAA', MESSAGE, sig)).toBe(false);
  });
});

describe('verifySignatureB64 (ecdsa-p256)', () => {
  const producer = AcdpP256Producer.generate(DID, KEY_ID);
  const sig = producer.signChallenge(MESSAGE);

  it('accepts a valid IEEE-1363 signature', () => {
    expect(verifySignatureB64('ecdsa-p256', producer.publicKeySec1B64, MESSAGE, sig)).toBe(true);
  });

  it('rejects a tampered message', () => {
    expect(verifySignatureB64('ecdsa-p256', producer.publicKeySec1B64, 'TAMPERED', sig)).toBe(false);
  });

  it('rejects an algorithm/key mismatch', () => {
    const ed = AcdpProducer.generate(DID, KEY_ID);
    // An ed25519 key bytes fed to the p256 path must not verify.
    expect(verifySignatureB64('ecdsa-p256', ed.publicKeyB64, MESSAGE, sig)).toBe(false);
  });
});

describe('assertValidPublicKey', () => {
  it('accepts a 32-byte ed25519 key', () => {
    const p = AcdpProducer.generate(DID, KEY_ID);
    expect(() => assertValidPublicKey('ed25519', p.publicKeyB64)).not.toThrow();
  });

  it('rejects a wrong-length ed25519 key', () => {
    expect(() => assertValidPublicKey('ed25519', Buffer.alloc(16).toString('base64'))).toThrow(
      /32 bytes/,
    );
  });

  it('accepts a 65-byte SEC1 p256 key', () => {
    const p = AcdpP256Producer.generate(DID, KEY_ID);
    expect(() => assertValidPublicKey('ecdsa-p256', p.publicKeySec1B64)).not.toThrow();
  });

  it('rejects a p256 key with a wrong length or tag', () => {
    expect(() => assertValidPublicKey('ecdsa-p256', Buffer.alloc(64).toString('base64'))).toThrow(
      /65 bytes/,
    );
    const badTag = Buffer.alloc(65);
    badTag[0] = 0x02;
    expect(() => assertValidPublicKey('ecdsa-p256', badTag.toString('base64'))).toThrow(/0x04/);
  });
});
