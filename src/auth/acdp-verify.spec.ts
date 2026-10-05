/**
 * Tests for the `acdp` SDK verification boundary. Replaces the old
 * hand-rolled ed25519.spec.ts / ecdsa-p256.spec.ts: signature
 * verification now lives in `acdp-rs` (via `AcdpVerifier`), so these
 * tests pin our thin wrapper — the throw→boolean mapping and the
 * load-time key validation — against real signatures produced by the
 * binding's own producers.
 */
import { AcdpProducer, AcdpP256Producer } from '@agentcontextdistributionprotocol/acdp';
import { AcdpVerifier } from '@agentcontextdistributionprotocol/acdp';
import {
  assertStrictEd25519,
  assertValidPublicKey,
  SIG_004_PUBLIC_KEY_B64,
  SIG_004_SIGNATURE_B64,
  SIG_004_SIGNATURE_INPUT,
  verifySignatureB64,
} from './acdp-verify';

// AcdpVerifier's statics are non-configurable on the native class (a Proxy over it
// can't override them), so stand in a plain-object Proxy that can be flipped to "accept everything" (a non-strict binding).
let mockNonStrict = false;
jest.mock('@agentcontextdistributionprotocol/acdp', () => {
  const actual = jest.requireActual('@agentcontextdistributionprotocol/acdp');
  return {
    ...actual,
    AcdpVerifier: new Proxy({}, {
      get: (_target, prop) =>
        prop === 'verifySignature' && mockNonStrict
          ? () => true
          : actual.AcdpVerifier[prop],
    }),
  };
});

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

describe('assertStrictEd25519 (RFC-ACDP-0001 §5.10 boot self-test)', () => {
  afterEach(() => {
    mockNonStrict = false;
  });

  it('embeds a well-formed sig-004 vector (32-byte key, 64-byte signature)', () => {
    // A malformed constant would be rejected by EVERY verifier, strict or not,
    // making the boot gate vacuous — pin the lengths and that the binding
    // rejects it for strictness (a verification failure, not a parse error).
    expect(Buffer.from(SIG_004_PUBLIC_KEY_B64, 'base64')).toHaveLength(32);
    expect(Buffer.from(SIG_004_SIGNATURE_B64, 'base64')).toHaveLength(64);
    expect(Buffer.from(SIG_004_PUBLIC_KEY_B64, 'base64').toString('hex')).toBe(
      '01' + '00'.repeat(31),
    );
    expect(Buffer.from(SIG_004_SIGNATURE_B64, 'base64').toString('hex')).toBe(
      '01' + '00'.repeat(63),
    );
    expect(() =>
      AcdpVerifier.verifySignature(
        SIG_004_PUBLIC_KEY_B64,
        SIG_004_SIGNATURE_B64,
        SIG_004_SIGNATURE_INPUT,
      ),
    ).toThrow(/verification failed/i);
  });

  it('returns normally with the installed (strict) binding', () => {
    expect(() => assertStrictEd25519()).not.toThrow();
  });

  it('throws naming §5.10 and sig-004 when the binding accepts the forgery', () => {
    mockNonStrict = true;
    expect(() => assertStrictEd25519()).toThrow(/§5\.10.*sig-004|sig-004.*§5\.10/);
  });
});
