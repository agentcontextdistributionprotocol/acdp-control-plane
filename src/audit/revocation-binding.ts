/**
 * RFC-ACDP-0014 §6 registry-binding check for a `registry_attested`
 * key-revocation: does the revocation's `publisher` DID actually belong to
 * the registry we reached, and to the registry's own self-description?
 *
 * A transliteration of the SDK's `KeyRevocation::cross_check_registry_binding`
 * (`acdp-types/src/revocation.rs:384-405`) — pure, no I/O — which the
 * published `acdp` binding does not expose to Node (verified against the
 * complete `index.d.ts` export list at 0.14.1).
 *
 * Two comparisons, not one, and the SDK's own doc comment explains why the
 * second is not redundant with the first: "§5 body verification alone only
 * proves the body is genuinely signed by `publisher`'s current key, not that
 * `publisher` is the specific registry a caller actually talks to."
 *
 *   1. `publisher` MUST equal `authorityToDidWeb(servingAuthority)` — pins
 *      the publisher to the transport we actually reached.
 *   2. `publisher` MUST equal `capabilitiesRegistryDid` — pins it to the
 *      registry's own self-description (its advertised `registry_did`).
 *
 * Both use {@link authorityToDidWeb} (Phase 3's canonical did:web encoder,
 * `%3A`-encoding a port-bearing authority) rather than a naive
 * `` `did:web:${authority}` `` template — the registry builds its advertised
 * `registry_did` the same way, so a naive template would fail this check for
 * exactly the deployments Phase 3 fixes.
 */
import { authorityToDidWeb, nonCanonicalAuthorityReason } from '../common/did-authority';

export type RegistryBindingOutcome = { ok: true } | { ok: false; reason: string };

export function crossCheckRegistryBinding(
  publisher: string,
  servingAuthority: string,
  capabilitiesRegistryDid: string,
): RegistryBindingOutcome {
  const expectedDid = authorityToDidWeb(servingAuthority);
  if (expectedDid === null) {
    return { ok: false, reason: nonCanonicalAuthorityReason(servingAuthority) };
  }
  if (publisher !== expectedDid) {
    return {
      ok: false,
      reason:
        `key-revocation publisher '${publisher}' != serving authority's DID ` +
        `'${expectedDid}' (RFC-ACDP-0014 §6 steps 2-3)`,
    };
  }
  if (publisher !== capabilitiesRegistryDid) {
    return {
      ok: false,
      reason:
        `key-revocation publisher '${publisher}' != capabilities.registry_did ` +
        `'${capabilitiesRegistryDid}' (RFC-ACDP-0014 §6 steps 2-3)`,
    };
  }
  return { ok: true };
}
