/**
 * RFC-ACDP-0014 §4/§5 key-revocation body PARSING, delegated to the `acdp`
 * Node SDK's `AcdpVerifier.parseKeyRevocation` — the §4 shape validation and
 * the §5 step 2 not-self-signed rule both live in `acdp-rs`.
 *
 * Parsing does NOT verify the body — the SDK's own doc says so explicitly:
 * "Parsing does NOT verify the body: run the ordinary hash + signature
 * pipeline before trusting the result." The hash + signature pipeline is
 * the SAME one `receipt-verify.ts` already wraps
 * (`verifyContentHash`, `verifyBodyOffline`, `fingerprintEd25519B64`,
 * `verifyCtxIdBinding`) — reused from there, not duplicated here.
 */
import { AcdpVerifier } from '@agentcontextdistributionprotocol/acdp';

/**
 * Derived from the installed binding's own declared type (not a hand-copied
 * interface) for the same reason `receipt-verify.ts`'s `ReceiptSurface` is:
 * an SDK signature change becomes a build error at the call site instead of
 * a silent runtime mismatch. See CLAUDE.md's CI grep rule #6.
 */
export type RevocationSurface = Pick<typeof AcdpVerifier, 'parseKeyRevocation'>;

/** `Partial<>` for the same runtime-vs-typings gap `receipt-verify.ts` guards against. */
const verifier = AcdpVerifier as Partial<RevocationSurface>;

/** True when the installed `acdp` binding carries `parseKeyRevocation` (ships in `acdp` 0.9.1+). */
export function sdkSupportsRevocations(): boolean {
  return typeof verifier.parseKeyRevocation === 'function';
}

export interface ParsedRevocation {
  revokedKeyFingerprint: string;
  compromisedSince: string;
  reason: string | null;
  revokedKeyId: string | null;
  revokedKeyController: string;
  publisher: string;
  trustClass: 'producer_signed' | 'registry_attested';
}

/**
 * `parse_key_revocation`'s real napi `.code` values
 * (`bindings/acdp-node/src/{errors,verifier}.rs`) — unlike `verify_receipt`
 * (`receipt-verify.ts`'s `ReceiptFailureKind`, a bare `Error::from_reason`
 * with no wire code), this binding routes every failure through
 * `map_acdp_err`/`input_err`, so `.code` is a real, stable discriminator.
 * Do not generalise the two the other way either — see `receipt-verify.ts`'s
 * own warning about assuming symmetry across binding call sites.
 */
export type ParseRevocationFailureCode =
  | 'schema_violation'
  | 'key_not_authorized'
  | 'invalid_input'
  | 'unknown';

export type ParseRevocationOutcome =
  | { ok: true; revocation: ParsedRevocation }
  | { ok: false; code: ParseRevocationFailureCode; reason: string };

/**
 * Parse + shape-validate a retrieved `key-revocation` context body and
 * derive its §5/§6 trust class.
 *
 * `signerFingerprint` is REQUIRED and must be the RFC-ACDP-0010 §6
 * fingerprint of the RESOLVED, VERIFIED signing key — never derived from
 * anything the body merely claims about itself. **This is the one place a
 * caller could silently defeat the §5 step 2 not-self-signed defence**: the
 * binding's own `signerFingerprint` parameter is optional
 * (`index.d.ts:705`) and the check runs ONLY when it is supplied
 * (`bindings/acdp-node/src/v030.rs:588-590`) for a `did:web` signer (a
 * `did:key` signer is checked natively inside `KeyRevocation::from_body`
 * regardless of this argument) — so this wrapper makes the parameter
 * non-optional and throws on an empty string, converting "forgot to thread
 * it" from a silent security hole into a loud programming error. See
 * `revocation-verify.spec.ts`'s dedicated coverage of this trap: the test
 * asserts the wrapper FORWARDS a non-empty argument, not merely that a
 * self-signed revocation is rejected (that assertion alone would pass for
 * the wrong reason under a did:key fixture, whose native check would catch
 * it regardless of whether this wrapper threads the argument at all).
 */
export function parseKeyRevocation(
  bodyJson: string,
  signerFingerprint: string,
): ParseRevocationOutcome {
  if (typeof verifier.parseKeyRevocation !== 'function') {
    throw new TypeError('installed acdp SDK has no parseKeyRevocation (need >= 0.9.1)');
  }
  if (!signerFingerprint) {
    throw new TypeError(
      'parseKeyRevocation requires a non-empty signerFingerprint (RFC-ACDP-0014 §5 step 2 — ' +
        'an empty value would silently disable the not-self-signed defence for a did:web signer)',
    );
  }
  try {
    const json = verifier.parseKeyRevocation(bodyJson, signerFingerprint);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    // Fail CLOSED on an unrecognised trust_class rather than silently
    // defaulting to 'producer_signed' — that default is the one path that
    // would skip revocation-audit.service.ts's §6 registry-binding check for
    // a revocation the SDK actually classified as registry_attested. Today
    // the Rust match is exhaustive over exactly these two values, so this is
    // defensive against SDK drift, not a case reachable with the pinned
    // binding — but it must be a parse failure, never a silent
    // misclassification, if that ever stops being true.
    const trustClassRaw = parsed['trust_class'];
    if (trustClassRaw !== 'producer_signed' && trustClassRaw !== 'registry_attested') {
      return {
        ok: false,
        code: 'unknown',
        reason: `parseKeyRevocation returned an unrecognised trust_class: ${JSON.stringify(trustClassRaw)}`,
      };
    }
    return {
      ok: true,
      revocation: {
        revokedKeyFingerprint: strOf(parsed['revoked_key_fingerprint']) ?? '',
        compromisedSince: strOf(parsed['compromised_since']) ?? '',
        reason: strOf(parsed['reason']) ?? null,
        revokedKeyId: strOf(parsed['revoked_key_id']) ?? null,
        revokedKeyController: strOf(parsed['revoked_key_controller']) ?? '',
        publisher: strOf(parsed['publisher']) ?? '',
        trustClass: trustClassRaw,
      },
    };
  } catch (e) {
    return { ok: false, code: codeOf(e), reason: rawMsg(e) };
  }
}

function codeOf(e: unknown): ParseRevocationFailureCode {
  if (e && typeof e === 'object' && 'code' in e) {
    const c = String((e as { code: unknown }).code);
    if (c === 'schema_violation' || c === 'key_not_authorized' || c === 'invalid_input') return c;
  }
  return 'unknown';
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * The thrown value's own message, with no `.code` flattened in front — same
 * duck-typed-on-`.message` caution as `receipt-verify.ts`'s `rawMsg` (a
 * native binding's Error fails `instanceof Error` under ts-jest's vm realm).
 */
function rawMsg(e: unknown): string {
  if (e && typeof e === 'object') {
    const msg: unknown = (e as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return String(e);
}
