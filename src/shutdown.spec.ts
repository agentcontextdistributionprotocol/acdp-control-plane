import { EventEmitter } from 'node:events';
import {
  SHUTDOWN_SIGNALS,
  createShutdownHandler,
  registerShutdownHandlers,
  trackOpenConnections,
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
      // Cross a microtask boundary before re-entering, so this also catches a
      // guard that is correct synchronously but lost across an await.
      await Promise.resolve();
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

    // Issue #155: NestJS 12 swallows destroy-hook rejections, so close()
    // RESOLVES on a failed teardown. hookFailed is how the handler still knows.
    it('exits 1 when close() resolves but a destroy hook failed (NestJS 12 semantics)', async () => {
      const { handler, calls, deps } = build(() => ({ hookFailed: () => true }));

      await expect(handler('SIGTERM')).resolves.toBeUndefined();

      expect(calls).toEqual(['close', 'stopTelemetry', 'exit:1']);
      expect(deps.logger?.error).toHaveBeenCalledWith(
        expect.stringContaining('destroy hooks failed'),
      );
    });

    it('reads hookFailed only after close() has settled', async () => {
      const order: string[] = [];
      const { handler } = build((recorded) => ({
        close: jest.fn(async () => {
          recorded.push('close');
          order.push('close');
        }),
        hookFailed: jest.fn(() => {
          order.push('hookFailed');
          return false;
        }),
      }));

      await handler('SIGTERM');

      expect(order).toEqual(['close', 'hookFailed']);
    });

    it('exits 0 when hookFailed reports no failures', async () => {
      const { handler, calls } = build(() => ({ hookFailed: () => false }));
      await handler('SIGTERM');
      expect(calls).toEqual(['close', 'stopTelemetry', 'exit:0']);
    });

    it('treats a throwing hookFailed probe as a failure, and still flushes telemetry', async () => {
      const { handler, calls } = build(() => ({
        hookFailed: () => {
          throw new Error('collector unavailable');
        },
      }));

      await expect(handler('SIGTERM')).resolves.toBeUndefined();

      expect(calls).toEqual(['close', 'stopTelemetry', 'exit:1']);
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

describe('the shutdown deadline', () => {
  beforeEach(() => jest.clearAllMocks());

  it('forces the exit when close() never settles, instead of hanging forever', async () => {
    // This is the regression the first version of this fix introduced: app.close()
    // disposes the HTTP server, and http.Server.close() waits for every ACTIVE
    // connection — so one in-flight request held shutdown open indefinitely, the
    // orchestrator SIGKILLed it, and the exit code was 137. A hang is strictly
    // worse than the exit-1 bug this module exists to fix.
    const forceCloseConnections = jest.fn();
    const { handler, deps } = build(() => ({
      close: jest.fn(() => new Promise<void>(() => undefined)), // never settles
      forceCloseConnections,
      timeoutMs: 25,
    }));

    await handler('SIGTERM');

    expect(forceCloseConnections).toHaveBeenCalledTimes(1);
    // Telemetry is still flushed on the forced path — that is when the traces
    // explaining the hang matter most.
    expect(deps.stopTelemetry).toHaveBeenCalledTimes(1);
    // Non-zero: an overrun shutdown is not a clean one.
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('does not force-close or penalise the exit code when close() is prompt', async () => {
    const forceCloseConnections = jest.fn();
    const { handler, deps } = build(() => ({ forceCloseConnections, timeoutMs: 10_000 }));

    await handler('SIGTERM');

    expect(forceCloseConnections).not.toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('survives a forceCloseConnections that throws', async () => {
    const { handler, deps } = build(() => ({
      close: jest.fn(() => new Promise<void>(() => undefined)),
      forceCloseConnections: jest.fn(() => {
        throw new Error('socket teardown failed');
      }),
      timeoutMs: 25,
    }));

    await expect(handler('SIGTERM')).resolves.toBeUndefined();
    expect(deps.exit).toHaveBeenCalledWith(1);
  });
});

describe('the drain and idle-socket reaper (issue #192)', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.useRealTimers());

  /** A close() the test releases by hand, so the reaper's window is controlled. */
  function gatedClose(calls?: string[]) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = jest.fn(() => {
      calls?.push('close');
      return gate;
    });
    return { close, release };
  }

  it('begins the drain BEFORE close() runs any destroy hook', async () => {
    const { handler, calls } = build((c) => ({
      beginDrain: jest.fn(() => {
        c.push('beginDrain');
      }),
    }));

    await handler('SIGTERM');

    expect(calls).toEqual(['beginDrain', 'close', 'stopTelemetry', 'exit:0']);
  });

  it('never reaps while the listener is still open, then polls once it closes', async () => {
    jest.useFakeTimers();
    let listenerClosed = false;
    const reapIdleConnections = jest.fn();
    const { close, release } = gatedClose();
    const { handler, deps } = build(() => ({
      close,
      reapIdleConnections,
      listenerClosed: () => listenerClosed,
    }));

    const done = handler('SIGTERM');
    // closeIdleConnections() would reset a just-accepted socket that has not sent
    // its request line yet — so no tick may reap while the listener accepts.
    await jest.advanceTimersByTimeAsync(1000);
    expect(reapIdleConnections).not.toHaveBeenCalled();

    // Nest's dispose() has called httpServer.close(): the NEXT tick reaps.
    listenerClosed = true;
    await jest.advanceTimersByTimeAsync(100);
    expect(reapIdleConnections).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(200);
    expect(reapIdleConnections).toHaveBeenCalledTimes(3);

    // close() settles → the poll stops for good.
    release();
    await done;
    await jest.advanceTimersByTimeAsync(1000);
    expect(reapIdleConnections).toHaveBeenCalledTimes(3);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('stops polling on the forced (deadline) path too', async () => {
    jest.useFakeTimers();
    const reapIdleConnections = jest.fn();
    const forceCloseConnections = jest.fn();
    const { handler, deps } = build(() => ({
      close: jest.fn(() => new Promise<void>(() => undefined)), // never settles
      reapIdleConnections,
      listenerClosed: () => true,
      forceCloseConnections,
      timeoutMs: 450,
    }));

    const done = handler('SIGTERM');
    await jest.advanceTimersByTimeAsync(450);
    await done;
    const ticks = reapIdleConnections.mock.calls.length;
    expect(ticks).toBe(4);
    await jest.advanceTimersByTimeAsync(1000);
    expect(reapIdleConnections).toHaveBeenCalledTimes(ticks);
    expect(forceCloseConnections).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('never reaps when no listenerClosed probe is wired (fail-safe)', async () => {
    jest.useFakeTimers();
    const reapIdleConnections = jest.fn();
    const { close, release } = gatedClose();
    const { handler } = build(() => ({ close, reapIdleConnections }));

    const done = handler('SIGTERM');
    await jest.advanceTimersByTimeAsync(1000);
    release();
    await done;

    expect(reapIdleConnections).not.toHaveBeenCalled();
  });

  it('honours a custom reap interval', async () => {
    jest.useFakeTimers();
    const reapIdleConnections = jest.fn();
    const { close, release } = gatedClose();
    const { handler } = build(() => ({
      close,
      reapIdleConnections,
      listenerClosed: () => true,
      reapIntervalMs: 25,
    }));

    const done = handler('SIGTERM');
    await jest.advanceTimersByTimeAsync(100);
    release();
    await done;

    expect(reapIdleConnections).toHaveBeenCalledTimes(4);
  });

  it('still closes and exits 0 when beginDrain throws', async () => {
    const { handler, deps, calls } = build(() => ({
      beginDrain: jest.fn(() => {
        throw new Error('drain exploded');
      }),
    }));

    await expect(handler('SIGTERM')).resolves.toBeUndefined();

    // A failed drain loses the `shutdown` event, not the teardown: the exit code
    // contract is unchanged.
    expect(calls).toEqual(['close', 'stopTelemetry', 'exit:0']);
    expect(deps.logger?.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'drain exploded' }),
    );
  });

  it('still exits 0 when the reaper or the listener probe throws', async () => {
    jest.useFakeTimers();
    const reapIdleConnections = jest.fn(() => {
      throw new Error('reap failed');
    });
    const { close, release } = gatedClose();
    const { handler, deps } = build(() => ({
      close,
      reapIdleConnections,
      listenerClosed: () => true,
    }));

    const done = handler('SIGTERM');
    await jest.advanceTimersByTimeAsync(300);
    // A throwing tick does not stop later ticks.
    expect(reapIdleConnections).toHaveBeenCalledTimes(3);
    release();
    await expect(done).resolves.toBeUndefined();
    expect(deps.exit).toHaveBeenCalledWith(0);

    const probe = build(() => ({
      reapIdleConnections: jest.fn(),
      listenerClosed: () => {
        throw new Error('probe failed');
      },
    }));
    const probeDone = probe.handler('SIGTERM');
    await jest.advanceTimersByTimeAsync(300);
    await probeDone;
    expect(probe.deps.exit).toHaveBeenCalledWith(0);
  });

  it('begins the drain once across repeated signals', async () => {
    const beginDrain = jest.fn();
    const { handler } = build(() => ({ beginDrain }));

    await Promise.all([handler('SIGTERM'), handler('SIGTERM'), handler('SIGINT')]);

    expect(beginDrain).toHaveBeenCalledTimes(1);
  });
});

describe('shutdown observability (issue #192, Phase 2)', () => {
  beforeEach(() => jest.clearAllMocks());

  function recordingLogger() {
    const lines: Array<{ level: string; obj: unknown }> = [];
    const logger = {
      log: jest.fn((obj: unknown) => lines.push({ level: 'log', obj })),
      error: jest.fn((obj: unknown) => lines.push({ level: 'error', obj })),
    } as unknown as ShutdownDeps['logger'];
    const find = (msg: string) =>
      lines.find((l) => (l.obj as { msg?: string } | undefined)?.msg === msg)?.obj as
        | Record<string, unknown>
        | undefined;
    return { logger, find };
  }

  it('the forced path logs a structured forcedConnections count, read synchronously, before closeAllConnections', async () => {
    const { logger, find } = recordingLogger();
    const order: string[] = [];
    const recordForcedConnections = jest.fn((n: number) => order.push(`record:${n}`));
    const { handler, deps } = build(() => ({
      close: jest.fn(() => new Promise<void>(() => undefined)),
      timeoutMs: 25,
      logger,
      openConnections: jest.fn(() => {
        order.push('count');
        return 3;
      }),
      recordForcedConnections,
      forceCloseConnections: jest.fn(() => order.push('forceClose')),
    }));

    await handler('SIGTERM');

    expect(find('graceful close timed out — forcing shutdown')).toEqual(
      expect.objectContaining({ timeoutMs: 25, forcedConnections: 3 }),
    );
    expect(order).toEqual(['count', 'record:3', 'forceClose']);
    expect(find('shutdown drain complete')).toEqual(
      expect.objectContaining({ forcedConnections: 3 }),
    );
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('reports forcedConnections: null (never a fake 0) when the count throws, and still forces + exits 1', async () => {
    const { logger, find } = recordingLogger();
    const recordForcedConnections = jest.fn();
    const forceCloseConnections = jest.fn();
    const { handler, deps } = build(() => ({
      close: jest.fn(() => new Promise<void>(() => undefined)),
      timeoutMs: 25,
      logger,
      openConnections: () => {
        throw new Error('no server');
      },
      recordForcedConnections,
      forceCloseConnections,
    }));

    await handler('SIGTERM');

    expect(find('graceful close timed out — forcing shutdown')).toEqual(
      expect.objectContaining({ forcedConnections: null }),
    );
    expect(recordForcedConnections).not.toHaveBeenCalled();
    expect(forceCloseConnections).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('a clean close logs the summary with drainMs and the drain tallies, forcing nothing', async () => {
    const { logger, find } = recordingLogger();
    let t = 1_000;
    const openConnections = jest.fn(() => 9);
    const { handler, deps } = build(() => ({
      close: jest.fn(async () => {
        t += 42;
      }),
      now: () => t,
      logger,
      openConnections,
      drainStats: () => ({ sseStreamsTerminated: 2, drainRejections: 5 }),
    }));

    await handler('SIGTERM');

    expect(find('shutdown drain complete')).toEqual({
      msg: 'shutdown drain complete',
      drainMs: 42,
      sseStreamsTerminated: 2,
      drainRejections: 5,
      forcedConnections: 0,
    });
    expect(openConnections).not.toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('a throwing drainStats only drops the tallies; the summary and the exit survive', async () => {
    const { logger, find } = recordingLogger();
    const { handler, deps } = build(() => ({
      logger,
      drainStats: () => {
        throw new Error('stats unavailable');
      },
    }));

    await handler('SIGTERM');

    expect(find('shutdown drain complete')).toEqual(
      expect.objectContaining({ sseStreamsTerminated: null, drainRejections: null }),
    );
    expect(deps.exit).toHaveBeenCalledWith(0);
  });
});

describe('trackOpenConnections (issue #192, Phase 2)', () => {
  it('counts sockets synchronously as they connect and close', () => {
    const server = new EventEmitter();
    const count = trackOpenConnections(server as never);
    const a = new EventEmitter();
    const b = new EventEmitter();

    expect(count()).toBe(0);
    server.emit('connection', a);
    server.emit('connection', b);
    expect(count()).toBe(2);
    a.emit('close');
    a.emit('close'); // once(): a duplicate close never double-decrements
    expect(count()).toBe(1);
  });
});

describe('signal threading', () => {
  it('passes the signal to close(), for Before/OnApplicationShutdown hooks', async () => {
    const { handler, deps } = build();
    await handler('SIGTERM');
    expect(deps.close).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('containment of the un-try-wrapped statements', () => {
  it('still shuts down when the logger throws', async () => {
    const throwingLogger = {
      log: jest.fn(() => {
        throw new Error('logger exploded');
      }),
      error: jest.fn(),
    } as unknown as ShutdownDeps['logger'];
    const { handler, deps } = build(() => ({ logger: throwingLogger }));

    await expect(handler('SIGTERM')).resolves.toBeUndefined();
    expect(deps.close).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('does not reject when exit() itself throws', async () => {
    // A rejected memoized promise would surface as an unhandledRejection and kill
    // the process mid-shutdown — #158's failure mode by another route.
    const { handler } = build(() => ({
      exit: jest.fn(() => {
        throw new Error('exit unavailable');
      }),
    }));

    await expect(handler('SIGTERM')).resolves.toBeUndefined();
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

  it('defaults to the real process object', () => {
    // Every other test injects an EventEmitter, so nothing exercised the default
    // binding — a typo there would ship green while leaving the service with no
    // shutdown handling at all.
    const before = process.listenerCount('SIGTERM');
    const unregister = registerShutdownHandlers(jest.fn(async (_s?: string) => undefined));
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    unregister();
    expect(process.listenerCount('SIGTERM')).toBe(before);
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
