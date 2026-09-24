import { randomBytes } from 'node:crypto';
import { decodeEd25519Multibase, encodeEd25519Multibase } from './multibase';

describe('multibase (Ed25519 did:key encode/decode)', () => {
  it('round-trips 1000 random 32-byte keys', () => {
    for (let i = 0; i < 1000; i++) {
      const key = randomBytes(32);
      const encoded = encodeEd25519Multibase(key);
      const decoded = decodeEd25519Multibase(encoded);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.publicKey.equals(key)).toBe(true);
      }
    }
  });

  it('round-trips a key with a leading zero byte', () => {
    const key = Buffer.concat([Buffer.from([0x00]), randomBytes(31)]);
    const decoded = decodeEd25519Multibase(encodeEd25519Multibase(key));
    expect(decoded).toEqual({ ok: true, publicKey: key });
  });

  it('round-trips an all-zero key', () => {
    const key = Buffer.alloc(32, 0);
    const decoded = decodeEd25519Multibase(encodeEd25519Multibase(key));
    expect(decoded).toEqual({ ok: true, publicKey: key });
  });

  it('accepts a full did:key:z... identifier, stripping the prefix', () => {
    const key = randomBytes(32);
    const multibase = encodeEd25519Multibase(key);
    const decoded = decodeEd25519Multibase(`did:key:${multibase}`);
    expect(decoded).toEqual({ ok: true, publicKey: key });
  });

  it('strips a trailing #fragment (the did:key self-fragment form)', () => {
    const key = randomBytes(32);
    const multibase = encodeEd25519Multibase(key);
    const decoded = decodeEd25519Multibase(`did:key:${multibase}#${multibase}`);
    expect(decoded).toEqual({ ok: true, publicKey: key });
  });

  it('rejects a value missing the z prefix', () => {
    const decoded = decodeEd25519Multibase('6MkGSomeBase58Value');
    expect(decoded).toEqual({ ok: false, reason: expect.stringMatching(/z.*prefix/) });
  });

  it('rejects an empty multibase value', () => {
    expect(decodeEd25519Multibase('z').ok).toBe(false);
    expect(decodeEd25519Multibase('did:key:z').ok).toBe(false);
  });

  it('rejects invalid base58 characters (0, O, I, l are excluded from the alphabet)', () => {
    const decoded = decodeEd25519Multibase('z0OIl');
    expect(decoded).toEqual({ ok: false, reason: expect.stringMatching(/invalid base58 character/) });
  });

  it('rejects a non-Ed25519 multicodec prefix with a named "unsupported algorithm" reason', () => {
    // multicodec 0x1200 (P-256) is legal per RFC-ACDP-0001 §5.10 but unsupported here.
    const p256Prefixed = Buffer.concat([Buffer.from([0x12, 0x00]), randomBytes(33)]);
    const multibase = 'z' + encodeRaw58(p256Prefixed);
    const decoded = decodeEd25519Multibase(multibase);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.reason).toMatch(/unsupported key algorithm/);
    }
  });

  it('rejects a correctly-prefixed key of the wrong length', () => {
    const wrongLength = Buffer.concat([Buffer.from([0xed, 0x01]), randomBytes(20)]);
    const multibase = 'z' + encodeRaw58(wrongLength);
    const decoded = decodeEd25519Multibase(multibase);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.reason).toMatch(/wrong length/);
    }
  });

  it('rejects a multibase value too short to carry the multicodec prefix', () => {
    const decoded = decodeEd25519Multibase('z' + encodeRaw58(Buffer.from([0xed])));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.reason).toMatch(/too short/);
    }
  });
});

/** Local base58btc encoder used only to build malformed fixtures above (independent of the module under test's own encoder). */
function encodeRaw58(buf: Buffer): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let x = BigInt('0x' + (buf.toString('hex') || '0'));
  let out = '';
  while (x > 0n) {
    out = ALPHABET[Number(x % 58n)] + out;
    x /= 58n;
  }
  for (const byte of buf) {
    if (byte === 0) out = ALPHABET[0] + out;
    else break;
  }
  return out;
}
