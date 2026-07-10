/**
 * WitnessSigningService — the control plane's transparency-log WITNESS identity
 * (RFC-ACDP-0015 §9): a DID with an Ed25519 `assertionMethod` key that is the
 * witness's OWN signing material, distinct from everything else the CP signs.
 *
 * ## Why a dedicated key, not the federation IdP key
 *
 * The CP is also an EdDSA federation IdP (`SigningMaterialService`, JWKS at
 * `/.well-known/jwks.json`). This service does NOT reuse that key:
 *
 *   - RFC-ACDP-0015 §5/§12: "the signer is the witness, under the witness's own
 *     DID and key." A witness is not a registry and not an IdP — it is a new
 *     signing role, and §15 requires role separation for the witness key.
 *   - The IdP key may be HS256 (the default), which has no publishable public
 *     half at all — a witness MUST have a resolvable `assertionMethod` key.
 *   - Conflating a JWT-issuing key with a checkpoint-attesting key would let a
 *     compromise of one forge the other; the whole value of a cosignature is
 *     its independence.
 *
 * So the witness key is its own Ed25519 PEM (`WITNESS_SIGNING_PRIVATE_KEY_PEM`)
 * under its own DID (`WITNESS_ID`). Built once at boot; throws at construction
 * if cosigning is enabled but the key/DID are missing or malformed (surfaced as
 * a clear fatal boot log, like SigningMaterialService), so the CP never mints
 * cosignatures with garbage.
 *
 * The service also serves the witness's resolvable identity:
 *   - {@link didDocument} → the `/.well-known/did.json` a consumer dereferences
 *     to resolve `signature.key_id` to the `assertionMethod` key (§8 step 2).
 *   - {@link capabilities} → the `/.well-known/acdp-witness.json` advisory doc
 *     (§9): `witness_id`, `profiles: ["acdp-log-witness"]`, covered logs.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';
import {
  nodeWitnessSigner,
  sdkHasCosignatureSurface,
  type LogCosignature,
  type WitnessSigner,
} from '../audit/cosign';

/** did:web or did:key — the shape RFC-ACDP-0015 §4 allows for witness_id. */
const WITNESS_DID_RE = /^did:(web:[a-zA-Z0-9.%:-]+|key:z[1-9A-HJ-NP-Za-km-z]+)$/;

export class WitnessConfigError extends Error {}

/** A W3C DID document (the resolvable subset a consumer needs, §8/§9). */
export interface WitnessDidDocument {
  '@context': string[];
  id: string;
  verificationMethod: Array<{
    id: string;
    type: string;
    controller: string;
    publicKeyMultibase: string;
  }>;
  assertionMethod: string[];
}

/** The `/.well-known/acdp-witness.json` capabilities document (§9). */
export interface WitnessCapabilities {
  witness_id: string;
  profiles: string[];
  covered_logs: string[];
  cosignature_endpoint: string;
}

@Injectable()
export class WitnessSigningService {
  private readonly logger = new Logger(WitnessSigningService.name);

  /** True when cosigning is configured and the key/DID validated at boot. */
  readonly enabled: boolean;
  /** The witness DID (RFC-ACDP-0015 §4 witness_id), or '' when disabled. */
  readonly witnessId: string;
  /** The assertionMethod key id (DID URL under witnessId), or '' when disabled. */
  readonly keyId: string;
  /** Standard-base64 raw 32-byte Ed25519 public key, or '' when disabled. */
  readonly publicKeyB64: string;
  /** `z`-prefixed base58btc multibase (multicodec 0xed01) form, or '' when disabled. */
  readonly publicKeyMultibase: string;
  /** The live signer (§5), or null when disabled. */
  readonly signer: WitnessSigner | null;

