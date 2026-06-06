/**
 * Cross-issuer revocation poller (reciprocal of `/auth/revocations`).
 *
 * The control plane already SERVES a revocation feed that peer registries
 * poll. This service is the other half: the CP POLLS each configured peer's
 * `/auth/revocations` feed and applies propagated revocations into its local
 * store, so a token a trusted issuer revokes is rejected here before its
 * natural expiry. Without this, a federated (trusted-issuer) token stayed
 * valid at the CP until `exp` even after the issuer revoked it.
 *
 * This is a faithful port of the registry's `revocation_poller.rs`:
 *   - Request:  GET <feed_url>?since=<cursor-ms>&limit=200
 *               Authorization: Bearer <admin_token>
 *   - Cursor:   per-issuer, unix-ms, persisted via the revocation repository
 *               so a restart resumes where it left off (idempotent revoke
 *               makes a re-fetch harmless if the cursor was lost).
 *   - Confine:  a feed entry whose `iss` is non-empty and differs from the
 *               configured issuer is DROPPED — a peer is only authoritative
 *               for its own tokens (cross-issuer injection guard).
 *   - Advance:  the cursor moves ONLY when every entry in the batch applied
 *               locally; a partial failure replays the page next tick.
 *   - Dead-letter: an entry with a malformed `exp` is logged and skipped
 *               (it can never apply), so one bad entry can't stall the feed.
 *
 * Only runs when token issuance is enabled (the revocation store exists) and
 * at least one feed is configured via `REVOCATION_FEEDS`.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import {
  parseRevocationFeeds,
  RevocationFeedConfig,
} from './revocation-feeds';
import {
  REVOCATION_REPOSITORY,
  RevocationRepository,
} from './revocation-repository';

interface FeedEntry {
  jti: string;
  sub: string;
  iss: string;
  exp: number;
  revoked_at_ms: number;
}

interface FeedResponse {
  entries: FeedEntry[];
  next_cursor: number | null;
}

/** Outcome of a single feed poll — returned for tests / diagnostics. */
export interface PollResult {
  fetched: number;
  applied: number;
  dropped: number;
  allSucceeded: boolean;
  cursor: number;
}

// The feed is small (<=200 entries/page) but a hostile/compromised peer
// shouldn't be able to stream an unbounded body into memory.
const MAX_FEED_BYTES = 1024 * 1024; // 1 MiB
const FETCH_TIMEOUT_MS = 15_000; // matches the registry poller's 15s

