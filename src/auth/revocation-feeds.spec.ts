import {
  DEFAULT_REVOCATION_POLL_SECONDS,
  parseRevocationFeeds,
  RevocationFeedError,
} from './revocation-feeds';

const URL_A = 'https://registry-a.example/auth/revocations';

describe('parseRevocationFeeds', () => {
  it('returns an empty list for an empty value', () => {
    expect(parseRevocationFeeds('')).toEqual([]);
    expect(parseRevocationFeeds('   ')).toEqual([]);
  });

  it('parses a minimal entry with the default poll interval', () => {
    const out = parseRevocationFeeds(`registry-a.example|${URL_A}|ADMINKEY`);
    expect(out).toEqual([
      {
        issuer: 'registry-a.example',
        feedUrl: URL_A,
        adminToken: 'ADMINKEY',
        pollSeconds: DEFAULT_REVOCATION_POLL_SECONDS,
      },
    ]);
  });

  it('parses an explicit poll interval', () => {
    const out = parseRevocationFeeds(`registry-a.example|${URL_A}|ADMINKEY|60`);
    expect(out[0]!.pollSeconds).toBe(60);
  });

  it('parses multiple comma-separated feeds', () => {
    const out = parseRevocationFeeds(
      `a.example|https://a.example/auth/revocations|KA,` +
        `b.example|https://b.example/auth/revocations|KB|30`,
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.issuer).toBe('a.example');
    expect(out[1]!.pollSeconds).toBe(30);
  });

  it('rejects too-few fields', () => {
    expect(() => parseRevocationFeeds('a.example|https://a.example/feed')).toThrow(
      RevocationFeedError,
    );
  });

  it('rejects an empty required field', () => {
    expect(() => parseRevocationFeeds(`a.example||ADMINKEY`)).toThrow(
      RevocationFeedError,
    );
  });

  it('rejects a non-http(s) feed URL', () => {
    expect(() =>
      parseRevocationFeeds('a.example|ftp://a.example/feed|KA'),
    ).toThrow(/must be an http\(s\) URL/);
  });

  it('rejects a duplicate issuer', () => {
    expect(() =>
      parseRevocationFeeds(
        `a.example|${URL_A}|KA,a.example|https://a2.example/feed|KB`,
      ),
    ).toThrow(/duplicate issuer/);
  });

  it('rejects a non-numeric or sub-1 poll interval', () => {
    expect(() =>
      parseRevocationFeeds(`a.example|${URL_A}|KA|nope`),
    ).toThrow(/poll_seconds/);
    expect(() =>
      parseRevocationFeeds(`a.example|${URL_A}|KA|0`),
    ).toThrow(/poll_seconds/);
  });
});
