/**
 * Process-level graceful-shutdown contract (issue #158).
 *
 * WHY THIS FILE EXISTS. `src/shutdown.spec.ts` proves the handler's sequencing
 * against injected fakes. It cannot prove the thing that actually broke, because
 * the defect lived in the WIRING: `main.ts` called `enableShutdownHooks()` *and*
 * registered its own signal handlers, so Nest and our code each drove
 * `app.close()`, `pool.end()` was called twice, pg rejected the second call, and
 * the unhandled rejection killed the process with exit 1 while `stopTelemetry()`
 * never ran. Nothing short of spawning a real process and sending it a real
 * signal can observe that.
 *
 * The first version of the FIX then introduced the opposite failure — no deadline
 * around `app.close()`, so one in-flight connection held
 * `http.Server.close()` open forever and the orchestrator SIGKILLed the process
 * (exit 137). Both directions are pinned below.
 *
 * The app is run through ts-node rather than `dist/`, because the integration CI
 * job does not build. `TS_NODE_PROJECT` must point at `tsconfig.build.json`: the
 * base `tsconfig.json` declares no `rootDir`, and compiling `src/main.ts` against
 * it fails with `TS5011` before the app ever boots.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const READY = 'Nest application successfully started';
const BOOT_TIMEOUT_MS = 90_000;
const PORT = 34599;

jest.setTimeout(120_000);

interface RunningApp {
  child: ChildProcess;
  output: () => string;
}

/** The production entrypoint, compiled against the build tsconfig (see above). */
const MAIN = { entry: join(REPO_ROOT, 'src', 'main.ts'), project: 'tsconfig.build.json' };

async function startApp(
  env: Record<string, string> = {},
  target: { entry: string; project: string } = MAIN,
): Promise<RunningApp> {
  let output = '';
  const child = spawn(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', target.entry],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TS_NODE_PROJECT: join(REPO_ROOT, target.project),
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: String(PORT),
        OTEL_ENABLED: 'false',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`app did not start in ${BOOT_TIMEOUT_MS}ms:\n${output}`)),
      BOOT_TIMEOUT_MS,
    );
    const check = setInterval(() => {
      if (output.includes(READY)) {
        clearInterval(check);
        clearTimeout(timer);
        resolve();
      }
    }, 100);
    child.once('exit', (code) => {
      clearInterval(check);
      clearTimeout(timer);
      reject(new Error(`app exited during boot with code ${code}:\n${output}`));
    });
  });

  return { child, output: () => output };
}

