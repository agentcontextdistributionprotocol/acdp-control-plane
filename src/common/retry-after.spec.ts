import { parseRetryAfterMs } from './retry-after';

describe('parseRetryAfterMs', () => {
  const NOW = Date.parse('2026-10-21T07:00:00.000Z');

  describe('absent / unparseable input → null', () => {
    it('returns null for null', () => {
      expect(parseRetryAfterMs(null, NOW)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(parseRetryAfterMs(undefined, NOW)).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(parseRetryAfterMs('', NOW)).toBeNull();
    });

    it('returns null for a whitespace-only string', () => {
      expect(parseRetryAfterMs('   ', NOW)).toBeNull();
    });

    it('returns null for non-numeric, non-date garbage', () => {
      expect(parseRetryAfterMs('soon', NOW)).toBeNull();
    });
  });

  describe('delta-seconds form', () => {
    it('converts a bare integer to milliseconds', () => {
      expect(parseRetryAfterMs('30', NOW)).toBe(30_000);
    });

    it('treats "0" as zero delay', () => {
      expect(parseRetryAfterMs('0', NOW)).toBe(0);
    });

    it('accepts leading zeros', () => {
      expect(parseRetryAfterMs('007', NOW)).toBe(7_000);
    });

    it('trims surrounding whitespace before parsing', () => {
      expect(parseRetryAfterMs('  15  ', NOW)).toBe(15_000);
    });
  });

  describe('HTTP-date form', () => {
    it('returns the delta to a future absolute timestamp', () => {
      const future = new Date(NOW + 90_000).toUTCString();
      expect(parseRetryAfterMs(future, NOW)).toBe(90_000);
    });

    it('clamps a past timestamp to 0 (never negative)', () => {
      const past = new Date(NOW - 60_000).toUTCString();
      expect(parseRetryAfterMs(past, NOW)).toBe(0);
    });

    it('parses an IMF-fixdate exactly at now as 0', () => {
      const exact = new Date(NOW).toUTCString();
      expect(parseRetryAfterMs(exact, NOW)).toBe(0);
    });
  });

  it('defaults nowMs to the current clock when omitted', () => {
    // A 0-second delta-seconds value is independent of the clock, so this is
    // deterministic even with the real Date.now() default.
    expect(parseRetryAfterMs('0')).toBe(0);
  });
});
