/**
 * Parse an HTTP `Retry-After` header (RFC 9110 §10.2.3) into a delay in
 * milliseconds, measured from `nowMs`.
 *
 * Two wire forms are accepted:
 *   - delta-seconds  — a non-negative integer, e.g. `Retry-After: 30`
 *   - HTTP-date      — an absolute timestamp, e.g.
 *                      `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`
 *
 * Returns the delay in milliseconds (clamped to >= 0), or `null` when the
 * header is absent or cannot be parsed. Callers fall back to their normal
 * backoff schedule on `null`.
 */
export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (headerValue == null) return null;
  const trimmed = headerValue.trim();
  if (trimmed === '') return null;

  // delta-seconds: a bare non-negative integer.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  // HTTP-date: anything Date can parse to a finite epoch.
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }

  return null;
}
