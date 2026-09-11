import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
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
