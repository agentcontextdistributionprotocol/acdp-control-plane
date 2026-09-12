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

async function startApp(env: Record<string, string> = {}): Promise<RunningApp> {
  let output = '';
  const child = spawn(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', join(REPO_ROOT, 'src', 'main.ts')],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TS_NODE_PROJECT: join(REPO_ROOT, 'tsconfig.build.json'),
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
    expect(app.output()).toContain('received SIGTERM, closing gracefully');
  });

  it('exits on SIGINT too', async () => {
    app = await startApp();

    app.child.kill('SIGINT');
    const code = await exitCodeWithin(app.child, 20_000);

    expect(code).toBe(0);
    expect(app.output()).not.toContain('Called end on pool more than once');
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
});
