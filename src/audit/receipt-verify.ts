/**
 * Registry-receipt verification, delegated to the `acdp` Node SDK
 * (RFC-ACDP-0010). Same discipline as `src/auth/acdp-verify.ts`: the
 * receipt's closed-schema parse, the JCS preimage over the raw wire JSON,
 * the offline cross-checks and the Ed25519 signature check all live in
 * `acdp-rs` — the control plane accepts exactly the receipts the registry
 * and the reference consumer accept, with no parallel implementation.
 *
 * The receipt API (`AcdpVerifier.verifyReceipt`, `fingerprintEd25519B64`,
 * `verifyBodyOffline`) ships in `acdp` 0.4.0+; the PINNED floor is
 * `^0.14.1`, which is where `verifyReceipt` takes the accompanying body
 * as its second argument and performs the RFC-ACDP-0010 §8 step 3
 * body bindings. `sdkSupportsReceipts()` still feature-detects the
 * surface at runtime — not because a pre-0.4.0 binding is expected under
 * that floor, but because a mis-resolved native `optionalDependency` can
 * leave the JS package present and the methods absent. On such a binding
 * the audit sweep degrades to structural cross-checks only (no signature
 * verification) instead of crashing — a downgrade weakens the audit
 * loudly (boot warning) rather than breaking ingest.
 */
import { AcdpVerifier } from '@agentcontextdistributionprotocol/acdp';

/**
 * The post-0.3.0 receipt surface, DERIVED from the installed binding's own
 * declared type rather than hand-copied. A hand-written `interface` reached
 * through `as unknown as` erases the compiler's knowledge of the real
 * signatures: an SDK whose `verifyReceipt` grows a parameter then typechecks
 * clean here and fails every audit at runtime. `Pick<typeof AcdpVerifier, …>`
 * keeps `tsc` looking at the binding, so that change becomes a build error at
 * the call site. (Naming a method the installed binding does not declare is
 * likewise a build error — this type can only describe what is really there.)
 */
export type ReceiptSurface = Pick<
  typeof AcdpVerifier,
  'verifyReceipt' | 'fingerprintEd25519B64' | 'verifyBodyOffline' | 'explainHashMismatch'
>;

/**
 * `Partial<>` because the RUNTIME object can still be missing a method the
 * typings declare — an older or partially-installed native package. That is
 * what the `typeof … === 'function'` probes below defend against, and the
 * type system cannot see it. `Partial<Pick<…>>` is a widening of the class
 * type, so a plain `as` suffices — no `unknown` laundering.
 */
const verifier = AcdpVerifier as Partial<ReceiptSurface>;

/** True when the installed `acdp` binding carries the RFC-ACDP-0010 API. */
export function sdkSupportsReceipts(): boolean {
  return (
    typeof verifier.verifyReceipt === 'function' &&
    typeof verifier.fingerprintEd25519B64 === 'function'
  );
}

export type VerifyOutcome = { ok: true } | { ok: false; reason: string };

/**
 * How a `verifyReceipt` throw must be classified before it reaches an
 * operator, because the three kinds mean three different things and only
 * one of them is the registry's fault.
 *
 * **Why this is a prefix match on strings the binding controls, and not a
 * `.code` lookup.** `verify_receipt` does NOT route its failures through
 * the binding's `map_acdp_err` / `input_err` helpers the way, say,
 * `parseKeyRevocation` does — every one of its paths is a bare
 * `Error::from_reason(...)` (`bindings/acdp-node/src/verifier.rs:344-365`),
 * which surfaces as a napi `GenericFailure` carrying no RFC-ACDP-0007 wire
 * code. Assuming the two are symmetric is the trap. The only discriminator
 * left is the literal message prefix the binding itself writes, so the
 * coupling is made explicit here and pinned by `receipt-verify.spec.ts`,
 * which drives the REAL binding into each failure — a future SDK that
 * rewords a prefix fails that test instead of silently reclassifying a
 * whole failure mode.
 *
 * - `malformed_body` — `"invalid body JSON: "` (`verifier.rs:346-347`): the
 *   SDK's strict typed `Body` deserialization rejected the body we
 *   retrieved. That is a malformed upstream *response*, much closer to
 *   environmental than to dishonesty, so it must not land on the
 *   operator-facing "this registry misbehaved" list.
 * - `ctx_id_rejected` — `"invalid expectedCtxId: "` (`verifier.rs:356-357`):
 *   `CtxId::parse` refused the ctx_id we asked about. Rare, because
 *   `isCanonicalCtxId` pre-checks the same grammar in the host before the
 *   call — but rare is not impossible: that mirror is deliberately bounded
 *   and does NOT enforce the 63-character DNS-label limit `CtxId::parse`
 *   applies (see `CANONICAL_CTX_ID`), so a ctx_id carrying an over-long
 *   label passes the host check and is rejected here. Either way this is a
 *   defect in OUR stored input, not the registry's conduct, so it takes the
 *   `unverified:` note path and never a dishonesty flag.
 * - `receipt_dishonest` — everything else: the §8 step 3 `cross_check_body`
 *   bindings (`lineage_id` / `origin_registry` / `created_at` vs the served
 *   body), the receipt's own closed parse, the cross-checks, the Ed25519
 *   signature. This is deliberately the FALLTHROUGH: an unrecognised
 *   failure from the receipt verifier is never quietly downgraded to
 *   "environmental".
 */
