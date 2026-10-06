/**
 * The principal fields `AuthGuard` pins on the request for downstream guards
 * (`PolicyGuard`, the federated `read_only` gate). All optional: a `@Public()`
 * route never sets them.
 */
export interface AuthenticatedActorFields {
  actorId?: string;
  actorDid?: string;
  actorType?: 'api-key' | 'jwt';
  actorIsAdmin?: boolean;
  /** Union of the JWT's scope / scopes / scp claims (see ./scopes.ts). */
  actorScopes?: string[];
  /** Verified `iss` of the JWT; unset for API-key callers. */
  actorIssuer?: string;
  /**
   * `true` iff the principal authenticated with a token vouched for by a
   * `TRUSTED_ISSUERS` entry (a federated principal); `false` for local JWTs
   * and API keys.
   */
  actorFederated?: boolean;
}
