import {
  DidDocumentError,
  parseDidDocument,
  pickVerificationMethod,
} from './did-document-parser';
import { DidDocument } from './did-document';

const DID = 'did:web:example.com:agents:alice';
const KEY_ID = `${DID}#key-1`;

/** A valid Ed25519 multibase-z key (multicodec 0xed01 + 32 raw bytes). The
 *  specific bytes don't matter for this test — we assert shape only. */
const ED25519_MB =
  'z6Mkv4ScDB4iH5VWidL51TwgQbtimYf73r1vGfeaQ3eSn6S7';

function doc(over: Partial<DidDocument> = {}): DidDocument {
  return {
    id: DID,
    verificationMethod: [
      {
        id: KEY_ID,
        controller: DID,
        type: 'Ed25519VerificationKey2020',
        publicKeyMultibase: ED25519_MB,
      },
    ],
    assertionMethod: [KEY_ID],
    ...over,
  };
}

describe('parseDidDocument', () => {
  it('round-trips a valid document', () => {
    const out = parseDidDocument(doc(), DID);
    expect(out.id).toBe(DID);
  });

  it('rejects non-object input', () => {
    expect(() => parseDidDocument('hello', DID)).toThrow(DidDocumentError);
    expect(() => parseDidDocument(null, DID)).toThrow(DidDocumentError);
  });

  it('rejects missing id', () => {
    const bad = { ...doc(), id: undefined } as unknown;
    expect(() => parseDidDocument(bad, DID)).toThrow(/missing required `id`/);
  });

  it('rejects id mismatch (substitution attack)', () => {
    expect(() => parseDidDocument(doc({ id: 'did:web:attacker.example' }), DID)).toThrow(
      /does not match requested DID/,
    );
  });
});

