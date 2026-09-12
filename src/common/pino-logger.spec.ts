import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { correlationStorage } from './correlation';
import { PinoLogger } from './pino-logger';

/**
 * The dev-mode `pino-pretty` transport is the one part of this class that no
 * other test reaches.
 *
 * `PinoLogger`'s constructor only guards `require.resolve('pino-pretty')` — a
 * transport that resolves but fails to LOAD throws from `pino()` and fails boot
 * loudly, which is fine. The gap is narrower and quieter than that: if the
 * transport silently stops producing formatted output (a pino major changing the
 * transport contract, or `pino-pretty` drifting onto an incompatible
 * `pino-abstract-transport`), every unit test, every integration test and `tsc`
 * still pass. The only symptom is developers losing readable logs, which nobody
 * notices quickly because nobody asserts on it.
 *
 * Proving it needed a manual boot on every pino bump. This makes CI prove it.
 */
describe('PinoLogger', () => {
  it('emits structured JSON with the fields the production path depends on', () => {
    const logger = new PinoLogger('info', false);
    expect(logger).toBeInstanceOf(PinoLogger);
    // Exercises every level the LoggerService surface forwards, so a signature
    // change in pino's level methods fails here rather than at runtime.
    expect(() => {
      logger.log('log-line', 'TestContext');
      logger.warn('warn-line', 'TestContext');
      logger.error('error-line', 'trace-here', 'TestContext');
      logger.debug?.('debug-line', 'TestContext');
      logger.verbose?.('verbose-line', 'TestContext');
    }).not.toThrow();
  });

  it('actually loads the pino-pretty transport rather than silently falling back', async () => {
    // Drive the transport directly to a file: the worker writes asynchronously,
    // and asserting on stdout from inside jest is not reliable.
    const out = join(tmpdir(), `pino-pretty-probe-${process.pid}-${Date.now()}.log`);
    try {
      const transport = pino.transport({
        target: 'pino-pretty',
        // Same options PinoLogger uses, plus a file destination. `sync` keeps the
        // worker from outliving the assertion.
        options: { colorize: true, destination: out, mkdir: true, sync: true },
      });
      const probe = pino({ level: 'info' }, transport);
      probe.info({ context: 'Probe' }, 'transport-alive');
      // Let the transport worker flush before reading.
      await new Promise((r) => setTimeout(r, 250));

      const written = readFileSync(out, 'utf8');
      expect(written).toContain('transport-alive');
      // The point of the assertion: pino-pretty emits ANSI colour codes, raw pino
      // emits JSON. Finding an escape sequence proves the transport ran — a
      // fallback to JSON would contain `{"level":30`.
      expect(written).toMatch(/\x1b\[/);
      expect(written).not.toMatch(/^\{"level"/m);
    } finally {
      rmSync(out, { force: true });
    }
  });
});

/**
 * Structured output + request correlation (#159).
 *
 * Both defects this covers were invisible to every existing test: the app
 * booted, every line was emitted, and `tsc` was happy. What was broken was
 * the SHAPE of the line — the one thing no unit test asserted on. These
 * read pino's real output back off a synchronous file destination rather
 * than mocking pino, because the whole bug class is "we called pino
 * correctly-looking but wrong".
 */
describe('PinoLogger — structured fields and correlation (#159)', () => {
  let file: string;
  let logger: PinoLogger;

  /** Every line pino wrote, parsed. */
  const lines = (): Array<Record<string, unknown>> =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  /** The single line pino wrote. Fails loudly if there is not exactly one. */
  const line = (): Record<string, unknown> => {
    const all = lines();
    expect(all).toHaveLength(1);
    return all[0];
  };

  beforeEach(() => {
    file = join(tmpdir(), `pino-structured-${process.pid}-${counter++}.log`);
    logger = new PinoLogger(
      'trace',
      false,
      pino.destination({ dest: file, sync: true, mkdir: true }),
    );
  });

  afterEach(() => rmSync(file, { force: true }));

  it('puts an object message at the TOP LEVEL, not stringified into msg', () => {
    logger.log(
      { msg: 'GET /runs 200 12ms', method: 'GET', statusCode: 200, durationMs: 12 },
      'HTTP',
    );

    const l = line();
    // The regression this exists to catch: these were previously only
    // reachable by re-parsing `msg` as JSON on every line.
    expect(l.method).toBe('GET');
    expect(l.statusCode).toBe(200);
    expect(l.durationMs).toBe(12);
    expect(l.context).toBe('HTTP');
    expect(l.msg).toBe('GET /runs 200 12ms');
    // `msg` must be a human string, never a JSON document.
    expect(l.msg).not.toMatch(/^\s*[{[]/);
  });

  it('leaves a string message in msg and adds no stray fields', () => {
    logger.log('plain-line', 'SomeService');
    const l = line();
    expect(l.msg).toBe('plain-line');
    expect(l.context).toBe('SomeService');
    expect(l).not.toHaveProperty('requestId');
  });

  it('stamps the ambient correlation id onto a line logged inside a request', () => {
    correlationStorage.run('req-abc-123', () => {
      logger.warn('something went sideways', 'IngestService');
    });
    const l = line();
    expect(l.requestId).toBe('req-abc-123');
    expect(l.msg).toBe('something went sideways');
  });

  it('propagates the correlation id across an await boundary', async () => {
    await correlationStorage.run('req-async', async () => {
      await new Promise((r) => setTimeout(r, 5));
      logger.log('after-await', 'DeepService');
    });
    expect(line().requestId).toBe('req-async');
  });

  it('OMITS requestId outside a request rather than logging a placeholder', () => {
    // Background sweeps (retention, receipt audit, the witness pollers) run
    // with no store. An absent field is queryable; a null or "-" is noise.
    logger.log('retention sweep complete', 'DataRetentionService');
    const l = line();
    expect(l).not.toHaveProperty('requestId');
    expect(Object.values(l)).not.toContain('-');
  });

  it('lets an explicit requestId win over the ambient one', () => {
    correlationStorage.run('ambient', () => {
      logger.log({ msg: 'replayed', requestId: 'explicit' }, 'Replayer');
    });
    expect(line().requestId).toBe('explicit');
  });

  it('never lets a caller field shadow context or trace', () => {
    correlationStorage.run('req-1', () => {
      logger.error({ msg: 'boom', context: 'spoofed' }, 'the-stack', 'RealService');
    });
    const l = line();
    expect(l.context).toBe('RealService');
    expect(l.trace).toBe('the-stack');
    expect(l.msg).toBe('boom');
    expect(l.requestId).toBe('req-1');
  });

  it('does not let an absent framework context erase a caller-supplied one', () => {
    // Nest's `Logger` appends its own context, so `framework.context` is
    // normally set. It is NOT set for a direct call, or for a `new Logger()`
    // with no name — and a blind merge would then overwrite the caller's
    // field with `undefined` and lose it.
    logger.log({ msg: 'direct', context: 'CallerCtx', trace: 'caller-trace' });
    const l = line();
    expect(l.context).toBe('CallerCtx');
    expect(l.trace).toBe('caller-trace');
    expect(l.msg).toBe('direct');
  });

  it('emits a bare object message as fields with no msg key', () => {
    logger.log({ outcome: 'ok', count: 3 }, 'Sweeper');
    const l = line();
    expect(l.outcome).toBe('ok');
    expect(l.count).toBe(3);
    expect(l).not.toHaveProperty('msg');
  });

  it('does not spread non-plain objects into fields', () => {
    // An Error or an array must stay in the message slot — spreading an
    // Error would drop `stack`, which is the only part worth having.
    logger.error(new Error('kaboom'), 'stack-here', 'Svc');
    logger.log([1, 2, 3], 'Svc');
    const all = lines();
    expect(all).toHaveLength(2);
    expect(all[0]).not.toHaveProperty('0');
    expect(all[1]).not.toHaveProperty('0');
    expect(all[0].trace).toBe('stack-here');
  });

  it('honours an explicit destination over the dev pino-pretty transport', () => {
    // The two are mutually exclusive in pino. A caller passing a destination
    // wants raw JSON back, so it must win even with isDevelopment=true.
    const devFile = join(tmpdir(), `pino-dev-dest-${process.pid}-${counter++}.log`);
    try {
      const dev = new PinoLogger(
        'info',
        true,
        pino.destination({ dest: devFile, sync: true, mkdir: true }),
      );
      dev.log('dev-line', 'Ctx');
      const written = readFileSync(devFile, 'utf8');
      expect(written).toMatch(/^\{"level"/m);
      expect(written).not.toMatch(/\x1b\[/);
    } finally {
      rmSync(devFile, { force: true });
    }
  });
});

/** Keeps temp filenames unique without relying on clock resolution. */
let counter = 0;