export type ReceiptFailureKind = 'malformed_body' | 'ctx_id_rejected' | 'receipt_dishonest';

/** `bindings/acdp-node/src/verifier.rs:346-347`. */
const MALFORMED_BODY_PREFIX = 'invalid body JSON: ';
/** `bindings/acdp-node/src/verifier.rs:356-357`. */
const CTX_ID_REJECTED_PREFIX = 'invalid expectedCtxId: ';

/**
 * Classify a `verifyReceipt` failure from the binding's OWN message — the
 * raw `Error.message`, before `errMsg()` flattens a napi `.code` in front
 * of it. See `ReceiptFailureKind` for why a prefix match is the only
 * option here.
 */
export function classifyReceiptFailure(message: string): ReceiptFailureKind {
  if (message.startsWith(MALFORMED_BODY_PREFIX)) return 'malformed_body';
  if (message.startsWith(CTX_ID_REJECTED_PREFIX)) return 'ctx_id_rejected';
  return 'receipt_dishonest';
}

export type ReceiptVerifyOutcome =
  | { ok: true }
  | { ok: false; reason: string; kind: ReceiptFailureKind };

/**
 * The grammar `CtxId::parse` accepts, mirrored in the host so a ctx_id we
 * cannot canonically name is caught BEFORE `verifyReceipt` and reported as
 * our own data-quality defect rather than as registry dishonesty.
 *
 * `acdp://` + a lowercase DNS authority + `/` + a lowercase v4 UUID.
 * `is_valid_dns_authority` (`acdp-primitives/src/primitives.rs:469-488`)
 * admits only `[a-z0-9-]` labels joined by `.`, each starting and ending
 * alphanumeric — so a `:` is rejected outright and a port-bearing ctx_id
 * authority can never parse. (An enrollment authority MAY carry a port;
 * that is a different field and a different concern.)
 *
 * This is a mirror, not a re-implementation of a wire format: it decides
 * only which of our own rows to skip, never whether a receipt is valid.
 * `receipt-verify.spec.ts` drives the real binding across the boundary
 * cases so a divergence from `CtxId::parse` fails there.
 *
 * **One bound is deliberately NOT mirrored:** `CtxId::parse` also rejects a
 * DNS label longer than 63 characters, and this regex does not. Transcribing
 * RFC 1035's length rules by hand risks a new, subtler mismatch with the
 * SDK's actual grammar — the exact class of bug this pre-check exists to
 * avoid — and the cost of the gap is bounded and safe: an over-long label
 * passes here, `verifyReceipt` rejects it, and the failure classifies as
 * `ctx_id_rejected`, landing on the same `unverified:` note and the same
 * `error` verdict the pre-check would have produced. The SDK stays the final
 * authority; the host check only spares the common case a wasted network
 * round-trip. `receipt-verify.spec.ts` pins the 63/64 boundary so this stays
 * documented behaviour rather than a surprise.
 */
const CANONICAL_CTX_ID =
  /^acdp:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * True when `ctxId` parses under the SDK's `CtxId::parse` grammar, modulo the
 * one bound noted above (per-label length) that the SDK alone enforces.
 */
export function isCanonicalCtxId(ctxId: string): boolean {
  return CANONICAL_CTX_ID.test(ctxId);
}

/**
 * Verify a body's `content_hash` by independent recomputation. On success
 * the echoed hash string is PROVEN equal to the recomputation, so it is
 * safe to feed to `verifyReceipt` as `recomputedBodyHash`.
 */
