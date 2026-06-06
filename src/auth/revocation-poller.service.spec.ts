import { AppConfigService } from '../config/app-config.service';
import { InMemoryRevocationRepository } from './in-memory-revocation.repository';
import { RevocationFeedConfig } from './revocation-feeds';
import { RevocationPollerService } from './revocation-poller.service';

const ISSUER = 'peer.example';
const FEED_URL = 'https://peer.example/auth/revocations';
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

function feed(overrides: Partial<RevocationFeedConfig> = {}): RevocationFeedConfig {
  return {
    issuer: ISSUER,
    feedUrl: FEED_URL,
    adminToken: 'ADMIN',
    pollSeconds: 300,
    ...overrides,
  };
}

function fakeConfig(revocationFeedsRaw = ''): AppConfigService {
  return { revocationFeedsRaw, isDevelopment: false } as unknown as AppConfigService;
}

/** Build a fetch-compatible Response for a JSON body. */
function jsonResponse(
  body: unknown,
  opts: { status?: number; contentLength?: string } = {},
): Response {
  const status = opts.status ?? 200;
  const buf = new TextEncoder().encode(JSON.stringify(body));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (h: string) =>
        h.toLowerCase() === 'content-length'
          ? (opts.contentLength ?? String(buf.byteLength))
          : null,
    },
    arrayBuffer: async () => buf.buffer,
  } as unknown as Response;
}

function makePoller(
  repo = new InMemoryRevocationRepository(),
  fetchImpl: typeof fetch = jest.fn(),
  config = fakeConfig(),
): { poller: RevocationPollerService; repo: InMemoryRevocationRepository; fetchImpl: typeof fetch } {
  const poller = new RevocationPollerService(config, repo);
  poller.setFetchImplForTest(fetchImpl);
  return { poller, repo, fetchImpl };
}

