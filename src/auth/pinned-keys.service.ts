/**
 * Pinned agent-key directory.
 *
 * Reads `CONTROL_PLANE_PINNED_KEYS` (comma-separated
 * `agent_did=public_key_b64[:algorithm][:validFrom..validUntil]` entries)
 * at boot. Used by the token issuer to verify challenge signatures
 * without standing up a full did:web resolver.
 *
 * Wire format:
 *
 *   did:web:alice=BASE64KEY                                  # ed25519, no window
 *   did:web:bob=BASE64KEY:ecdsa-p256                         # algo only
 *   did:web:alice=BASE64KEY:1700000000..1800000000           # window only
 *   did:web:alice=BASE64KEY:ed25519:1700000000..1800000000   # algo + window
 *   did:web:alice=BASE64KEY:..1800000000                     # open from
 *   did:web:alice=BASE64KEY:1700000000..                     # open until
 *
 * Window bounds are unix seconds, validFrom inclusive, validUntil
 * exclusive — mirrors the registry's `[playground] pinned_keys`
 * `valid_from`/`valid_until` semantics so an operator who maintains
 * one list also maintains the other.
 *
 * Backward compat: entries without `:algorithm` are treated as
 * `ed25519`; entries without a window are valid forever.
 *
 * Window enforcement at `get()`: when the current time is outside an
 * entry's window the lookup returns `undefined`, so callers (e.g.
 * `TokenIssuer`) fall through to did:web resolution — the dispatch
 * the rest of the codebase already implements for "no pin" cases.
 *
 * Marked `@Global()` so cross-module consumers (`CapabilityService`,
 * `TokenIssuer`, and the admin reload controller) share one directory
 * instead of constructing per-module copies.
 */