export function verifyContentHash(bodyJson: string, expectedHash: string): VerifyOutcome {
  try {
    AcdpVerifier.verifyContentHash(bodyJson, expectedHash);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: errMsg(e) };
  }
}

/**
 * Full receipt verification (signature + offline cross-checks + the
 * RFC-ACDP-0010 §8 step 3 body bindings). Throws if the installed SDK
 * predates the receipt API — guard with `sdkSupportsReceipts()` first.
 *
 * `bodyJson` is the SECOND positional argument (since `acdp` 0.14.0) and
 * MUST be the exact string `verifyContentHash` was run against — the SDK
 * cross-checks the receipt's `lineage_id` / `origin_registry` /
 * `created_at` against that body's own fields.
 *
 * A failure carries a `kind` so the caller can tell the three tightened
 * failure modes apart; see `ReceiptFailureKind`.
 */
export function verifyReceipt(
  receiptJson: string,
  bodyJson: string,
  registryPublicKeyB64: string,
  expectedCtxId: string,
  recomputedBodyHash: string,
  producerKeyFingerprint: string,
): ReceiptVerifyOutcome {
  if (typeof verifier.verifyReceipt !== 'function') {
    throw new TypeError('installed acdp SDK has no verifyReceipt (need >= 0.14.1)');
  }
  try {
    verifier.verifyReceipt(
      receiptJson,
      bodyJson,
      registryPublicKeyB64,
      expectedCtxId,
      recomputedBodyHash,
      producerKeyFingerprint,
    );
    return { ok: true };
  } catch (e) {
    // Classify on the binding's OWN message; `errMsg` may prefix a napi
    // `.code` onto the operator-facing reason, which would break the
    // prefix match.
    return { ok: false, reason: errMsg(e), kind: classifyReceiptFailure(rawMsg(e)) };
  }
}

/**
 * `"sha256:<64-hex>"` fingerprint of a raw Ed25519 public key — the
 * RFC-ACDP-0010 §6 encoding the receipt's `key_fingerprint` carries.
 * Throws if the installed SDK predates the receipt API.
 */
export function fingerprintEd25519B64(publicKeyB64: string): string {
  if (typeof verifier.fingerprintEd25519B64 !== 'function') {
    throw new TypeError('installed acdp SDK has no fingerprintEd25519B64 (need > 0.3.0)');
  }
  return verifier.fingerprintEd25519B64(publicKeyB64);
}

/**
 * Offline verification of a did:key body (signature against the key embedded
 * in the DID itself — no resolution, no network). Returns false when the SDK
 * predates the API; callers treat that as "not independently verified".
 */
export function verifyBodyOffline(bodyJson: string): VerifyOutcome {
  if (typeof verifier.verifyBodyOffline !== 'function') {
    return { ok: false, reason: 'installed acdp SDK has no verifyBodyOffline (need > 0.3.0)' };
  }
  try {
    verifier.verifyBodyOffline(bodyJson);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: errMsg(e) };
  }
}

/**
 * Diagnose a `content_hash` mismatch — the SDK probes the known
 * cross-implementation divergence patterns (`acdp_version` omitted vs
 * explicit, null-vs-absent optionals, sub-millisecond timestamps) and names
 * the matching one. Used ONLY to enrich an already-flagged discrepancy so an
 * operator can tell a genuine tamper from a benign canonicalization
 * divergence — never to accept a body. Returns `null` when the SDK lacks the
 * helper or the diagnosis itself throws (best-effort).
 */
export function explainHashMismatch(bodyJson: string, expectedHash: string): string | null {
  if (typeof verifier.explainHashMismatch !== 'function') return null;
  try {
    return verifier.explainHashMismatch(bodyJson, expectedHash);
  } catch {
    return null;
  }
}

function errMsg(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e) {
    return `${String((e as { code: unknown }).code)}: ${rawMsg(e)}`;
  }
  return rawMsg(e);
}

/**
 * The thrown value's own message, with no `.code` flattened in front — the
 * literal the binding wrote, which `classifyReceiptFailure` prefix-matches.
 *
 * Duck-typed on `.message` rather than `instanceof Error` ON PURPOSE: the
 * native binding constructs its Error in the Node realm, so under a vm-based
 * test realm (ts-jest) `e instanceof Error` is FALSE and `String(e)` yields
 * `"Error: <message>"` — which silently defeats a prefix match on the real
 * binding's own output.
 */
function rawMsg(e: unknown): string {
  if (e && typeof e === 'object') {
    const msg: unknown = (e as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return String(e);
}
