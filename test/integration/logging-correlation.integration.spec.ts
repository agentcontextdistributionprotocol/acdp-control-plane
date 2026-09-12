import { Logger } from '@nestjs/common';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { PinoLogger } from '../../src/common/pino-logger';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';

/**
 * Logging shape, end to end (#159).
 *
 * The unit specs prove `PinoLogger` assembles a line correctly. They cannot
 * prove the two things that actually broke, because both live in the WIRING:
 *
 *  1. that the HTTP summary line reaches pino as fields rather than as a
 *     JSON string stuffed into `msg`, and
 *  2. that a line logged deep inside a guard/service — not by the logging
 *     middleware, which reads `req` directly — carries the request's
 *     correlation id.
 *
 * (2) is the one worth an integration test: it depends on
 * `CorrelationIdMiddleware` running before the guards AND on
 * `AsyncLocalStorage` surviving into them, neither of which a unit test of
 * the logger can observe. This boots the real `AppModule`, so a regression
 * in `app.module.ts`'s `consumer.apply(...)` order fails here.
 */
describe('Logging correlation (integration)', () => {
  let ctx: TestAppContext;
  let logFile: string;

  // Supplied on the request so the assertions can select exactly this
  // request's lines out of a file the whole app is writing to.
  const REQUEST_ID = 'it-correlation-0001';
  const CONCURRENT_PREFIX = 'it-concurrent-';
  const CONCURRENT_IDS = Array.from({ length: 6 }, (_, i) => `${CONCURRENT_PREFIX}${i}`);

  beforeAll(async () => {
    ctx = await createTestApp({
      tenantApiKeys: [
        { tenantId: 'acme', apiKey: 'acme-key' },
        { tenantId: 'other', apiKey: 'other-key' },
      ],
    });
    logFile = join(tmpdir(), `acdp-logging-it-${process.pid}-${Date.now()}.log`);
    // Route the real application logger at a real pino destination we can
    // read back. `trace` because the harness pins LOG_LEVEL=warn.
    ctx.app.useLogger(
      new PinoLogger('trace', false, pino.destination({ dest: logFile, sync: true, mkdir: true })),
    );
  });

  afterAll(async () => {
    await ctx.app.close();
    rmSync(logFile, { force: true });
  });

  /** Every line in the log file, parsed. */
  const allLines = (): Array<Record<string, unknown>> =>
    readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  /** Every line written for REQUEST_ID, parsed. */
  const correlatedLines = (): Array<Record<string, unknown>> =>
    allLines().filter((l) => l.requestId === REQUEST_ID);

  it('correlates the HTTP summary and a guard-level log line to the same request', async () => {
    const client = new TestClient(ctx.url, 'acme-key');

    // A key bound to `acme` asserting `X-Tenant-Id: other` is refused by
    // AuthGuard, which warns on the way out. That warn is a service-level
    // line — the exact kind that was previously unattributable.
    const res = await client.requestRaw('GET', '/runs', {
      headers: { 'X-Tenant-Id': 'other', 'x-request-id': REQUEST_ID },
    });

    expect(res.status).toBe(403);
    expect(res.headers['x-request-id']).toBe(REQUEST_ID);

    const lines = correlatedLines();
    expect(lines.length).toBeGreaterThanOrEqual(2);

    // ── Defect 2: the guard's own line carries the correlation id ──
    const guardLine = lines.find((l) => l.context === 'AuthGuard');
    expect(guardLine).toBeDefined();
    expect(guardLine?.requestId).toBe(REQUEST_ID);
    expect(String(guardLine?.msg)).toContain('tenant assertion mismatch');

    // ── Defect 1: the HTTP summary is fields, not a stringified blob ──
    const httpLine = lines.find((l) => l.context === 'HTTP');
    expect(httpLine).toBeDefined();
    expect(httpLine?.method).toBe('GET');
    expect(httpLine?.path).toBe('/runs');
    expect(httpLine?.statusCode).toBe(403);
    expect(typeof httpLine?.durationMs).toBe('number');
    expect(httpLine?.requestId).toBe(REQUEST_ID);
    // The regression guard: `msg` must never again be a JSON document.
    expect(String(httpLine?.msg)).not.toMatch(/^\s*[{[]/);
    expect(String(httpLine?.msg)).toContain('GET /runs 403');
  });

  it('keeps correlation ids from bleeding between concurrent requests', async () => {
    // The property that makes AsyncLocalStorage worth using, and the one a
    // unit test cannot observe: under overlapping requests each line must
    // carry ITS OWN request's id. A regression here (a module-level
    // variable instead of a store, a context lost across an await) would
    // attribute log lines to the wrong request during an incident — worse
    // than having no id at all, because it reads as authoritative.
    const client = new TestClient(ctx.url, 'acme-key');
    // Overlapping in flight, not sequential — that is the point.
    const responses = await Promise.all(
      CONCURRENT_IDS.map((id) =>
        client.requestRaw('GET', '/runs', {
          headers: { 'X-Tenant-Id': 'other', 'x-request-id': id },
        }),
      ),
    );
    for (const [i, res] of responses.entries()) {
      expect(res.status).toBe(403);
      expect(res.headers['x-request-id']).toBe(CONCURRENT_IDS[i]);
    }

    const ids = allLines()
      .filter((l) => typeof l.requestId === 'string' && String(l.requestId).startsWith(CONCURRENT_PREFIX));
    expect(ids.length).toBeGreaterThanOrEqual(CONCURRENT_IDS.length * 2);

    for (const id of CONCURRENT_IDS) {
      const mine = ids.filter((l) => l.requestId === id);
      const guard = mine.filter((l) => l.context === 'AuthGuard');
      const http = mine.filter((l) => l.context === 'HTTP');
      // Exactly one of each — not zero (context lost) and not several
      // (one request's id leaking onto another's lines).
      expect(guard).toHaveLength(1);
      expect(http).toHaveLength(1);
      // The HTTP line reads `req` directly, the guard line reads the ALS.
      // They agreeing is the actual end-to-end claim.
      expect(http[0].requestId).toBe(guard[0].requestId);
    }
  });

  it('omits requestId on a line logged outside any request', () => {
    // What a background sweep (retention, receipt audit, the witness
    // pollers) looks like: the real Nest `Logger` facade, the real
    // installed PinoLogger, no ALS store.
    new Logger('SpecBackgroundProbe').log('sweep complete');

    const probe = allLines().filter((l) => l.context === 'SpecBackgroundProbe');
    expect(probe).toHaveLength(1);
    // Absent, not null and not a '-' placeholder: an absent field is
    // queryable in an aggregator, a placeholder is noise that looks real.
    expect(probe[0]).not.toHaveProperty('requestId');
    expect(probe[0].msg).toBe('sweep complete');
  });
});
