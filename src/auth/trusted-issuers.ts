/**
 * Trusted-issuer registry for cross-issuer JWT validation.
 *
 * Lets a single bearer-token validator accept tokens issued by
 * peer registries (the V2 "Seam IdP" experience — one challenge
 * yields a token usable across the federation). Closes deferred-plan §2.
 *
 * Config wire format: `TRUSTED_ISSUERS` is a comma-separated list of
 *
 *   HS256:   <iss>|HS256|<shared-secret>|<audience>[|scope[|flags]]
 *   EdDSA:   <iss>|EdDSA|<jwks-url>|<audience>[|scope[|flags]]
 *
 * `flags` is an optional whitespace-separated set from a closed vocabulary
 * (today only `read_only`: tokens from this issuer may use only GET/HEAD/OPTIONS,
 * enforced by AuthGuard — see TRUSTED_ISSUER_FLAGS). Leave `scope` empty to set
 * a flag without a scope: `iss|HS256|<secret>|<aud>||read_only`. More than six
 * fields, or an unknown/duplicate flag, fails startup. NB: a build older than
 * this field silently ignores the 6th field (a rollback drops `read_only`).
 *
 * `audience` is REQUIRED. `acdp-registry-rs` binds every token's `aud` to its
 * own authority as a federation replay defense (#16); accepting a peer's
 * tokens without verifying `aud` here would defeat that defense, so we refuse
 * to trust an issuer with no declared audience. Set it to the value the peer
 * stamps (its own authority), NOT this CP's authority.
 *
 * Examples:
 *
 *   TRUSTED_ISSUERS=registry-a|HS256|sharedsecretAAAA...|registry-a.example
 *   TRUSTED_ISSUERS=registry-b|EdDSA|https://registry-b.example/.well-known/jwks.json|registry-b.example
 *
 * The pipe-delimited format is deliberately ugly so reviewers notice
 * if a token is being trusted from somewhere unexpected.
 *
 * Audit policy: every accepted trusted-issuer token logs the `iss`
 * + `sub` + `jti` at INFO with `event=acdp.jwt.trusted_issuer_accept`
 * so operators can audit federation traffic.
 */

export type TrustedAlg = 'HS256' | 'EdDSA';

export interface TrustedIssuer {
  /** Value the JWT's `iss` claim must equal. */
  iss: string;
  alg: TrustedAlg;
  /** Shared secret for HS256 verification. ≥32 bytes per RFC 7518 §3.2. Unset for EdDSA. */
  secret?: string;
  /** JWKS URL for EdDSA verification. Unset for HS256. */
  jwksUrl?: string;
  /**
   * Required audience binding — the JWT's `aud` claim MUST match (string
   * equality for a string `aud`; membership for an array).
   *
   * NOTE on cross-issuer interop: `acdp-registry-rs` binds every token's
   * `aud` to *its own* authority (federation replay defense), NOT to the
   * consumer's. So to accept a peer registry's tokens here, set
   * `audience=<that registry's authority>` (the value it stamps) — not
   * this CP's authority, which would reject every peer token.
   */
  audience: string;
  /**
   * Optional space-separated required scopes. The union of the token's
   * `scope` / `scopes` / `scp` claims (see ./scopes.ts) MUST contain ALL
   * listed scopes for acceptance. NOT usable against ACDP registry peers:
   * the registry mints no scope claim, so setting this rejects every one of
   * their tokens.
   */
  requiredScope?: string;
  /**
   * Opt-in `read_only` flag (default `false`): tokens from this issuer are
   * denied every method except GET/HEAD/OPTIONS (`ISSUER_READ_ONLY`).
   */
  readOnly: boolean;
}

/** Closed vocabulary of the 6th (`flags`) field. */
export const TRUSTED_ISSUER_FLAGS = ['read_only'] as const;
export type TrustedIssuerFlag = (typeof TRUSTED_ISSUER_FLAGS)[number];

export class TrustedIssuerError extends Error {}

/**
 * Parse the 6th (`flags`) field; returns `readOnly`. Rejects unknown and
 * duplicate flags, and `read_only` mistakenly placed in the scope slot (the
 * positional footgun: `iss|alg|mat|aud|read_only` would otherwise be taken as
 * a required scope and 401 every token from that issuer).
 */
