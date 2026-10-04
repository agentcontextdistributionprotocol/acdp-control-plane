import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Pins the `.env` preload contract `main.ts` relies on (docs/CONFIGURATION.md):
 * `import './load-env'` is the FIRST import, loads `./.env` from the cwd,
 * never overrides a variable already in the environment, tolerates a missing
 * file, and stays silent on boot.
 *
 * Each case runs the real `load-env` module in a child Node process (ts-node,
 * build tsconfig) with a temp cwd — exactly how `node dist/main.js` executes
 * it — so a Node change to `.env` parsing semantics fails here rather than in
 * production.
 */
describe('load-env preload (main.ts first import)', () => {
  const preload = join(__dirname, 'load-env.ts');
  const buildTsconfig = join(__dirname, '..', 'tsconfig.build.json');
  let dir: string;

  const run = (env: Record<string, string>) => {
    const childEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      TS_NODE_PROJECT: buildTsconfig,
      ...env,
    };
    return spawnSync(
      process.execPath,
      [
        '-r',
        require.resolve('ts-node/register/transpile-only'),
        '-e',
        `require(${JSON.stringify(preload)});` +
          'process.stdout.write(JSON.stringify({a: process.env.ZZ_ENVFILE_A ?? null, b: process.env.ZZ_ENVFILE_B ?? null}))',
      ],
      { cwd: dir, env: childEnv, encoding: 'utf8' },
    );
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-loadenv-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is the first import in main.ts', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    const firstImport = main.split('\n').find((l) => l.startsWith('import '));
    expect(firstImport).toBe("import './load-env';");
  });

  it('loads a key present only in .env, without overriding the shell env', () => {
    writeFileSync(join(dir, '.env'), 'ZZ_ENVFILE_A=from_file\nZZ_ENVFILE_B=from_file\n');
    const res = run({ ZZ_ENVFILE_A: 'from_env' });

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ a: 'from_env', b: 'from_file' });
    // Quiet: no "injected env" line on every boot.
    expect(res.stderr).toBe('');
  });

  it('boots silently when there is no .env file', () => {
    const res = run({});

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ a: null, b: null });
    expect(res.stderr).toBe('');
  });

  it('fails boot loudly when .env is a directory (unreadable, not missing)', () => {
    mkdirSync(join(dir, '.env'));
    const res = run({});

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('EISDIR');
    // Actionable: names the likely cause, not just the errno.
    expect(res.stderr).toContain('".env" is a directory, not a file');
    expect(res.stderr).toContain('Docker bind mount such as `-v ./.env:/app/.env`');
    expect(res.stderr.split('Likely cause').length).toBe(2); // exactly once, not doubled
  });
});
