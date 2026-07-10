# Authentication, Issuance & Federation

This document covers how the control plane authenticates callers, issues its own
bearer tokens, accepts tokens from federated peers, and propagates revocation.
Endpoint shapes live in [API.md](./API.md#auth); tenancy in [TENANCY.md](./TENANCY.md).

> **This model mirrors the registry.** The CP's challenge-response, JWT claims,
> signing algorithms, and revocation federation are deliberately the same as the
> registry's so agent code and tokens are interchangeable. The authoritative
> description of that shared model is the registry's
> [AUTHENTICATION.md](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/AUTHENTICATION.md).
> The normative wire rules are [RFC-ACDP-0001 §5.8](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/tree/main/rfcs)
> (agent auth) and the [signature-algorithms registry](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/tree/main/registries).
> This page documents only what is **CP-specific** (how those rules are wired,
> issuance ledger, persistence, the guard).

All protocol crypto (Ed25519 / ECDSA-P256 verification, did:web resolution, SSRF
classification) comes from the [`acdp` SDK](https://github.com/agentcontextdistributionprotocol/acdp-rs)
(Rust `acdp-rs` via NAPI), wrapped thinly in `src/auth/` — never hand-rolled. The
SSRF defenses the did:web resolver inherits are documented in
[acdp-rs · Security](https://github.com/agentcontextdistributionprotocol/acdp-rs/blob/main/docs/security.md).

## The guard (`AuthGuard`)

`AuthGuard` is the first of the four global guards. For every non-`@Public()`
request it:

1. Reads `Authorization`. `@Public()` routes skip auth entirely
   (`/ingest/acdp`, `/ingest/health`, `POST /runs/started`,
   `POST /runs/:runId/complete` — both HMAC-authenticated like ingest —
   `/auth/challenge`, `/auth/token`, `/.well-known/jwks.json`,
   `/log/witness`, `/.well-known/acdp-witness.json`, `/.well-known/did.json`,
   `/healthz`, `/readyz`, `/metrics`).
2. **Dispatches on token shape** — a string with two dots / three base64url
   segments is treated as a JWT; anything else as an opaque API key. There is no
   cross-fallback (a rejected JWT never falls through to API-key matching — an
   oracle defense).
3. Pins request state used downstream: `req.tenantId`, `req.actorId`,
   `req.actorDid`, `req.actorType` (`'jwt'` | `'api-key'`), `req.actorScopes`,
   `req.actorIsAdmin`.

### API-key path

- Constant-time membership test against `AUTH_API_KEYS`.
- `req.actorIsAdmin` = key ∈ `AUTH_ADMIN_API_KEYS` (constant-time).
- Tenant: a key bound in `TENANT_API_KEYS` resolves to its tenant; a bare key →
  `default`. A mismatching `X-Tenant-Id` is rejected (`403`).
- When `AUTH_API_KEYS` is empty and not in production, auth is bypassed (dev
  convenience); with `AUTH_REQUIRE_TENANT=true` an unresolvable tenant is `403`.

### JWT path

Delegates to `CrossIssuerValidatorService.verify(token)`, which dispatches on the
`iss` claim (local issuer vs trusted peer — see [Federation](#federation)). On
success it sets `actorDid = sub`, `actorScopes` (OAuth `scope`/`scopes` claim),
and resolves the tenant from the signed `tenant` claim. JWTs cannot be admin
today (admin is API-key-gated).

Tenant precedence and the reserved-`default` rule are detailed in
[TENANCY.md](./TENANCY.md#how-the-guard-resolves-the-tenant).

## Token issuance (challenge → token)

Enabled by `TOKEN_ISSUANCE_ENABLED=true`. A mirror of the registry's
challenge-response so agent code is reusable.

```
Agent                                   Control Plane
  │  POST /auth/challenge {agent_id}          │
  │ ─────────────────────────────────────────►│  mint nonce + signing_input,
  │                                            │  persist challenge (TTL = CHALLENGE_TTL_SECONDS)
  │  ◄─────────────────────────────────────────│  { nonce, signing_input, expires_at }
  │                                            │
  │  sign signing_input with pinned key        │
  │  POST /auth/token {nonce, signature, …}    │
  │ ─────────────────────────────────────────►│  consume nonce atomically,
  │                                            │  resolve public key (pinned → did:web),
  │                                            │  algorithm-match + verify signature,
  │                                            │  mint short-lived JWT (TTL = JWT_TTL_SECONDS)
  │  ◄─────────────────────────────────────────│  { token, token_type, expires_at }
```

- **Signing input** (canonical, ASCII):
  `acdp-registry-auth:v1:<nonce>:<agent_did>:<authority>:<expires_at>`. This
  namespaced format is the registry's — see
  [AUTHENTICATION.md → "The signing input is namespaced"](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/AUTHENTICATION.md);
  the CP uses it verbatim so an agent signs the same bytes for either peer.
- **Key resolution**: `PinnedKeysService.get(agentDid)` first (local emergency
  control, with optional validity window); for `did:web:` subjects, falls back to
  `DidWebResolverService` (SSRF-gated). No key → `401`.
- **Downgrade defense**: the request `algorithm` must match the pinned key's
  algorithm.
- **Atomic nonce consumption**: on Postgres, `DELETE … RETURNING` so a nonce is
  single-use even under concurrency.
- **Audit**: every decision — `mint` or `reject_*` (alg, nonce, agent mismatch,
  expires mismatch, unpinned, signature, internal) — is appended to the
  **issuance ledger** (a SHA-256 hash chain; `IssuanceLedgerService`).

### Issued JWT claims

```json
{
  "iss": "control-plane.local",          // JWT_AUTHORITY
  "sub": "did:web:cp.example.com:agents:alice",
  "aud": "control-plane.local",          // JWT_AUDIENCE (defaults to authority)
  "jti": "<random>",
  "iat": 1716661234,
  "nbf": 1716661234,
  "exp": 1716665000,                      // iat + JWT_TTL_SECONDS
  "acdp": { "registry": "control-plane.local", "key_id": "key-1" },
  "tenant": "tenant-a"                     // from TENANT_AGENTS; absent → default
}
```

### Signing algorithms

| `JWT_SIGNING_ALG` | Key material | JWKS output |
|-------------------|--------------|-------------|
| `HS256` (default) | `JWT_SECRET` (≥32 bytes, validated at boot) | `{ "keys": [] }` (no public material) |
| `EdDSA` | `JWT_PRIVATE_KEY_PEM` (Ed25519 PKCS8) | `OKP`/`Ed25519` public JWK |

`kid` is `JWT_KID` if set, else derived from a stable fingerprint of the key
material. It is embedded in the JWT header and published in JWKS so verifiers can
match. The supported signature algorithms are governed by the spec's
[signature-algorithms registry](https://github.com/agentcontextdistributionprotocol/agentcontextdistributionprotocol/tree/main/registries);
the CP accepts exactly the set the SDK verifies.

> **Witness signing key is separate.** When witness cosigning
> (RFC-ACDP-0015) is enabled, checkpoint cosignatures are minted with a
> **dedicated** Ed25519 key (`WITNESS_SIGNING_PRIVATE_KEY_PEM`, identity
> `WITNESS_ID`, published via `/.well-known/did.json`) — never the JWT
> issuance key above. The two identities must not share key material; see
> [CONFIGURATION.md](./CONFIGURATION.md#transparency-log-witnessing-rfc-acdp-0012--rfc-acdp-0015).

## Pinned keys

`CONTROL_PLANE_PINNED_KEYS` maps agent DIDs → public keys for signature
verification and as a local emergency-revocation lever (drop a key to stop
issuing to that agent). Format (comma-separated entries):

```
<agent_did>=<base64_key>[:<algorithm>][:<validFrom>..<validUntil>]
```

`algorithm` defaults to `ed25519`; the optional unix-seconds window bounds
validity. Reload at runtime (no restart) via `POST /admin/pinned-keys/reload`
(admin-only) — it re-reads the env and atomically swaps the in-memory directory.

## Federation (trusted external issuers)

`CrossIssuerValidatorService` accepts JWTs from peers listed in
`TRUSTED_ISSUERS`. Dispatch is by `iss`:

- `iss == JWT_AUTHORITY` → verified locally.
- `iss ∈ TRUSTED_ISSUERS` → verified with that issuer's material.
- otherwise → rejected.

**Wire format** (comma-separated entries):

```
# HS256 peer:  <iss>|HS256|<shared-secret>|<audience>[|scope]
# EdDSA peer:  <iss>|EdDSA|<jwks-url>|<audience>[|scope]
```

- `audience` is **required** per entry — the token's `aud` must match the peer's
  binding (a replay defense; a token minted for peer A cannot be replayed at B).
- EdDSA peers' keys are fetched from `<jwks-url>` by a minimal hardened JWKS
  client (HTTPS-only, no redirects, 5 s timeout, 64 KiB cap; 5-min success cache,
  30-s error cache; in-flight de-dup). Only `OKP`/`Ed25519` keys are admitted.

The same federation path backs `POST /auth/introspect`, so introspection covers
both local and peer tokens.

## Revocation (bidirectional)

A token is invalid before `exp` if its `jti` is revoked. The verify hot-path
calls a single `isRevoked(jti)` that honors **both** locally-revoked and
peer-propagated revocations. This is the same bidirectional model the registry
runs — see [AUTHENTICATION.md → "Cross-issuer revocation federation"](https://github.com/agentcontextdistributionprotocol/acdp-registry-rs/blob/main/docs/AUTHENTICATION.md);
the feed format and issuer-confinement rule are shared.

**This CP serves** `GET /auth/revocations` (admin-only, cursor-paginated) so
peers can poll our revocations.

**This CP consumes** peer feeds configured in `REVOCATION_FEEDS`:

```
<issuer>|<feed_url>|<admin_token>[|<poll_seconds>]
```

`RevocationPollerService` polls each feed (`GET <feed_url>?since=<cursor>&limit=200`,
bearer `<admin_token>`), with:

- **Issuer confinement** — entries whose `iss` ≠ the feed's issuer are dropped (a
  peer can only revoke its own tokens).
- **Durable per-issuer cursor** — persisted in `revocation_cursors`; advanced
  only when every entry in a batch applied, so partial failures replay.
- **Idempotent apply** into the local revocation store.

Local revocation is driven by `POST /auth/token/revoke` (admin or self-revoke,
RFC 7009 — always `200`, no oracle).

## Persistence & sweeping

| `AUTH_PERSISTENCE` | Challenges / revocations / ledger | Use |
|--------------------|-----------------------------------|-----|
| `memory` (default) | per-process, lost on restart | single-process dev/test |
| `postgres` | shared tables (`auth_challenges`, `revoked_tokens`, `revocation_cursors`, `issuance_ledger`) | **required** for multi-instance |

`AuthSweeperService` runs every `AUTH_SWEEP_INTERVAL_SECONDS` (default 300; `≤0`
disables) and evicts expired challenges and revocations. The issuance ledger is
append-only and verified as a hash chain on graceful shutdown.

> In production, `TOKEN_ISSUANCE_ENABLED=true` + `AUTH_PERSISTENCE=memory` logs a
> warning: nonces and the revocation list would not be shared across replicas,
> reopening replay windows. Use `postgres`.

## Config quick reference

See [CONFIGURATION.md](./CONFIGURATION.md#authentication--issuance) for the full
table. The auth-relevant keys: `AUTH_API_KEYS`, `AUTH_ADMIN_API_KEYS`,
`AUTH_REQUIRE_TENANT`, `AUTH_PERSISTENCE`, `AUTH_SWEEP_INTERVAL_SECONDS`,
`TOKEN_ISSUANCE_ENABLED`, `JWT_SECRET`, `JWT_SIGNING_ALG`, `JWT_PRIVATE_KEY_PEM`,
`JWT_KID`, `JWT_AUTHORITY`, `JWT_AUDIENCE`, `JWT_TTL_SECONDS`,
`CHALLENGE_TTL_SECONDS`, `CONTROL_PLANE_PINNED_KEYS`, `TRUSTED_ISSUERS`,
`REVOCATION_FEEDS`.
</content>