  constructor(config: AppConfigService) {
    if (!config.witnessCosigningEnabled) {
      this.enabled = false;
      this.witnessId = '';
      this.keyId = '';
      this.publicKeyB64 = '';
      this.publicKeyMultibase = '';
      this.signer = null;
      return;
    }

    const witnessId = config.witnessId.trim();
    if (!WITNESS_DID_RE.test(witnessId)) {
      throw new WitnessConfigError(
        `WITNESS_ID must be a did:web or did:key when WITNESS_COSIGNING_ENABLED=true (got '${witnessId}')`,
      );
    }
    const pem = config.witnessSigningPrivateKeyPem;
    if (!pem.trim()) {
      throw new WitnessConfigError(
        'WITNESS_SIGNING_PRIVATE_KEY_PEM (PEM-encoded Ed25519 private key) is required when WITNESS_COSIGNING_ENABLED=true',
      );
    }
    let priv: KeyObject;
    try {
      priv = createPrivateKey(pem);
    } catch (e) {
      throw new WitnessConfigError(
        `WITNESS_SIGNING_PRIVATE_KEY_PEM is not a valid PEM key: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (priv.asymmetricKeyType !== 'ed25519') {
      throw new WitnessConfigError(
        `WITNESS_SIGNING_PRIVATE_KEY_PEM must be an Ed25519 key (got '${priv.asymmetricKeyType ?? 'unknown'}')`,
      );
    }

    // @types/node 26 dropped the KeyObject overload from createPublicKey;
    // deriving the public key from a private KeyObject is valid at runtime.
    const rawPub = extractEd25519RawPublic(
      createPublicKey(priv as unknown as Parameters<typeof createPublicKey>[0]),
    );
    const keyId = config.witnessKeyId.trim() || `${witnessId}#witness-key-1`;
    if (stripFragment(keyId) !== witnessId) {
      throw new WitnessConfigError(
        `WITNESS_KEY_ID '${keyId}' must be a DID URL under WITNESS_ID '${witnessId}' (RFC-ACDP-0015 §4)`,
      );
    }

    // RFC-ACDP-0015 §9: a did:web witness MUST serve its DID document at the
    // host encoded in the DID. This CP serves the witness did.json at
    // `/.well-known/did.json` (WitnessController), so a `did:web:<host>` witness
    // is only resolvable if `<host>` actually points at THIS control plane —
    // otherwise every consumer's resolver fetches someone else's host (or 404s)
    // and no cosignature we mint can ever be verified. Assert the binding at
    // boot against the configured public host. did:key is self-describing (the
    // key IS the DID), so it is exempt.
    if (witnessId.startsWith('did:web:')) {
      const didHost = didWebAuthority(witnessId);
      const publicHost = normalizeHost(config.publicHost ?? '');
      if (publicHost === '') {
        this.logger.warn(
          `WITNESS_ID is a did:web (${witnessId}) but PUBLIC_HOST is not set — cannot verify the ` +
            `witness DID resolves to this control plane. Set PUBLIC_HOST to this CP's externally ` +
            `resolvable host so a consumer's resolver reaches /.well-known/did.json here.`,
        );
      } else if (didHost !== publicHost) {
        throw new WitnessConfigError(
          `WITNESS_ID '${witnessId}' encodes host '${didHost}', which does not match this control ` +
            `plane's PUBLIC_HOST '${publicHost}'. A consumer resolving the witness DID would fetch ` +
            `'${didHost}/.well-known/did.json', not this CP — so no cosignature this witness mints ` +
            `could be verified. Fix WITNESS_ID or PUBLIC_HOST (RFC-ACDP-0015 §9).`,
        );
      }
    }

    this.enabled = true;
    this.witnessId = witnessId;
    this.keyId = keyId;
    this.publicKeyB64 = Buffer.from(rawPub).toString('base64');
    this.publicKeyMultibase = ed25519Multibase(rawPub);
    this.signer = nodeWitnessSigner(witnessId, keyId, priv);
    this.logger.log(
      `witness cosigning enabled: witness_id=${witnessId} key_id=${keyId} ` +
        `pubkey=${this.publicKeyB64} ` +
        `mint=${sdkHasCosignatureSurface() ? 'acdp-binding (native RFC-ACDP-0015 §5)' : 'host TS (§5 fallback; binding predates the cosignature API)'}`,
    );
  }

  /**
   * The witness DID document served at `/.well-known/did.json` (§9). Carries the
   * single active `assertionMethod` key a consumer resolves `signature.key_id`
   * to when verifying cosignatures (§8 step 2). Throws if disabled.
   */
  didDocument(): WitnessDidDocument {
    if (!this.enabled) {
      throw new WitnessConfigError('witness cosigning is disabled — no DID document to serve');
    }
    return {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: this.witnessId,
      verificationMethod: [
        {
          id: this.keyId,
          type: 'Ed25519VerificationKey2020',
          controller: this.witnessId,
          publicKeyMultibase: this.publicKeyMultibase,
        },
      ],
      assertionMethod: [this.keyId],
    };
  }

  /**
   * The witness capabilities document served at `/.well-known/acdp-witness.json`
   * (§9). Advisory: `covered_logs` is the set of logs this witness has actually
   * cosigned (the CP passes it in). Throws if disabled.
   */
  capabilities(coveredLogs: string[]): WitnessCapabilities {
    if (!this.enabled) {
      throw new WitnessConfigError('witness cosigning is disabled — no capabilities to serve');
    }
    return {
      witness_id: this.witnessId,
      profiles: ['acdp-log-witness'],
      covered_logs: coveredLogs,
      cosignature_endpoint: '/log/witness',
    };
  }

  /** A cosignature verifies under THIS witness's own assertionMethod key. */
  ownCosignatureVerifies(cosignature: LogCosignature): boolean {
    return cosignature.witness_id === this.witnessId;
  }
}

/**
 * Extract the raw 32-byte Ed25519 public key from a Node KeyObject. Node's SPKI
 * DER for Ed25519 is a fixed 44 bytes ending in the 32 raw key bytes
 * (mirrors `jwt-signing.ts`).
 */
function extractEd25519RawPublic(pub: KeyObject): Buffer {
  const der = pub.export({ format: 'der', type: 'spki' });
  if (der.length !== 44) {
    throw new WitnessConfigError(`unexpected Ed25519 SPKI length ${der.length} (want 44)`);
  }
  return der.subarray(12, 44);
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Encode raw 32-byte Ed25519 key as `did:key`-style multibase (0xed01 prefix). */
function ed25519Multibase(rawPub: Buffer): string {
  const prefixed = Buffer.concat([Buffer.from([0xed, 0x01]), rawPub]);
  return 'z' + base58btc(prefixed);
}

function base58btc(buf: Buffer): string {
  let x = BigInt('0x' + (buf.toString('hex') || '0'));
  let out = '';
  const base = 58n;
  while (x > 0n) {
    const rem = Number(x % base);
    x = x / base;
    out = BASE58_ALPHABET[rem] + out;
  }
  // Preserve leading-zero bytes as leading '1's.
  for (const byte of buf) {
    if (byte === 0) out = BASE58_ALPHABET[0] + out;
    else break;
  }
  return out;
}

function stripFragment(didUrl: string): string {
  const hash = didUrl.indexOf('#');
  return hash === -1 ? didUrl : didUrl.slice(0, hash);
}

/**
 * Extract the host authority (`host` or `host:port`) from a `did:web` DID. Per
 * the did:web method, the authority is the first colon-separated segment after
 * `did:web:` (later segments are the path), and a `:port` is percent-encoded as
 * `%3A`. Returns a lowercase, normalized host[:port].
 */
function didWebAuthority(witnessId: string): string {
  const body = witnessId.slice('did:web:'.length);
  const authority = body.split(':', 1)[0] ?? body;
  return normalizeHost(decodeURIComponent(authority));
}

/** Normalize a host string: drop any scheme/path, lowercase, trim a trailing slash. */
function normalizeHost(raw: string): string {
  let h = raw.trim().toLowerCase();
  if (h === '') return '';
  const scheme = h.indexOf('://');
  if (scheme !== -1) h = h.slice(scheme + 3);
  const slash = h.indexOf('/');
  if (slash !== -1) h = h.slice(0, slash);
  return h;
}