/** Resolve with the exit code, or reject if the process outlives `withinMs`. */
function exitCodeWithin(child: ChildProcess, withinMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`process did not exit within ${withinMs}ms — it HUNG`));
    }, withinMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('graceful shutdown (real process, real signal)', () => {
  let app: RunningApp | undefined;

  afterEach(() => {
    if (app?.child.exitCode === null && !app.child.killed) app.child.kill('SIGKILL');
    app = undefined;
  });

  it('exits 0 on SIGTERM without double-closing the pool', async () => {
    app = await startApp();

    app.child.kill('SIGTERM');
    const code = await exitCodeWithin(app.child, 20_000);

    // The headline regression: this was 1 before the fix.
    expect(code).toBe(0);
    // The cause: DatabaseService.onModuleDestroy ran twice.
    expect(app.output()).not.toContain('Called end on pool more than once');
    // And the handler really ran, rather than the process dying some other way.
    // Structured line (rule 9): the signal is its own pino field, not text in msg.
    expect(app.output()).toContain('received signal, closing gracefully');
    // JSON (`"signal":"SIGTERM"`) or pino-pretty (`signal: "SIGTERM"`, ANSI-coloured).
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
    expect(app.output().replace(ansi, '')).toMatch(/"?signal"?:\s*"SIGTERM"/);
  });

  it('exits on SIGINT too', async () => {
    app = await startApp();

    app.child.kill('SIGINT');
    const code = await exitCodeWithin(app.child, 20_000);

    expect(code).toBe(0);
    expect(app.output()).not.toContain('Called end on pool more than once');
  });

  it('exits 1 when a destroy hook fails, even though Nest 12 no longer rejects close()', async () => {
    // Issue #155. NestJS 12 runs onModuleDestroy hooks under Promise.allSettled
    // and only LOGS a rejection, so app.close() resolves even when pool.end()
    // throws. Exit 0 would then be reported for a failed teardown. The fixture
    // boots AppModule through the production bootstrap() and makes the REAL
    // DatabaseService teardown fail (pool.end() closes the pool, then rejects).
    // `test/tsconfig.test.json` because the fixture lives outside src/ (rootDir).
    app = await startApp(
      {},
      {
        entry: join(REPO_ROOT, 'test', 'fixtures', 'faulty-teardown.main.ts'),
        project: join('test', 'tsconfig.test.json'),
      },
    );

    app.child.kill('SIGTERM');
    const code = await exitCodeWithin(app.child, 20_000);

    expect(app.output()).toContain('injected teardown failure (test fixture)');
    expect(code).toBe(1);
  });

  it('does not hang when a connection is still in flight — it forces the exit', async () => {
    // The regression the first version of this fix shipped. `app.close()` disposes
    // the HTTP server and `http.Server.close()` waits for ACTIVE connections, so
    // without a deadline this hung until the orchestrator SIGKILLed it (exit 137).
    app = await startApp({ SHUTDOWN_TIMEOUT_MS: '1500' });

    // Open a socket and send an INCOMPLETE request, so the connection is active
    // (not merely idle keep-alive, which Node closes on its own).
    const socket = connect(PORT, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    socket.write('POST /ingest/acdp HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n');
    socket.on('error', () => undefined); // the forced close will reset it

    try {
      app.child.kill('SIGTERM');
      // Comfortably above the 1.5s deadline, far below any 6-hour CI timeout:
      // if this rejects, the hang is back.
      const code = await exitCodeWithin(app.child, 20_000);

      // Non-zero on purpose — an overrun shutdown is not a clean one, and saying
      // so is more useful than reporting success after dropping live requests.
      expect(code).toBe(1);
      expect(app.output()).toContain('forcing shutdown');
    } finally {
      socket.destroy();
    }
  });

  describe('SSE-aware drain (issue #192, Phase 1)', () => {
    // Red on `main` (recorded 2026-10-04, before Phase 1): the hub teardown ended
    // each stream with a bare `0\r\n\r\n` (no `shutdown` event), and the now-idle
    // keep-alive socket lingered for keepAliveTimeout+buffer (~6 s), so the first
    // case exceeded its 1000 ms bound and the 3000 ms-deadline case exited 1 via
    // "graceful close timed out — forcing shutdown".
    const API_KEY = 'drain-probe-key';
    const DRAIN_ENV = { AUTH_API_KEYS: API_KEY };

    async function openSocket(): Promise<ReturnType<typeof connect>> {
      const socket = connect(PORT, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('error', reject);
      });
      socket.on('error', () => undefined);
      return socket;
    }

    interface RawStream {
      raw: () => string;
      /** Resolves with the time the peer's FIN arrived. */
      fin: Promise<number>;
      socket: ReturnType<typeof connect>;
    }

    /** A raw-socket SSE subscription (so the chunked terminator and the FIN are
     *  observable, which an HTTP client would hide). Resolves once the response
     *  header block has arrived, i.e. the stream is subscribed to the hub. */
    async function openSse(path: string): Promise<RawStream> {
      const socket = await openSocket();
      let raw = '';
      const fin = new Promise<number>((resolve) => socket.once('end', () => resolve(Date.now())));
      const headersIn = new Promise<void>((resolve) => {
        socket.on('data', (c: Buffer) => {
          raw += c.toString('latin1');
          if (raw.includes('\r\n\r\n')) resolve();
        });
      });
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\nAccept: text/event-stream\r\n` +
          `Authorization: Bearer ${API_KEY}\r\n\r\n`,
      );
      await headersIn;
      return { raw: () => raw, fin, socket };
    }

    function expectShutdownThenTerminator(stream: RawStream): void {
      const raw = stream.raw();
      expect(raw).toMatch(/^HTTP\/1\.1 200/);
      const event = raw.indexOf('event: shutdown\n');
      const terminator = raw.lastIndexOf('0\r\n\r\n');
      expect(event).toBeGreaterThan(-1);
      expect(raw).toMatch(/event: shutdown\n(?:id: \d+\n)?retry: \d+\n/);
      expect(raw).toContain('"reason":"server_shutdown"');
      expect(terminator).toBeGreaterThan(event);
    }

    it('SSE clients get a shutdown event and the process exits promptly', async () => {
      app = await startApp(DRAIN_ENV);
      const global = await openSse('/events/stream');
      const perRun = await openSse('/runs/drain-r1/events/stream');

      try {
        const sentAt = Date.now();
        app.child.kill('SIGTERM');
        const code = await exitCodeWithin(app.child, 20_000);
        const exitMs = Date.now() - sentAt;
        const finMs = Math.max(await global.fin, await perRun.fin) - sentAt;

        expect(code).toBe(0);
        // Was >= 6000 ms on main: the idle keep-alive socket lingered until
        // keepAliveTimeout+buffer instead of being reaped once the listener closed.
        expect(exitMs).toBeLessThan(1000);
        expect(finMs).toBeLessThan(1000);
        expectShutdownThenTerminator(global);
        expectShutdownThenTerminator(perRun);
        expect(app.output()).not.toContain('forcing shutdown');
      } finally {
        global.socket.destroy();
        perRun.socket.destroy();
      }
    });

    it('a short deadline no longer exits 1 spuriously, and an in-flight request keeps its grace', async () => {
      app = await startApp({ ...DRAIN_ENV, SHUTDOWN_TIMEOUT_MS: '3000' });
      const sse = await openSse('/events/stream');

      // An in-flight request whose HEADERS arrive before SIGTERM and whose body
      // completes 1500 ms after it. Not DB-backed (Round 2 #2): the body fails
      // DTO validation, so the expected answer is a 400, never a reset or 5xx.
      const post = await openSocket();
      let postRaw = '';
      post.on('data', (c: Buffer) => (postRaw += c.toString('latin1')));
      const body = '{"not_a_run":true}';
      post.write(
        'POST /runs/started HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n' +
          `Content-Length: ${body.length}\r\n\r\n` +
          body.slice(0, 5),
      );
      // Let the request line + headers be parsed before the signal.
      await new Promise((r) => setTimeout(r, 200));

      try {
        const sentAt = Date.now();
        app.child.kill('SIGTERM');
        setTimeout(() => post.write(body.slice(5)), 1500);
        const code = await exitCodeWithin(app.child, 20_000);
        const exitMs = Date.now() - sentAt;

        // Was 1 on main: the lingering idle sockets outlived the 3000 ms deadline.
        expect(code).toBe(0);
        expect(app.output()).not.toContain('forcing shutdown');
        expectShutdownThenTerminator(sse);
        expect(postRaw).toMatch(/^HTTP\/1\.1 400 /);
        expect(exitMs).toBeLessThan(1500 + 500);
      } finally {
        sse.socket.destroy();
        post.destroy();
      }
    });
  });
});