describe('pickVerificationMethod', () => {
  it('extracts an Ed25519 key authorized in assertionMethod', () => {
    const key = pickVerificationMethod(doc(), KEY_ID, 'ed25519');
    expect(key.keyId).toBe(KEY_ID);
    expect(key.algorithm).toBe('ed25519');
    // The decoded raw key MUST be exactly 32 bytes (Ed25519 public key size).
    expect(Buffer.from(key.publicKeyB64, 'base64').length).toBe(32);
  });

  it('rejects a key NOT listed in assertionMethod (auth gate)', () => {
    const d = doc({ assertionMethod: [] });
    expect(() => pickVerificationMethod(d, KEY_ID, 'ed25519')).toThrow(
      /not in assertionMethod/,
    );
  });

  it('rejects an unknown key id', () => {
    expect(() => pickVerificationMethod(doc(), `${DID}#bogus`, 'ed25519')).toThrow(
      /has no verificationMethod with id/,
    );
  });

  it('algorithm downgrade defense: ed25519 method + p256 request → error', () => {
    expect(() => pickVerificationMethod(doc(), KEY_ID, 'ecdsa-p256')).toThrow(
      /Ed25519VerificationKey2020/,
    );
  });

  it('extracts a P-256 JWK', () => {
    const d: DidDocument = {
      id: DID,
      verificationMethod: [
        {
          id: KEY_ID,
          controller: DID,
          type: 'JsonWebKey2020',
          publicKeyJwk: {
            kty: 'EC',
            crv: 'P-256',
            x: Buffer.alloc(32, 0x11).toString('base64url'),
            y: Buffer.alloc(32, 0x22).toString('base64url'),
          },
        },
      ],
      assertionMethod: [KEY_ID],
    };
    const key = pickVerificationMethod(d, KEY_ID, 'ecdsa-p256');
    expect(key.algorithm).toBe('ecdsa-p256');
    const sec1 = Buffer.from(key.publicKeyB64, 'base64');
    expect(sec1.length).toBe(65);
    expect(sec1[0]).toBe(0x04);
  });

  it('rejects a P-256 JWK with truncated coordinates', () => {
    const d: DidDocument = {
      id: DID,
      verificationMethod: [
        {
          id: KEY_ID,
          controller: DID,
          type: 'JsonWebKey2020',
          publicKeyJwk: {
            kty: 'EC',
            crv: 'P-256',
            x: Buffer.alloc(16, 0x11).toString('base64url'),
            y: Buffer.alloc(32, 0x22).toString('base64url'),
          },
        },
      ],
      assertionMethod: [KEY_ID],
    };
    expect(() => pickVerificationMethod(d, KEY_ID, 'ecdsa-p256')).toThrow(
      /wrong-length coordinates/,
    );
  });

  it('rejects an Ed25519 JWK with wrong kty/crv (downgrade defense)', () => {
    const d: DidDocument = {
      id: DID,
      verificationMethod: [
        {
          id: KEY_ID,
          controller: DID,
          type: 'JsonWebKey2020',
          publicKeyJwk: {
            kty: 'EC',           // wrong — should be OKP
            crv: 'Ed25519',
            x: Buffer.alloc(32, 0x33).toString('base64url'),
          },
        },
      ],
      assertionMethod: [KEY_ID],
    };
    expect(() => pickVerificationMethod(d, KEY_ID, 'ed25519')).toThrow(
      /requested ed25519 but JWK/,
    );
  });

  it('extracts a P-256 key declared as EcdsaSecp256r1VerificationKey2019 (registry parity)', () => {
    const d: DidDocument = {
      id: DID,
      verificationMethod: [
        {
          id: KEY_ID,
          controller: DID,
          type: 'EcdsaSecp256r1VerificationKey2019',
          publicKeyJwk: {
            kty: 'EC',
            crv: 'P-256',
            x: Buffer.alloc(32, 0x11).toString('base64url'),
            y: Buffer.alloc(32, 0x22).toString('base64url'),
          },
        },
      ],
      assertionMethod: [KEY_ID],
    };
    const key = pickVerificationMethod(d, KEY_ID, 'ecdsa-p256');
    expect(key.algorithm).toBe('ecdsa-p256');
    const sec1 = Buffer.from(key.publicKeyB64, 'base64');
    expect(sec1.length).toBe(65);
    expect(sec1[0]).toBe(0x04);
  });

  it('downgrade defense: EcdsaSecp256r1VerificationKey2019 + ed25519 request → error', () => {
    const d: DidDocument = {
      id: DID,
      verificationMethod: [
        {
          id: KEY_ID,
          controller: DID,
          type: 'EcdsaSecp256r1VerificationKey2019',
          publicKeyJwk: {
            kty: 'EC',
            crv: 'P-256',
            x: Buffer.alloc(32, 0x11).toString('base64url'),
            y: Buffer.alloc(32, 0x22).toString('base64url'),
          },
        },
      ],
      assertionMethod: [KEY_ID],
    };
    expect(() => pickVerificationMethod(d, KEY_ID, 'ed25519')).toThrow(
      /EcdsaSecp256r1VerificationKey2019/,
    );
  });

  it('extracts an Ed25519 key declared as Multikey (multicodec-derived)', () => {
    const d = doc({
      verificationMethod: [
        {
          id: KEY_ID,
          controller: DID,
          type: 'Multikey',
          publicKeyMultibase: ED25519_MB,
        },
      ],
    });
    const key = pickVerificationMethod(d, KEY_ID, 'ed25519');
    expect(key.algorithm).toBe('ed25519');
    expect(Buffer.from(key.publicKeyB64, 'base64').length).toBe(32);
  });

  it('rejects P-256 via publicKeyMultibase (JWK required, matches acdp-rs)', () => {
    const d: DidDocument = {
      id: DID,
      verificationMethod: [
        {
          id: KEY_ID,
          controller: DID,
          type: 'EcdsaSecp256r1VerificationKey2019',
          // A P-256 multibase key (0x8024 multicodec) — accepted as a
          // downgrade signal but not extractable; must surface clearly.
          publicKeyMultibase: ED25519_MB.replace(/^z/, 'z'),
        },
      ],
      assertionMethod: [KEY_ID],
    };
    expect(() => pickVerificationMethod(d, KEY_ID, 'ecdsa-p256')).toThrow(
      /requires publicKeyJwk/,
    );
  });

  it('rejects multibase prefix other than z (base58btc)', () => {
    const d = doc({
      verificationMethod: [
        {
          id: KEY_ID,
          controller: DID,
          type: 'Ed25519VerificationKey2020',
          publicKeyMultibase: 'B' + 'A'.repeat(45),
        },
      ],
    });
    expect(() => pickVerificationMethod(d, KEY_ID, 'ed25519')).toThrow(
      /not z-base58btc/,
    );
  });
});
