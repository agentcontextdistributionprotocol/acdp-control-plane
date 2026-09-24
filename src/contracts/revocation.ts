/**
 * RFC-ACDP-0014 (producer key-revocation signal) context-type vocabulary.
 *
 * `key-revocation` is registered as a **standard** protocol context type
 * (`registries/context-types.md`, the `acdp-common.schema.json` enum) — not a
 * domain-pack vertical type — so it must always be accepted on ingest, the
 * same as the RFC-ACDP-0001 base types, regardless of which domain packs are
 * configured.
 *
 * `acdp:key-revocation` is the pre-0.3.0 interim spelling. §10 requires 0.3.0+
 * consumers to treat it as fully equivalent to the standard form: retrieval of
 * already-published interim-form bodies is preserved forever, pre-0.5.0 and
 * third-party registries may still mint it, and §7's disarm rule names it
 * explicitly. A current (>=0.5.0) reference registry rejects new interim-form
 * publishes outright, but this control plane must still recognize bodies that
 * already exist.
 *
 * This is the single source of truth for "is this a revocation context type?"
 * — the ingest gate (Phase 10), the discovery query, the lineage fold, and the
 * §7 disarm check (later phases) all import from here rather than each
 * carrying their own copy. A second, drifting definition of this predicate is
 * a correctness bug waiting to happen: the disarm clause depends on every
 * caller agreeing on exactly the same set.
 */

export const REVOCATION_CONTEXT_TYPE = 'key-revocation';
export const REVOCATION_CONTEXT_TYPE_INTERIM = 'acdp:key-revocation';

/** Both accepted spellings of the key-revocation context type (RFC-ACDP-0014 §4, §10). */
export const REVOCATION_CONTEXT_TYPES: ReadonlySet<string> = new Set([
  REVOCATION_CONTEXT_TYPE,
  REVOCATION_CONTEXT_TYPE_INTERIM,
]);

/**
 * True for either spelling of the key-revocation context type, exactly —
 * context types are lowercase on the wire and are never case-folded, so
 * `Key-Revocation` is not recognized (nor is `acdp:key_revocation`, which is
 * neither spelling).
 */
export function isRevocationContextType(contextType: string): boolean {
  return REVOCATION_CONTEXT_TYPES.has(contextType);
}
