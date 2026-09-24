/**
 * Ed25519 `did:key`-style multibase encode/decode (base58btc, multicodec
 * `0xed 0x01`) — the ONE place this repo adds a protocol primitive in TS
 * rather than taking it from the `acdp` SDK.
 *
 * Justification (RFC-ACDP-0015 Phase 8, B2): the published binding's entire
 * public surface was enumerated at the pinned `^0.14.1` floor and exposes no
 * `did:key` decoder — `AcdpDid` has only `webToUrl` and `stripFragment`.
 * Multibase is a plain *encoding*, not cryptography (the crypto — Ed25519
 * verification — still comes from the SDK once the raw key bytes are in
 * hand), and this repo already contained the ENCODER twice
 * (`witness-signing.service.ts`, `src/audit/cosign.ts`) before this module
 * replaced both. If a future binding exposes a decoder, this module is the
 * single place to delegate from instead.
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX: Record<string, number> = Object.fromEntries(
  [...BASE58_ALPHABET].map((c, i) => [c, i]),
);

/** Ed25519 multicodec prefix (multicodec table: `0xed01`, varint-encoded as two bytes). */
const ED25519_MULTICODEC_PREFIX = Buffer.from([0xed, 0x01]);
const ED25519_RAW_KEY_LENGTH = 32;

export type MultibaseDecodeOutcome =
  | { ok: true; publicKey: Buffer }
  | { ok: false; reason: string };

/**
 * Encode a raw 32-byte Ed25519 public key as a `z`-prefixed base58btc
 * multibase string (the form used inside a `did:key:z...` identifier and
 * inside a `publicKeyMultibase` DID-document field). Never fails on a
 * well-formed 32-byte input.
 */
export function encodeEd25519Multibase(publicKey: Buffer): string {
  const prefixed = Buffer.concat([ED25519_MULTICODEC_PREFIX, publicKey]);
  return 'z' + base58btcEncode(prefixed);
}

/**
 * Decode a `z`-prefixed base58btc multibase string back to its raw Ed25519
 * public key bytes, verifying the `0xed 0x01` multicodec prefix and the
 * 32-byte length along the way. Accepts either the bare multibase value
 * (`z6Mk...`) or a full `did:key:z6Mk...` identifier (fragment stripped
 * automatically) — never throws; malformed input is a named `{ok: false}`
 * reason so a caller can log-and-skip rather than crash a sweep.
 */
export function decodeEd25519Multibase(input: string): MultibaseDecodeOutcome {
  const withoutFragment = input.split('#')[0]!;
  const multibase = withoutFragment.startsWith('did:key:')
    ? withoutFragment.slice('did:key:'.length)
    : withoutFragment;

  if (!multibase.startsWith('z')) {
    return { ok: false, reason: `not a base58btc multibase value (missing 'z' prefix): '${input}'` };
  }
  const body = multibase.slice(1);
  if (body.length === 0) {
    return { ok: false, reason: `empty multibase value: '${input}'` };
  }
  for (const c of body) {
    if (BASE58_INDEX[c] === undefined) {
      return { ok: false, reason: `invalid base58 character '${c}' in multibase value: '${input}'` };
    }
  }

  const decoded = base58btcDecode(body);
  if (decoded.length < ED25519_MULTICODEC_PREFIX.length) {
    return { ok: false, reason: `multibase value too short to carry a multicodec prefix: '${input}'` };
  }
  const prefix = decoded.subarray(0, ED25519_MULTICODEC_PREFIX.length);
  if (!prefix.equals(ED25519_MULTICODEC_PREFIX)) {
    return {
      ok: false,
      reason: `unsupported witness key algorithm (multicodec prefix 0x${prefix.toString('hex')}, want 0xed01/Ed25519): '${input}'`,
    };
  }
  const publicKey = decoded.subarray(ED25519_MULTICODEC_PREFIX.length);
  if (publicKey.length !== ED25519_RAW_KEY_LENGTH) {
    return {
      ok: false,
      reason: `Ed25519 key wrong length after multicodec prefix (got ${publicKey.length}, want ${ED25519_RAW_KEY_LENGTH}): '${input}'`,
    };
  }
  return { ok: true, publicKey };
}

function base58btcEncode(buf: Buffer): string {
  let x = BigInt('0x' + (buf.toString('hex') || '0'));
  let out = '';
  const base = 58n;
  while (x > 0n) {
    const rem = Number(x % base);
    x = x / base;
    out = BASE58_ALPHABET[rem] + out;
  }
  // Preserve leading-zero bytes as leading '1's (base58's convention for
  // representing them, since a leading zero byte would otherwise vanish
  // under plain big-integer division).
  for (const byte of buf) {
    if (byte === 0) out = BASE58_ALPHABET[0] + out;
    else break;
  }
  return out;
}

function base58btcDecode(body: string): Buffer {
  let x = 0n;
  const base = 58n;
  for (const c of body) {
    x = x * base + BigInt(BASE58_INDEX[c]!);
  }
  let hex = x.toString(16);
  if (hex.length % 2 === 1) hex = '0' + hex;
  const decoded = hex === '0' ? Buffer.alloc(0) : Buffer.from(hex, 'hex');

  // Leading '1's encode leading zero bytes — restore them (mirror of the
  // encoder's leading-zero-byte handling above).
  let leadingZeros = 0;
  for (const c of body) {
    if (c === BASE58_ALPHABET[0]) leadingZeros++;
    else break;
  }
  return Buffer.concat([Buffer.alloc(leadingZeros), decoded]);
}
