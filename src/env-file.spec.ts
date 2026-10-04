import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEnvFile } from './env-file';

/**
 * Pins the `.env` semantics main.ts relies on (#193). The expected table was
 * measured against dotenv 18 (the package this replaced) on the same fixture;
 * the one intended divergence is `COLON: v`, which Node's parser drops.
 */
describe('applyEnvFile', () => {
  let dir: string;
  const file = (name: string, content: string) => {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-envfile-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('matches the frozen parity table (quotes, export, inline #, multi-line, no expansion, last wins)', () => {
    const p = file(
      '.env',
      [
        'A=1',
        'export B="two words"',
        "Q='single'",
        'C=x # comment',
        'D=',
        'E="l1',
        'l2"',
        'F=${A}',
        'G=1',
        'G=2',
        'CRLF=v\r',
        'NOEXP=$A',
        'BT=`back tick`',
        'HASH="v # not comment"',
        'LIT=\'a\\nb\'',
        'URL=postgres://u:p@h:5432/d?x=a=b',
        'COLON: v',
        'PRESET=file',
        'EMPTY_PRESET=file',
        '',
      ].join('\n'),
    );
    const target: Record<string, string | undefined> = { PRESET: 'from_env', EMPTY_PRESET: '' };
    applyEnvFile(target, p);
    expect(target).toEqual({
      PRESET: 'from_env', // environment wins
      EMPTY_PRESET: '', // an empty env var still wins (hasOwn, not truthiness)
      A: '1',
      B: 'two words',
      Q: 'single',
      C: 'x',
      D: '',
      E: 'l1\nl2',
      F: '${A}', // no expansion
      G: '2',
      CRLF: 'v',
      NOEXP: '$A',
      BT: 'back tick',
      HASH: 'v # not comment',
      LIT: 'a\\nb',
      URL: 'postgres://u:p@h:5432/d?x=a=b',
      // COLON absent: intended divergence from dotenv
    });
  });

  it('returns the number of keys applied', () => {
    expect(applyEnvFile({ A: 'x' }, file('.env', 'A=1\nB=2\n'))).toBe(1);
  });

  it('strips a UTF-8 BOM so the first key is intact', () => {
    const target: Record<string, string | undefined> = {};
    applyEnvFile(target, file('bom.env', '\uFEFFBOM_KEY=b\n'));
    expect(target).toEqual({ BOM_KEY: 'b' });
  });

  it('keeps a multi-line PEM value', () => {
    const target: Record<string, string | undefined> = {};
    applyEnvFile(target, file('pem.env', 'KEY="-----BEGIN-----\nabc\n-----END-----"\n'));
    expect(target.KEY).toBe('-----BEGIN-----\nabc\n-----END-----');
  });

  it('is a silent no-op for a missing file', () => {
    const target: Record<string, string | undefined> = { A: '1' };
    expect(applyEnvFile(target, join(dir, 'nope.env'))).toBe(0);
    expect(target).toEqual({ A: '1' });
  });

  it('throws EISDIR when the path is a directory', () => {
    expect(() => applyEnvFile({}, dir)).toThrow(expect.objectContaining({ code: 'EISDIR' }));
  });

  it('names the likely Docker bind-mount cause on EISDIR, keeping code and stack', () => {
    let caught: NodeJS.ErrnoException | undefined;
    try {
      applyEnvFile({}, dir);
    } catch (err) {
      caught = err as NodeJS.ErrnoException;
    }
    expect(caught).toMatchObject({ code: 'EISDIR', syscall: 'read' });
    expect(caught?.message).toMatch(/^EISDIR: /);
    expect(caught?.message).toContain(`${JSON.stringify(dir)} is a directory, not a file`);
    expect(caught?.message).toContain('Docker bind mount such as `-v ./.env:/app/.env`');
    // An uncaught error prints its stack, so the hint must be there too.
    expect(caught?.stack).toContain(caught?.message);
    expect(caught?.stack?.split('Docker bind mount').length).toBe(2); // exactly once
  });

  const itNonRoot = process.getuid?.() === 0 ? it.skip : it;
  itNonRoot('throws EACCES (not ENOENT) for an unreadable file', () => {
    const p = file('locked.env', 'A=1\n');
    chmodSync(p, 0o000);
    expect(() => applyEnvFile({}, p)).toThrow(expect.objectContaining({ code: 'EACCES' }));
  });
});