import { Global, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { assertValidPublicKey } from './acdp-verify';

export type PinnedAlgorithm = 'ed25519' | 'ecdsa-p256';

export interface PinnedKey {
  agentDid: string;
  algorithm: PinnedAlgorithm;
  /** Standard base64 raw public key — fed straight to `AcdpVerifier`. */
  rawB64: string;
  /** Unix seconds (inclusive). `undefined` = open from beginning of time. */
  validFromSec?: number;
  /** Unix seconds (exclusive). `undefined` = no expiry. */
  validUntilSec?: number;
}

@Global()
@Injectable()
export class PinnedKeysService implements OnModuleInit {
  private readonly logger = new Logger(PinnedKeysService.name);
  private keys: Map<string, PinnedKey> = new Map();

  onModuleInit(): void {
    const raw = process.env.CONTROL_PLANE_PINNED_KEYS ?? '';
    this.load(raw);
  }

  /**
   * Reset and reload from a raw env-string.
   *
   * Atomic: the in-memory map is replaced wholesale only after every
   * entry has been parsed + decoded successfully. A parse error on any
   * entry logs a warning and skips that entry (mirroring the original
   * lenient behavior); the rest still load.
   *
   * Exposed for tests and for the admin reload endpoint
   * (`POST /admin/pinned-keys/reload`).
   *
   * Returns the count of entries that loaded successfully.
   */
  load(raw: string): number {
    const next = new Map<string, PinnedKey>();
    if (raw.trim()) {
      for (const entry of raw.split(',')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        // Split on the FIRST `=` — base64 padding uses `=` too,
        // so lastIndexOf would mis-split on padded 44-char keys.
        const eq = trimmed.indexOf('=');
        if (eq < 0) {
          this.logger.warn(
            `Skipping malformed CONTROL_PLANE_PINNED_KEYS entry (no '='): '${trimmed}'`,
          );
          continue;
        }
        const did = trimmed.slice(0, eq).trim();
        const rhs = trimmed.slice(eq + 1).trim();
        if (!did || !rhs) continue;
        try {
          const parsed = parseKeyEntry(rhs);
          // Validate the key bytes up-front so a malformed entry is
          // skipped at boot rather than failing later inside verify.
          assertValidPublicKey(parsed.algorithm, parsed.keyB64);
          next.set(did, {
            agentDid: did,
            algorithm: parsed.algorithm,
            rawB64: parsed.keyB64,
            validFromSec: parsed.validFromSec,
            validUntilSec: parsed.validUntilSec,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.logger.warn(
            `Skipping CONTROL_PLANE_PINNED_KEYS entry for '${did}': ${msg}`,
          );
        }
      }
    }
    this.keys = next;
    this.logger.log(`Loaded ${this.keys.size} pinned key(s)`);
    return this.keys.size;
  }

  /**
   * Lookup a pinned key. Returns `undefined` when:
   * - no entry exists for `agentDid`, OR
   * - an entry exists but `nowMs` is outside its validity window.
   *
   * In the second case the dispatch in `TokenIssuer.completeChallenge`
   * falls through to did:web resolution, so a key staged in advance
   * (validFrom in the future) or post-expiry (validUntil in the past)
   * is treated identically to "not pinned" — exactly the behavior the
   * deferred plan §2 specifies.
   */
  get(agentDid: string, nowMs: number = Date.now()): PinnedKey | undefined {
    const key = this.keys.get(agentDid);
    if (!key) return undefined;
    const nowSec = Math.floor(nowMs / 1000);
    if (key.validFromSec !== undefined && nowSec < key.validFromSec) {
      return undefined;
    }
    if (key.validUntilSec !== undefined && nowSec >= key.validUntilSec) {
      return undefined;
    }
    return key;
  }

  /** Total entries currently in the directory (including windowed ones). */
  size(): number {
    return this.keys.size;
  }
}

const SUPPORTED_ALGS: ReadonlySet<PinnedAlgorithm> = new Set([
  'ed25519',
  'ecdsa-p256',
]);

interface ParsedEntry {
  keyB64: string;
  algorithm: PinnedAlgorithm;
  validFromSec?: number;
  validUntilSec?: number;
}

/**
 * Parse `key[:algorithm][:from..until]`.
 *
 * The window is matched first (anchored at end via regex) so the
 * algorithm-tag peel below sees a clean `key:algo` shape. Base64 keys
 * contain only `A-Za-z0-9+/=` — no `:` — so the suffix peel is
 * unambiguous.
 */
export function parseKeyEntry(rhs: string): ParsedEntry {
  let body = rhs;
  let validFromSec: number | undefined;
  let validUntilSec: number | undefined;
  let algorithm: PinnedAlgorithm = 'ed25519';

  // Peel optional window. Format: `:<from>..<until>` — either bound
  // may be empty but not both (`:..` alone is rejected as a typo).
  const windowMatch = body.match(/:(\d*)\.\.(\d*)$/);
  if (windowMatch) {
    const [full, fromStr, untilStr] = windowMatch;
    if (fromStr === '' && untilStr === '') {
      throw new Error(
        `pinned-key window ':..' must specify at least one bound`,
      );
    }
    if (fromStr !== '') {
      const n = Number(fromStr);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`invalid validFrom in window: '${fromStr}'`);
      }
      validFromSec = n;
    }
    if (untilStr !== '') {
      const n = Number(untilStr);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`invalid validUntil in window: '${untilStr}'`);
      }
      validUntilSec = n;
    }
    if (
      validFromSec !== undefined &&
      validUntilSec !== undefined &&
      validFromSec >= validUntilSec
    ) {
      throw new Error(
        `invalid window: validFrom (${validFromSec}) >= validUntil (${validUntilSec})`,
      );
    }
    body = body.slice(0, body.length - full.length);
  }

  // Peel optional algorithm tag (same approach the original parser used).
  for (const alg of SUPPORTED_ALGS) {
    const suffix = `:${alg}`;
    if (body.endsWith(suffix)) {
      algorithm = alg;
      body = body.slice(0, body.length - suffix.length);
      break;
    }
  }

  return { keyB64: body.trim(), algorithm, validFromSec, validUntilSec };
}
