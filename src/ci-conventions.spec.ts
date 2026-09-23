/**
 * Meta-test for `scripts/ci-conventions.sh` (CLAUDE.md "CI grep rules").
 *
 * A grep rule that matches nothing is indistinguishable from a grep rule that
 * works, and the sixth check — "no `Acdp* as unknown as`" — is exactly the kind
 * that can land vacuous: the SDK type is the LEFT operand of the double cast
 * (`AcdpVerifier as unknown as Partial<LocalInterface>`), so a rule written
 * against the right-hand side would match nothing forever. These cases run the
 * real script against scratch trees and assert it actually fires, that the
 * documented exemption holds, and that the compliant replacement pattern
 * (`Pick<typeof AcdpVerifier, …>`) passes.
 *
 * The script takes the source directory as its one optional argument (default
 * `src`) precisely so this spec can point it at a scratch tree instead of
 * writing a violating file into `src/` mid-run.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT = 'scripts/ci-conventions.sh';

function runScript(srcDir: string): { status: number; out: string } {
  const res = spawnSync('bash', [SCRIPT, srcDir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

describe('scripts/ci-conventions.sh', () => {
  const scratchRoots: string[] = [];

  /** A scratch source tree: `files` is published-path → contents. */
  function scratchTree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'acdp-conventions-'));
    scratchRoots.push(root);
    const dir = join(root, 'src');
    mkdirSync(dir, { recursive: true });
    // Always present: a benign non-spec .ts file, so the perl-based check 5
    // never runs with an empty file list (xargs behaviour differs across
    // BSD/GNU when its input is empty).
    writeFileSync(join(dir, 'benign.ts'), 'export const ok = 1;\n', 'utf8');
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents, 'utf8');
    }
    return dir;
  }

  afterAll(() => {
    for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  });

  it('passes on the real src/ tree and prints exactly six ✓ checks', () => {
    const { status, out } = runScript('src');
    expect(out).not.toMatch(/✗/);
    expect(status).toBe(0);
    expect(out.match(/✓/g) ?? []).toHaveLength(6);
  });

  // ── Check 6: the SDK-surface shim hole ─────────────────────────────────
  //
  // The eight sites this phase removed all had this exact shape.

  it('fails when an Acdp* type is laundered through `as unknown as`', () => {
    const dir = scratchTree({
      'shim.ts': [
        "import { AcdpVerifier } from '@agentcontextdistributionprotocol/acdp';",
        'interface LocalShim {',
        '  verifyReceipt(a: string, b: string): boolean;',
        '}',
        'export const verifier = AcdpVerifier as unknown as Partial<LocalShim>;',
      ].join('\n'),
    });
    const { status, out } = runScript(dir);
    expect(status).not.toBe(0);
    expect(out).toContain("✗ no Acdp* laundered through 'as unknown as'");
    expect(out).toContain('shim.ts:5:');
  });

  it('fires on any Acdp* identifier, not just AcdpVerifier', () => {
    const dir = scratchTree({
      'other.ts': 'export const d = AcdpDidDocument as unknown as Record<string, unknown>;\n',
    });
    expect(runScript(dir).status).not.toBe(0);
  });

  it('exempts *.spec.ts — specs legitimately fabricate binding shapes', () => {
    const dir = scratchTree({
      'shim.spec.ts': 'const v = AcdpVerifier as unknown as Partial<Thing>;\n',
    });
    const { status, out } = runScript(dir);
    expect(status).toBe(0);
    expect(out).toContain("✓ no Acdp* laundered through 'as unknown as'");
  });

  it('accepts the compliant replacement (Pick<typeof AcdpVerifier, …>)', () => {
    const dir = scratchTree({
      'shim.ts': [
        "import { AcdpVerifier } from '@agentcontextdistributionprotocol/acdp';",
        "type ReceiptSurface = Pick<typeof AcdpVerifier, 'verifyReceipt'>;",
        'export const verifier = AcdpVerifier as Partial<ReceiptSurface>;',
        'export const surface: ReceiptSurface = AcdpVerifier;',
      ].join('\n'),
    });
    const { status, out } = runScript(dir);
    expect(status).toBe(0);
    expect(out).toContain("✓ no Acdp* laundered through 'as unknown as'");
  });

  it('does not fire on a non-SDK `as unknown as` (e.g. req, payload casts)', () => {
    const dir = scratchTree({
      'plain.ts': [
        'export function f(req: object): unknown {',
        '  return (req as unknown as Record<string, unknown>).requestId;',
        '}',
      ].join('\n'),
    });
    expect(runScript(dir).status).toBe(0);
  });

  // ── The pre-existing checks still see the scratch root ──────────────────
  //
  // The source directory became an argument in this phase; these pin that the
  // other five checks were plumbed through it too, rather than silently
  // continuing to scan `src` (which would make every case above vacuous).

  it('still catches console.* through the argument (check 2)', () => {
    const dir = scratchTree({ 'noisy.ts': "console.log('hi');\n" });
    const { status, out } = runScript(dir);
    expect(status).not.toBe(0);
    expect(out).toContain('✗ no console.*');
  });

  it('still catches a multi-line logger.<level>(JSON.stringify(...)) (check 5)', () => {
    const dir = scratchTree({
      'logging.ts': [
        'declare const logger: { log(m: unknown): void };',
        'export function emit(payload: object): void {',
        '  logger.log(',
        '    JSON.stringify(payload),',
        '  );',
        '}',
      ].join('\n'),
    });
    const { status, out } = runScript(dir);
    expect(status).not.toBe(0);
    expect(out).toContain('✗ no JSON.stringify into a log message');
  });
});