describe('RevocationPollerService.pollFeed', () => {
  it('applies entries, advances and persists the cursor on full success', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        entries: [
          { jti: 'j1', sub: 'did:web:bob', iss: ISSUER, exp: FUTURE, revoked_at_ms: 1000 },
        ],
        next_cursor: 1000,
      }),
    );
    const { poller, repo } = makePoller(undefined, fetchImpl);

    const res = await poller.pollFeed(feed());

    expect(res.applied).toBe(1);
    expect(res.dropped).toBe(0);
    expect(res.allSucceeded).toBe(true);
    expect(res.cursor).toBe(1000);
    expect(await repo.isRevoked('j1')).toBe(true);
    expect(await repo.getRevocationCursor(ISSUER)).toBe(1000);
  });

  it('sends since=<cursor>&limit=200 and a Bearer admin token', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({ entries: [], next_cursor: null }));
    const { poller } = makePoller(undefined, fetchImpl);

    await poller.pollFeed(feed());

    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toContain('since=0');
    expect(url).toContain('limit=200');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ADMIN');
    expect(init.redirect).toBe('manual');
  });

  it('drops entries attributed to a foreign issuer (confinement)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        entries: [
          { jti: 'good', sub: 'a', iss: ISSUER, exp: FUTURE, revoked_at_ms: 1 },
          { jti: 'evil', sub: 'b', iss: 'attacker.example', exp: FUTURE, revoked_at_ms: 2 },
        ],
        next_cursor: 2,
      }),
    );
    const { poller, repo } = makePoller(undefined, fetchImpl);

    const res = await poller.pollFeed(feed());

    expect(res.applied).toBe(1);
    expect(res.dropped).toBe(1);
    expect(res.allSucceeded).toBe(true); // a drop is not a failure
    expect(await repo.isRevoked('good')).toBe(true);
    expect(await repo.isRevoked('evil')).toBe(false);
    expect(res.cursor).toBe(2); // cursor still advances past a dropped entry
  });

  it('tolerates an empty iss (implicit peer authority)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        entries: [{ jti: 'j', sub: 'a', iss: '', exp: FUTURE, revoked_at_ms: 1 }],
        next_cursor: 1,
      }),
    );
    const { poller, repo } = makePoller(undefined, fetchImpl);

    await poller.pollFeed(feed());
    expect(await repo.isRevoked('j')).toBe(true);
  });

  it('dead-letters an entry with a malformed exp (skip, cursor still advances)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        entries: [{ jti: 'bad', sub: 'a', iss: ISSUER, exp: 0, revoked_at_ms: 1 }],
        next_cursor: 9,
      }),
    );
    const { poller, repo } = makePoller(undefined, fetchImpl);

    const res = await poller.pollFeed(feed());
    expect(res.applied).toBe(0);
    expect(res.dropped).toBe(1);
    expect(res.allSucceeded).toBe(true);
    expect(res.cursor).toBe(9);
    expect(await repo.isRevoked('bad')).toBe(false);
  });

  it('holds the cursor when a revoke fails (partial failure replays the page)', async () => {
    const repo = new InMemoryRevocationRepository();
    jest.spyOn(repo, 'revoke').mockRejectedValue(new Error('store down'));
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        entries: [{ jti: 'j', sub: 'a', iss: ISSUER, exp: FUTURE, revoked_at_ms: 1 }],
        next_cursor: 5000,
      }),
    );
    const { poller } = makePoller(repo, fetchImpl);

    const res = await poller.pollFeed(feed());
    expect(res.allSucceeded).toBe(false);
    expect(res.cursor).toBe(0); // unchanged
    expect(await repo.getRevocationCursor(ISSUER)).toBeNull();
  });

  it('never throws on a transport error; leaves the cursor untouched', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { poller, repo } = makePoller(undefined, fetchImpl);

    const res = await poller.pollFeed(feed());
    expect(res.allSucceeded).toBe(false);
    expect(res.cursor).toBe(0);
    expect(await repo.getRevocationCursor(ISSUER)).toBeNull();
  });

  it('treats a non-2xx feed response as a failure (no throw, cursor held)', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'nope' }, { status: 500 }));
    const { poller } = makePoller(undefined, fetchImpl);

    const res = await poller.pollFeed(feed());
    expect(res.allSucceeded).toBe(false);
    expect(res.cursor).toBe(0);
  });

  it('refuses a redirect response (SSRF defense)', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({}, { status: 302 }));
    const { poller } = makePoller(undefined, fetchImpl);

    const res = await poller.pollFeed(feed());
    expect(res.allSucceeded).toBe(false);
  });

  it('requires https outside development', async () => {
    const fetchImpl = jest.fn();
    const { poller } = makePoller(undefined, fetchImpl);

    const res = await poller.pollFeed(feed({ feedUrl: 'http://peer.example/auth/revocations' }));
    expect(res.allSucceeded).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('RevocationPollerService lifecycle', () => {
  afterEach(() => jest.useRealTimers());

  it('resumes from the persisted cursor on init', async () => {
    const repo = new InMemoryRevocationRepository();
    await repo.setRevocationCursor(ISSUER, 7000);
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({ entries: [], next_cursor: null }));
    const raw = `${ISSUER}|${FEED_URL}|ADMIN|300`;
    const { poller } = makePoller(repo, fetchImpl, fakeConfig(raw));

    await poller.onModuleInit();
    // Let the fire-and-forget immediate poll settle, then stop timers.
    await new Promise((r) => setImmediate(r));
    poller.onModuleDestroy();

    // Every fetch so far must have carried since=7000 (resumed cursor).
    for (const [url] of (fetchImpl as jest.Mock).mock.calls) {
      expect(url).toContain('since=7000');
    }
    expect((fetchImpl as jest.Mock).mock.calls.length).toBeGreaterThan(0);
  });

  it('stays idle (no timers, no fetch) when no feeds are configured', async () => {
    const fetchImpl = jest.fn();
    const { poller } = makePoller(undefined, fetchImpl, fakeConfig(''));
    await poller.onModuleInit();
    await new Promise((r) => setImmediate(r));
    poller.onModuleDestroy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
