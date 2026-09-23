/**
 * Canonical `registry authority ⇄ did:web` conversion — the ONE place this
 * control plane translates an enrollment/webhook authority into the DID a
 * registry actually advertises, and back.
 *
 * ## Why this is not a template string
 *
 * `:` is a STRUCTURAL delimiter in `did:web`: it separates the authority
 * segment from the path segments. So an authority that carries a port must
 * percent-encode its colon as `%3A`, or the port becomes a path component and
 * the DID names something else entirely:
 *
 *   - `registry.example.com` → `did:web:registry.example.com`
 *   - `localhost:8443`       → `did:web:localhost%3A8443`   (NOT `…localhost:8443`)
 *
 * The SDK does exactly this (`acdp-did/src/web.rs` `authority_to_did_web` /
 * `did_web_to_authority`) and the reference registry builds the
 * `capabilities.registry_did` it advertises — and the `log_id` / receipt
 * `key_id` DIDs derived from it — with that same function. The naive
 * `"did:web:" + authority` template this module replaces therefore DISAGREED
 * with every conformant registry addressed by `host:port`, and each
 * disagreement was reported by the audit sweeps as registry dishonesty: a
 * `registry_did_mismatch` flag, a `receipt_key_foreign_did` flag, an
 * `invalid_proof` verdict, or — worst — a `checkpoint_invalid` operator alert
 * with an SSE event and an outbound webhook. Cried wolf on an innocent
 * registry, on every sweep.
 *
 * The published `acdp` binding does NOT expose these two functions (its
 * `AcdpDid` surface is `webToUrl` + `stripFragment` only), so they are
 * transcribed here, in one module, rather than re-spelled at each call site —
 * five near-identical string manipulations is how the divergence happened the
 * first time.
 *
 * ## Case
 *
 * `did:web` DIDs are case-sensitive on the wire and the registry does not
 * lowercase, so neither does this module. A caller doing a HOST-BINDING
 * comparison (is this DID's host the same host as ours?) normalizes case
 * itself — that is a different, legitimate operation; see
 * `WitnessSigningService`'s `normalizeHost`.
 */

const DID_WEB_PREFIX = 'did:web:';

/**
 * True when `authority` is a value we can canonically encode: non-blank, and
 * carrying no `%`.
 *
 * A bare `%` cannot appear in a `host` or `host:port` authority, so its
 * presence means the value has ALREADY been did:web-encoded (`localhost%3A8443`
 * stored where `localhost:8443` belongs) or is not an authority at all.
 * Accepting both spellings would make `did:web:localhost%3A8443` and
 * `did:web:localhost%253A8443` both "correct", recreating exactly the ambiguity
 * this module exists to remove — so we reject, and callers report the check as
 * one they could not COMPLETE (an `unverified:` note / `error` verdict), never
 * as a dishonesty flag against the registry.
 */
function isCanonicalAuthority(authority: string): boolean {
  return authority.trim().length > 0 && !authority.includes('%');
}

/**
 * Encode a registry authority (`host` or `host:port`) as its `did:web` DID,
 * percent-encoding the authority's `:` as `%3A` per the did:web method — the
 * transcription of the SDK's `authority_to_did_web`.
 *
 * Returns `null` when the authority is not canonically encodable (blank, or
 * already percent-encoded — see {@link isCanonicalAuthority}); use
 * {@link nonCanonicalAuthorityReason} for the operator-facing explanation.
 */
export function authorityToDidWeb(authority: string): string | null {
  if (!isCanonicalAuthority(authority)) return null;
  return `${DID_WEB_PREFIX}${authority.replaceAll(':', '%3A')}`;
}

/**
 * The inverse: strip `did:web:` and decode the authority segment's `%3A` back
 * to `:` — the transcription of the SDK's `did_web_to_authority`.
 *
 * ONLY the first colon-separated segment carries the authority; anything after
 * it is a path and is dropped undecoded (`did:web:example.com:users:alice` →
 * `example.com`). Returns `null` for input that is not a `did:web` DID.
 *
 * Like the SDK, this decodes the canonical uppercase `%3A` only — a DID
 * spelling the colon `%3a` is not what any conformant producer mints, and
 * silently accepting it would reintroduce two spellings of one identity.
 */
export function didWebToAuthority(did: string): string | null {
  if (!did.startsWith(DID_WEB_PREFIX)) return null;
  const rest = did.slice(DID_WEB_PREFIX.length);
  const firstSegment = rest.split(':', 1)[0] ?? '';
  return firstSegment.replaceAll('%3A', ':');
}

/**
 * Operator-facing explanation for an authority {@link authorityToDidWeb}
 * rejects. Phrased as a statement about OUR data, because that is what it is:
 * a registry cannot be at fault for what we stored as its authority.
 */
export function nonCanonicalAuthorityReason(authority: string): string {
  if (authority.trim().length === 0) {
    return 'registry authority is blank — no did:web identity can be derived from it';
  }
  return (
    `registry authority '${authority}' is not a canonical did:web authority: it contains '%', ` +
    `so it appears to be percent-encoded already (store 'localhost:8443', not 'localhost%3A8443')`
  );
}