@Injectable()
export class RevocationPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RevocationPollerService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  /** In-memory cursor per issuer; seeded from the durable store on init. */
  private readonly cursors = new Map<string, number>();
  private feeds: RevocationFeedConfig[] = [];
  /** HTTP impl; swappable in tests via `setFetchImplForTest`. */
  private fetchImpl: typeof fetch = fetch;

  constructor(
    private readonly config: AppConfigService,
    @Inject(REVOCATION_REPOSITORY)
    private readonly revocations: RevocationRepository,
  ) {}

  /** Test seam: inject a fake fetch. Not used in production. */
  setFetchImplForTest(fn: typeof fetch): void {
    this.fetchImpl = fn;
  }

  async onModuleInit(): Promise<void> {
    this.feeds = parseRevocationFeeds(this.config.revocationFeedsRaw);
    if (this.feeds.length === 0) {
      this.logger.log('no REVOCATION_FEEDS configured; cross-issuer poller idle');
      return;
    }
    for (const feed of this.feeds) {
      // Restart-survival: resume from the persisted cursor. A null/error here
      // is non-fatal — starting at 0 re-fetches the full feed once, which is
      // correct (idempotent revoke + strict-greater-than upstream pagination).
      let cursor = 0;
      try {
        const persisted = await this.revocations.getRevocationCursor(feed.issuer);
        if (persisted !== null) {
          cursor = persisted;
          this.logger.log(
            `revocation poller resumed issuer=${feed.issuer} cursor=${cursor}`,
          );
        }
      } catch (e) {
        this.logger.warn(
          `failed to load revocation cursor for issuer=${feed.issuer}, ` +
            `starting at 0: ${msgOf(e)}`,
        );
      }
      this.cursors.set(feed.issuer, cursor);

      const ms = feed.pollSeconds * 1000;
      const timer = setInterval(() => {
        void this.pollFeed(feed);
      }, ms);
      if (typeof timer.unref === 'function') timer.unref();
      this.timers.push(timer);
      this.logger.log(
        `revocation poller started issuer=${feed.issuer} url=${feed.feedUrl} ` +
          `interval=${ms}ms`,
      );
      // Poll immediately so a revocation isn't missed for a whole interval.
      void this.pollFeed(feed);
    }
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  /**
   * Poll one feed once: fetch a page, apply it, and (on full success) advance
   * + persist the cursor. Never throws — a transport/HTTP error is logged and
   * the cursor is left untouched so the page retries next tick. Exposed for
   * tests so they can drive a poll without `setInterval`.
   */
  async pollFeed(feed: RevocationFeedConfig): Promise<PollResult> {
    const cursor = this.cursors.get(feed.issuer) ?? 0;
    let page: FeedResponse;
    try {
      page = await this.fetchOnce(feed, cursor);
    } catch (e) {
      this.logger.warn(
        `revocation feed poll failed issuer=${feed.issuer}: ${msgOf(e)} (will retry)`,
      );
      return { fetched: 0, applied: 0, dropped: 0, allSucceeded: false, cursor };
    }

    const { applied, dropped, allSucceeded } = await this.applyEntries(feed, page.entries);

    let newCursor = cursor;
    // Advance ONLY when every entry applied — a partial failure keeps the
    // cursor so the failed entry retries next tick.
    if (allSucceeded && typeof page.next_cursor === 'number') {
      newCursor = page.next_cursor;
      this.cursors.set(feed.issuer, newCursor);
      try {
        await this.revocations.setRevocationCursor(feed.issuer, newCursor);
      } catch (e) {
        // Advance in-memory anyway so this process doesn't refetch; a restart
        // would replay the page but revoke() is idempotent so it's harmless.
        this.logger.warn(
          `failed to persist revocation cursor issuer=${feed.issuer} ` +
            `cursor=${newCursor} (will replay on restart): ${msgOf(e)}`,
        );
      }
    }

    this.logger.log(
      `revocation feed poll issuer=${feed.issuer} fetched=${page.entries.length} ` +
        `applied=${applied} dropped=${dropped} allSucceeded=${allSucceeded} ` +
        `cursor=${newCursor}`,
    );
    return {
      fetched: page.entries.length,
      applied,
      dropped,
      allSucceeded,
      cursor: newCursor,
    };
  }

  private async fetchOnce(
    feed: RevocationFeedConfig,
    cursor: number,
  ): Promise<FeedResponse> {
    // Defense-in-depth even though feed_url is operator-configured: require
    // https outside development, refuse to auto-follow redirects (a redirect
    // could point at an internal target), bound the body, and bound the time.
    if (!this.config.isDevelopment && !feed.feedUrl.toLowerCase().startsWith('https://')) {
      throw new Error(`feed_url ${feed.feedUrl} must be https outside development`);
    }
    const url = new URL(feed.feedUrl);
    url.searchParams.set('since', String(cursor));
    url.searchParams.set('limit', '200');

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await this.fetchImpl(url.toString(), {
        signal: ctrl.signal,
        headers: {
          Accept: 'application/acdp+json, application/json',
          Authorization: `Bearer ${feed.adminToken}`,
        },
        redirect: 'manual',
      });
    } finally {
      clearTimeout(timeout);
    }
    if (resp.status >= 300 && resp.status < 400) {
      throw new Error(`feed ${feed.feedUrl} returned a redirect (refused)`);
    }
    if (!resp.ok) {
      throw new Error(`feed ${feed.feedUrl} returned HTTP ${resp.status}`);
    }
    const declared = Number(resp.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) {
      throw new Error(`feed ${feed.feedUrl} exceeds ${MAX_FEED_BYTES}-byte cap`);
    }
    const raw = new Uint8Array(await resp.arrayBuffer());
    if (raw.byteLength > MAX_FEED_BYTES) {
      throw new Error(`feed ${feed.feedUrl} exceeds ${MAX_FEED_BYTES}-byte cap`);
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder('utf-8').decode(raw));
    } catch {
      throw new Error(`feed ${feed.feedUrl} returned invalid JSON`);
    }
    return normalizeFeedResponse(json, feed.feedUrl);
  }

  /**
   * Apply each entry to the local revocation store. Returns counts plus
   * `allSucceeded` — true only when every entry either applied or was a
   * permanent dead-letter (issuer-confined / malformed `exp`). A transient
   * store error sets `allSucceeded=false` so the cursor holds.
   */
  private async applyEntries(
    feed: RevocationFeedConfig,
    entries: FeedEntry[],
  ): Promise<{ applied: number; dropped: number; allSucceeded: boolean }> {
    let applied = 0;
    let dropped = 0;
    let allSucceeded = true;
    for (const e of entries) {
      // Issuer-confinement (#7): only honor revocations the polled peer is
      // authoritative for. An entry attributed to a different issuer is
      // anomalous — drop it so one peer can't inject revocations labelled as
      // another. Empty `iss` is tolerated (the configured peer is the implicit
      // authority).
      if (e.iss && e.iss !== feed.issuer) {
        this.logger.warn(
          `revocation feed entry from foreign issuer dropped: ` +
            `feed=${feed.issuer} entry_iss=${e.iss} jti=${e.jti}`,
        );
        dropped++;
        continue;
      }
      // Dead-letter a malformed exp — permanent, so skip without holding the
      // cursor (holding would stall the whole feed on one bad entry).
      if (!Number.isFinite(e.exp) || e.exp <= 0) {
        this.logger.error(
          `revocation feed entry has malformed exp; dropping: ` +
            `issuer=${feed.issuer} jti=${e.jti} exp=${e.exp}`,
        );
        dropped++;
        continue;
      }
      try {
        await this.revocations.revoke({
          jti: e.jti,
          sub: e.sub,
          iss: e.iss || feed.issuer,
          exp: e.exp,
          revokedBy: `cross-issuer-poll:${feed.issuer}`,
          reason: 'unspecified',
        });
        applied++;
      } catch (err) {
        this.logger.warn(
          `failed to apply propagated revocation jti=${e.jti} ` +
            `issuer=${feed.issuer}; cursor will not advance this tick: ${msgOf(err)}`,
        );
        allSucceeded = false;
      }
    }
    return { applied, dropped, allSucceeded };
  }
}

/** Validate + coerce an untrusted feed payload into a typed response. */
function normalizeFeedResponse(json: unknown, url: string): FeedResponse {
  if (!json || typeof json !== 'object') {
    throw new Error(`feed ${url} payload is not an object`);
  }
  const obj = json as { entries?: unknown; next_cursor?: unknown };
  if (!Array.isArray(obj.entries)) {
    throw new Error(`feed ${url} payload has no entries array`);
  }
  const entries: FeedEntry[] = [];
  for (const raw of obj.entries) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.jti !== 'string' || r.jti.length === 0) continue;
    entries.push({
      jti: r.jti,
      sub: typeof r.sub === 'string' ? r.sub : '',
      iss: typeof r.iss === 'string' ? r.iss : '',
      exp: typeof r.exp === 'number' ? r.exp : Number(r.exp),
      revoked_at_ms:
        typeof r.revoked_at_ms === 'number' ? r.revoked_at_ms : Number(r.revoked_at_ms),
    });
  }
  const next =
    typeof obj.next_cursor === 'number' ? obj.next_cursor : null;
  return { entries, next_cursor: next };
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