function parseFlags(
  iss: string,
  requiredScope: string | undefined,
  flagsRaw: string | undefined,
): boolean {
  const known = TRUSTED_ISSUER_FLAGS as readonly string[];
  if (requiredScope && requiredScope.split(/\s+/).some((t) => known.includes(t))) {
    throw new TrustedIssuerError(
      `TRUSTED_ISSUERS entry for iss='${iss}': a flag name appears in the scope field; ` +
        `flags go in the 6th field (iss|alg|material|audience||read_only — empty scope)`,
    );
  }
  const seen = new Set<string>();
  for (const token of (flagsRaw ?? '').split(/\s+/).filter(Boolean)) {
    if (!known.includes(token)) {
      throw new TrustedIssuerError(
        `TRUSTED_ISSUERS entry for iss='${iss}': unknown flag ` +
          `(allowed: ${TRUSTED_ISSUER_FLAGS.join(', ')}; case-sensitive)`,
      );
    }
    if (seen.has(token)) {
      throw new TrustedIssuerError(
        `TRUSTED_ISSUERS entry for iss='${iss}': duplicate flag '${token}'`,
      );
    }
    seen.add(token);
  }
  return seen.has('read_only');
}

/** Parse the `TRUSTED_ISSUERS` env value into a typed list. */
export function parseTrustedIssuers(raw: string): TrustedIssuer[] {
  const out: TrustedIssuer[] = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    // Errors never echo `entry` or any field value other than `iss`: an HS256
    // entry carries the shared secret, and a mis-ordered entry can put it in
    // any slot (a `|` inside the secret shifts a fragment into the flags slot).
    const parts = entry.split('|');
    if (parts.length < 4) {
      throw new TrustedIssuerError(
        `TRUSTED_ISSUERS entry for iss='${parts[0] ?? ''}' has ${parts.length} fields; ` +
          `minimum is iss|alg|material|audience`,
      );
    }
    if (parts.length > 6) {
      throw new TrustedIssuerError(
        `TRUSTED_ISSUERS entry for iss='${parts[0] ?? ''}' has ${parts.length} fields; ` +
          `maximum is iss|alg|material|audience|scope|flags`,
      );
    }
    const [iss, alg, material, audience, requiredScope, flagsRaw] = parts;
    if (!iss || !alg || !material) {
      throw new TrustedIssuerError(
        `TRUSTED_ISSUERS entry for iss='${iss ?? ''}' has an empty required field`,
      );
    }
    const readOnly = parseFlags(iss, requiredScope, flagsRaw);
    if (!audience) {
      throw new TrustedIssuerError(
        `TRUSTED_ISSUERS entry for iss='${iss}': audience is required ` +
          `(the peer binds aud to its own authority as a replay defense; ` +
          `set audience=<that authority>)`,
      );
    }
    if (alg === 'HS256') {
      if (Buffer.byteLength(material, 'utf8') < 32) {
        throw new TrustedIssuerError(
          `TRUSTED_ISSUERS entry for iss='${iss}': secret < 32 bytes (HS256 RFC 7518 §3.2)`,
        );
      }
      out.push({
        iss,
        alg: 'HS256',
        secret: material,
        audience,
        requiredScope: requiredScope || undefined,
        readOnly,
      });
    } else if (alg === 'EdDSA') {
      if (!/^https?:\/\//.test(material)) {
        throw new TrustedIssuerError(
          `TRUSTED_ISSUERS entry for iss='${iss}': EdDSA material must be an http(s) JWKS URL`,
        );
      }
      out.push({
        iss,
        alg: 'EdDSA',
        jwksUrl: material,
        audience,
        requiredScope: requiredScope || undefined,
        readOnly,
      });
    } else {
      throw new TrustedIssuerError(
        `TRUSTED_ISSUERS entry for iss='${iss}': unsupported alg (want HS256 or EdDSA)`,
      );
    }
  }
  return out;
}

/** Lookup by `iss` claim. Returns null when the issuer isn't trusted. */
export class TrustedIssuerRegistry {
  private readonly byIss: Map<string, TrustedIssuer>;

  constructor(issuers: TrustedIssuer[]) {
    this.byIss = new Map();
    for (const i of issuers) {
      if (this.byIss.has(i.iss)) {
        throw new TrustedIssuerError(`duplicate trusted issuer iss='${i.iss}'`);
      }
      this.byIss.set(i.iss, i);
    }
  }

  get(iss: string): TrustedIssuer | null {
    return this.byIss.get(iss) ?? null;
  }

  size(): number {
    return this.byIss.size;
  }

  list(): ReadonlyArray<TrustedIssuer> {
    return Array.from(this.byIss.values());
  }
}
