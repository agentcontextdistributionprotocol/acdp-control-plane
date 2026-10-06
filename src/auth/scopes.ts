/**
 * One scope vocabulary for the whole control plane (#225).
 *
 * JWTs carry scopes under three spellings across the ecosystem: the OAuth 2.0
 * space-delimited `scope` string (RFC 6749 §3.3 / RFC 8693), a `scopes` array,
 * and `scp` (a space-delimited string, or an array in some IdPs). The guard
 * (policy input) and the trusted-issuer `requiredScope` gate previously read
 * different subsets, so a scope the policy layer saw could be invisible to
 * the federation gate and vice versa. Both now go through `readScopes`.
 *
 * Note the ACDP registry mints NO scope claim at all, so a `requiredScope`
 * on a registry peer rejects every token (see docs/AUTH.md).
 */

/** Claim names read, in the order their members are first emitted. */
const SCOPE_CLAIMS = ['scope', 'scopes', 'scp'] as const;

function fromClaim(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) {
    return value.filter((s): s is string => typeof s === 'string' && s.length > 0);
  }
  return [];
}

/**
 * Union (order-preserving, de-duplicated) of the scopes in `scope`, `scopes`
 * and `scp`. Non-string members are ignored; absent claims give `[]`.
 */
export function readScopes(claims: unknown): string[] {
  if (!claims || typeof claims !== 'object') return [];
  const c = claims as Record<string, unknown>;
  const seen = new Set<string>();
  for (const name of SCOPE_CLAIMS) {
    for (const s of fromClaim(c[name])) seen.add(s);
  }
  return [...seen];
}

/** Parse a configured scope list (the `requiredScope` env string). */
export function parseScopeString(raw: string | undefined): string[] {
  return fromClaim(raw ?? '');
}
