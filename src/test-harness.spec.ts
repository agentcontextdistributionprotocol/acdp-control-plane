/**
 * Tripwire for the Jest harness (issue #191).
 *
 * NestJS 12 ships ESM-only. Jest's CommonJS runtime cannot `require()` ESM
 * without Node's experimental vm-modules API, so instead of that flag both jest
 * configs (the `jest` block in package.json and test/jest.integration.config.ts)
 * down-compile `node_modules/@nestjs/**` to CJS with `@swc/jest`. See
 * docs/TESTING.md "Why Jest transforms @nestjs/*".
 *
 * This spec fails the day that setup becomes either compromised or unnecessary:
 *
 *  (a) the vm-modules flag is back (`process.execArgv` or `NODE_OPTIONS`).
 *      Re-adding it does not break the transform, but it makes Jest's own ESM
 *      fallback silently load any NEW ESM-only dependency that is missing from
 *      the transform allowlist, hiding the TESTING.md rule until someone runs
 *      without it.
 *  (b) `@nestjs/common` / `@nestjs/core` start resolving `require` to a CommonJS
 *      file (a `require` condition, a `.cjs` target, or a target in a
 *      `"type":"commonjs"` scope). Then Jest can load Nest natively and the swc
 *      transform should be deleted.
 *
 * Together with the suite loading at all, (a)+(b) mean the transform is what
 * makes Nest load under Jest. A "was this module transpiled" probe is
 * deliberately not used: `__esModule` does not discriminate (Jest's own
 * require(esm) facade sets it too).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const FLAG = '--experimental-vm-modules';

describe('jest harness (issue #191)', () => {
  describe('(a) the experimental vm-modules flag is absent', () => {
    it('is not in process.execArgv', () => {
      const offending = process.execArgv.filter((a) => a.startsWith(FLAG));
      if (offending.length > 0) {
        throw new Error(
          `Jest was started with ${offending.join(' ')} in process.execArgv. ` +
            'The test scripts must run plain `jest` (issue #191): the jest configs ' +
            'transform @nestjs/* with @swc/jest instead. Remove the flag from the ' +
            'npm script / runner invocation. See docs/TESTING.md.',
        );
      }
    });

    it('is not in NODE_OPTIONS', () => {
      const nodeOptions = process.env.NODE_OPTIONS ?? '';
      if (nodeOptions.includes(FLAG)) {
        throw new Error(
          `NODE_OPTIONS contains ${FLAG} ("${nodeOptions}"). It is no longer needed ` +
            '(issue #191) and hides a missing transform-allowlist entry for new ' +
            'ESM-only dependencies. Remove it from your shell / IDE Jest runner ' +
            'configuration. See docs/TESTING.md.',
        );
      }
    });

    it('notes (never fails) when Node exposes vm.SourceTextModule without the flag', () => {
      const vm = require('node:vm') as { SourceTextModule?: unknown };
      const flagged =
        process.execArgv.some((a) => a.startsWith(FLAG)) ||
        (process.env.NODE_OPTIONS ?? '').includes(FLAG);
      if (!flagged && typeof vm.SourceTextModule === 'function') {
        // Informational only: a Node upgrade is not a regression.
        console.info(
          '[test-harness.spec] Node now exposes vm.SourceTextModule without a flag. ' +
            'Jest may be able to load ESM natively: revisit the @swc/jest @nestjs/* ' +
            'transform (issue #191, docs/TESTING.md).',
        );
      }
      expect(true).toBe(true);
    });
  });

  describe('(b) Nest still resolves `require` to an ES module', () => {
    // Jest's CJS resolution conditions under testEnvironment "node".
    const REQUIRE_CONDITIONS = new Set(['require', 'node', 'node-addons', 'default']);

    type ExportsValue = string | null | ExportsValue[] | { [k: string]: ExportsValue };

    /** Locate the package root WITHOUT resolving its entry point. A broken or
     * CJS-pointing exports map must still be inspectable, and Nest's `"./*"`
     * map makes `<pkg>/package.json` resolve to `package.json.js`. */
    function packageRoot(name: string): string {
      for (const dir of require.resolve.paths(name) ?? []) {
        const candidate = path.join(dir, name);
        if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      }
      return path.dirname(require.resolve(name));
    }

    /** Pick the target `require` would get, walking conditions in key order. */
    function pickTarget(value: ExportsValue): string | null {
      if (value === null) return null;
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) {
        for (const v of value) {
          const t = pickTarget(v);
          if (t !== null) return t;
        }
        return null;
      }
      for (const [cond, v] of Object.entries(value)) {
        if (REQUIRE_CONDITIONS.has(cond)) {
          const t = pickTarget(v);
          if (t !== null) return t;
        }
      }
      return null;
    }

    /** Subpath -> exports value, normalising the sugar forms. */
    function subpaths(exportsField: ExportsValue | undefined, main: string | undefined) {
      if (exportsField === undefined) return { '.': main ?? './index.js' } as Record<string, ExportsValue>;
      if (
        typeof exportsField === 'string' ||
        Array.isArray(exportsField) ||
        exportsField === null ||
        !Object.keys(exportsField).some((k) => k.startsWith('.'))
      ) {
        return { '.': exportsField } as Record<string, ExportsValue>;
      }
      return exportsField;
    }

    /** Node's format rule: extension first, else the nearest package.json "type". */
    function formatOf(root: string, target: string): 'esm' | 'cjs' {
      if (target.endsWith('.cjs')) return 'cjs';
      if (target.endsWith('.mjs')) return 'esm';
      // A pattern target ("./*.js"): the scope is the directory before the "*".
      const concrete = target.includes('*') ? target.slice(0, target.indexOf('*')) : target;
      let dir = path.dirname(path.resolve(root, concrete.endsWith('/') ? `${concrete}x` : concrete));
      for (;;) {
        const pj = path.join(dir, 'package.json');
        if (fs.existsSync(pj)) {
          const type = (JSON.parse(fs.readFileSync(pj, 'utf8')) as { type?: string }).type;
          return type === 'module' ? 'esm' : 'cjs';
        }
        if (dir === root || dir === path.dirname(dir)) return 'cjs';
        dir = path.dirname(dir);
      }
    }

    it.each(['@nestjs/common', '@nestjs/core'])(
      '%s exports no CommonJS target for require',
      (name) => {
        const root = packageRoot(name);
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
          exports?: ExportsValue;
          main?: string;
          version?: string;
        };
        const cjs: string[] = [];
        for (const [subpath, value] of Object.entries(subpaths(pkg.exports, pkg.main))) {
          const target = pickTarget(value);
          if (target !== null && formatOf(root, target) === 'cjs') {
            cjs.push(`${subpath} -> ${target}`);
          }
        }
        if (cjs.length > 0) {
          throw new Error(
            `${name}@${pkg.version} now resolves \`require\` to CommonJS (${cjs.join(', ')}). ` +
              'Jest can load it natively, so the @swc/jest transform for @nestjs/* is no ' +
              'longer needed: in THIS PR, delete the "/node_modules/@nestjs/.+\\.js$" ' +
              'transform key and `transformIgnorePatterns` from BOTH package.json\'s `jest` ' +
              'block and test/jest.integration.config.ts, then update this spec and ' +
              'docs/TESTING.md (issue #191).',
          );
        }
        expect(cjs).toEqual([]);
      },
    );
  });
});
