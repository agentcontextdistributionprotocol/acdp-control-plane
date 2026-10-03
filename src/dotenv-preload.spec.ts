import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Pins the `.env` preload contract `main.ts` relies on (docs/CONFIGURATION.md):
 * `import 'dotenv/config'` is the FIRST import, loads `./.env` from the cwd,
 * never overrides a variable already in the environment, tolerates a missing
 * file, and stays silent on boot.
 *
 * Each case runs the real `dotenv/config` entry in a child Node process with a
 * temp cwd — exactly how `node dist/main.js` executes it — so a dotenv major
 * that changes loading semantics (dotenv 18 moved its log line to stderr and
 * made the preload quiet by default) fails here rather than in production.
 */
describe('dotenv/config preload (main.ts first import)', () => {
  const preload = require.resolve('dotenv/config');
  let dir: string;

  const run = (env: Record<string, string>) => {
    const childEnv: Record<string, string> = { PATH: process.env.PATH ?? '', ...env };
    return spawnSync(
      process.execPath,
      [
        '-e',
        `require(${JSON.stringify(preload)});` +
          'process.stdout.write(JSON.stringify({a: process.env.ZZ_DOTENV_A ?? null, b: process.env.ZZ_DOTENV_B ?? null}))',
      ],
      { cwd: dir, env: childEnv, encoding: 'utf8' },
    );
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-dotenv-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is the first import in main.ts', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    const firstImport = main.split('\n').find((l) => l.startsWith('import '));
    expect(firstImport).toBe("import 'dotenv/config';");
  });

  it('loads a key present only in .env, without overriding the shell env', () => {
    writeFileSync(join(dir, '.env'), 'ZZ_DOTENV_A=from_file\nZZ_DOTENV_B=from_file\n');
    const res = run({ ZZ_DOTENV_A: 'from_env' });

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ a: 'from_env', b: 'from_file' });
    // Quiet by default: no "injected env" line on every boot.
    expect(res.stderr).toBe('');
  });

  it('boots silently when there is no .env file', () => {
    const res = run({});

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ a: null, b: null });
    expect(res.stderr).toBe('');
  });
});
