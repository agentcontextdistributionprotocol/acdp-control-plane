import { EventEmitter } from 'node:events';
import {
  SHUTDOWN_SIGNALS,
  createShutdownHandler,
  registerShutdownHandlers,
  type ShutdownDeps,
} from './shutdown';

/** Silent logger — these tests assert on sequencing, not on log output. */
const silentLogger = { error: jest.fn(), log: jest.fn() } as unknown as ShutdownDeps['logger'];

function build(overrides: (calls: string[]) => Partial<ShutdownDeps> = () => ({})) {
  const calls: string[] = [];
  const deps: ShutdownDeps = {
    close: jest.fn(async () => {
      calls.push('close');
    }),
    stopTelemetry: jest.fn(async () => {
      calls.push('stopTelemetry');
    }),
    exit: jest.fn((code: number) => {
      calls.push(`exit:${code}`);
    }),
    logger: silentLogger,
    ...overrides(calls),
  };
  return { deps, calls, handler: createShutdownHandler(deps) };
}

describe('createShutdownHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  it('closes the app, then flushes telemetry, then exits 0', async () => {
    const { handler, calls } = build();

    await handler('SIGTERM');

    // Order matters: telemetry must outlive the app so shutdown traces are
    // recorded, and the exit must come last.
    expect(calls).toEqual(['close', 'stopTelemetry', 'exit:0']);
  });

  describe('idempotency — the actual #158 defect', () => {
    it('runs the destroy path ONCE across repeated signals', async () => {
      const { handler, deps, calls } = build();

      // Two listeners firing for one signal is exactly what enableShutdownHooks()
      // plus a manual process.on() produced, and it ran pool.end() twice.
      await Promise.all([handler('SIGTERM'), handler('SIGTERM'), handler('SIGINT')]);

      expect(deps.close).toHaveBeenCalledTimes(1);
      expect(deps.stopTelemetry).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(['close', 'stopTelemetry', 'exit:0']);
    });

    it('ignores a second signal arriving MID-shutdown, not just after it', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const close = jest.fn(() => gate);
      const { handler, deps } = build(() => ({ close }));

      const first = handler('SIGTERM');
      // Still in flight — this is the window the old code re-entered.
      const second = handler('SIGTERM');
      release();
      await Promise.all([first, second]);

      expect(close).toHaveBeenCalledTimes(1);
      expect(deps.exit).toHaveBeenCalledTimes(1);
    });

    it('returns the same promise so callers await one shutdown', () => {
      const { handler } = build();
      expect(handler('SIGTERM')).toBe(handler('SIGTERM'));
    });
  });

  describe('error containment', () => {
    it('still flushes telemetry when close() rejects, and exits 1', async () => {
      // Record the attempt BEFORE throwing, so the ordering assertion below can
      // still see that close() was reached.
      const { handler, deps, calls } = build((recorded) => ({
        close: jest.fn(async () => {
          recorded.push('close');
          throw new Error('Called end on pool more than once');
        }),
      }));

      // The old handler had no catch: this rejection killed the process before
      // stopTelemetry() could run, dropping the very traces that explain it.
      await expect(handler('SIGTERM')).resolves.toBeUndefined();

      expect(deps.stopTelemetry).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(['close', 'stopTelemetry', 'exit:1']);
    });

    it('exits 1 when only telemetry fails, having still closed the app', async () => {
      const stopTelemetry = jest.fn(async () => {
        throw new Error('otlp exporter timeout');
      });
      const { handler, deps } = build(() => ({ stopTelemetry }));

      await expect(handler('SIGTERM')).resolves.toBeUndefined();

      expect(deps.close).toHaveBeenCalledTimes(1);
      expect(deps.exit).toHaveBeenCalledWith(1);
    });

    it('never rethrows — an unhandled rejection here would kill the process', async () => {
      const { handler } = build(() => ({
        close: jest.fn(async () => {
          throw new Error('boom');
        }),
        stopTelemetry: jest.fn(async () => {
          throw new Error('also boom');
        }),
      }));

      await expect(handler('SIGTERM')).resolves.toBeUndefined();
    });
  });
});

describe('registerShutdownHandlers', () => {
  it('handles every shutdown signal, passing the signal through', async () => {
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    const handler = jest.fn(async (_signal?: string) => undefined);

    registerShutdownHandlers(handler, proc);

    for (const signal of SHUTDOWN_SIGNALS) {
      (proc as unknown as EventEmitter).emit(signal);
    }

    expect(handler.mock.calls.map((c) => c[0])).toEqual([...SHUTDOWN_SIGNALS]);
  });

  it('unregisters cleanly, leaving no listeners behind', () => {
    const emitter = new EventEmitter();
    const proc = emitter as unknown as NodeJS.Process;

    const unregister = registerShutdownHandlers(
      jest.fn(async (_signal?: string) => undefined),
      proc,
    );
    expect(SHUTDOWN_SIGNALS.every((s) => emitter.listenerCount(s) === 1)).toBe(true);

    unregister();
    expect(SHUTDOWN_SIGNALS.every((s) => emitter.listenerCount(s) === 0)).toBe(true);
  });
});
