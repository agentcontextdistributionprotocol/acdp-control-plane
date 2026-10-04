import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Loads a `.env` file into `target` (#193; replaces the `dotenv` package).
 *
 * Why `util.parseEnv` behind this helper rather than a bare
 * `process.loadEnvFile()` (measured, see plans/dotenv-to-loadenvfile-193.md):
 *   - a UTF-8 BOM corrupts the first key under `parseEnv`, so it is stripped here;
 *   - `loadEnvFile` reports an UNREADABLE file as ENOENT, so a guard on
 *     existence would crash with "no such file" for a file that exists;
 *   - its no-override rule is only documented for `--env-file`, so the merge
 *     below makes it explicit and pinned by `env-file.spec.ts`.
 *
 * Semantics: the environment wins over the file (an own property, including
 * `""`, is never overwritten); a missing file is a no-op returning 0; any other
 * read error (EACCES, EISDIR, ...) propagates — a `.env` that exists but cannot
 * be read is an operator error, and booting without it would silently drop
 * config. No `${VAR}` expansion; `KEY: value` lines are not supported.
 *
 * Kept free of any environment-global reference (CI rule 3) so it needs no
 * exemption; the side effect lives in `load-env.ts`.
 */
export function applyEnvFile(target: Record<string, string | undefined>, path = '.env'): number {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  const parsed = parseEnv(text.replace(/^\uFEFF/, ''));
  let applied = 0;
  for (const [k, v] of Object.entries(parsed)) {
    if (Object.hasOwn(target, k)) continue;
    target[k] = v;
    applied++;
  }
  return applied;
}
