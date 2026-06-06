/**
 * Cross-issuer revocation feed configuration.
 *
 * The reciprocal of the control plane's own `/auth/revocations` feed: these
 * are the PEER feeds this CP polls, so a token a trusted issuer revokes is
 * rejected here before its natural expiry. Mirrors the registry's
 * `RevocationFeedConfig` (acdp-registry-types/src/config.rs) and its
 * `revocation_poller.rs` consumer contract exactly:
 *
 *   GET <feed_url>?since=<cursor-ms>&limit=200
 *   Authorization: Bearer <admin_token>
 *
 * Config wire format: `REVOCATION_FEEDS` is a comma-separated list of
 *
 *   <issuer>|<feed_url>|<admin_token>[|poll_seconds]
 *
 * where:
 *   - `issuer`      — the value the peer stamps as `iss` on the tokens it
 *                     mints. Used for issuer-confinement: a feed entry
 *                     attributed to a DIFFERENT issuer is dropped (a peer is
 *                     only authoritative for its own tokens). MUST match a
 *                     `TRUSTED_ISSUERS` entry's `iss` for the imported
 *                     revocations to actually gate that issuer's tokens.
 *   - `feed_url`    — the peer's `/auth/revocations` URL (https in prod).
 *   - `admin_token` — an api key with admin role on the peer (its feed is
 *                     admin-gated). The V1 trust model is one shared admin
 *                     key per peer.
 *   - `poll_seconds`— optional poll interval; default 300.
 *
 * Examples:
 *
 *   REVOCATION_FEEDS=registry-a.example|https://registry-a.example/auth/revocations|ADMINKEY
 *   REVOCATION_FEEDS=registry-a.example|https://registry-a.example/auth/revocations|ADMINKEY|60
 *
 * The pipe-delimited format is deliberately ugly (matching TRUSTED_ISSUERS) so
 * reviewers notice when a peer's revocations are being trusted.
 */

export const DEFAULT_REVOCATION_POLL_SECONDS = 300;

export interface RevocationFeedConfig {
  /** Peer's `iss` — the only issuer whose entries this feed may revoke. */
  issuer: string;
  /** Peer's `/auth/revocations` URL. */
  feedUrl: string;
  /** Admin api key presented as `Authorization: Bearer <admin_token>`. */
  adminToken: string;
  /** Poll interval in seconds. */
  pollSeconds: number;
}

export class RevocationFeedError extends Error {}

/** Parse the `REVOCATION_FEEDS` env value into a typed list. */
export function parseRevocationFeeds(raw: string): RevocationFeedConfig[] {
  const out: RevocationFeedConfig[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const parts = entry.split('|');
    if (parts.length < 3) {
      throw new RevocationFeedError(
        `REVOCATION_FEEDS entry '${entry}' has ${parts.length} fields; ` +
          `minimum is issuer|feed_url|admin_token`,
      );
    }
    const [issuer, feedUrl, adminToken, pollRaw] = parts;
    if (!issuer || !feedUrl || !adminToken) {
      throw new RevocationFeedError(
        `REVOCATION_FEEDS entry '${entry}' has an empty required field`,
      );
    }
    if (!/^https?:\/\//.test(feedUrl)) {
      throw new RevocationFeedError(
        `REVOCATION_FEEDS entry for issuer='${issuer}': feed_url must be an ` +
          `http(s) URL (got '${feedUrl}')`,
      );
    }
    if (seen.has(issuer)) {
      throw new RevocationFeedError(
        `REVOCATION_FEEDS has a duplicate issuer='${issuer}'`,
      );
    }
    seen.add(issuer);
    let pollSeconds = DEFAULT_REVOCATION_POLL_SECONDS;
    if (pollRaw !== undefined && pollRaw !== '') {
      const parsed = Number(pollRaw);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new RevocationFeedError(
          `REVOCATION_FEEDS entry for issuer='${issuer}': poll_seconds must be ` +
            `a number >= 1 (got '${pollRaw}')`,
        );
      }
      pollSeconds = Math.floor(parsed);
    }
    out.push({ issuer, feedUrl, adminToken, pollSeconds });
  }
  return out;
}
