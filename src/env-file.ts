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
 * config. EISDIR gets an actionable hint appended (see `withEisdirHint`). No `${VAR}` expansion; `KEY: value` lines are not supported.
 *
 * Kept free of any environment-global reference (CI rule 3) so it needs no
 * exemption; the side effect lives in `load-env.ts`.
 */
export function applyEnvFile(target: Record<string, string | undefined>, path = '.env'): number {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 0;
    if (code === 'EISDIR') throw withEisdirHint(err as NodeJS.ErrnoException, path);
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

/**
 * EISDIR alone ("illegal operation on a directory, read") does not say WHY the
 * `.env` is a directory. By far the likeliest cause is a Docker bind mount of a
 * host file that does not exist (`-v ./.env:/app/.env`, or the compose
 * `volumes:` equivalent): Docker then creates a DIRECTORY at both ends. The
 * original error object is amended in place (message AND stack — the stack is
 * what an uncaught error prints), so `code`/`errno`/`syscall` stay intact.
 */
function withEisdirHint(err: NodeJS.ErrnoException, path: string): NodeJS.ErrnoException {
  const original = err.message;
  const hint =
    ` — the .env path ${JSON.stringify(path)} is a directory, not a file. Likely cause: a ` +
    'Docker bind mount such as `-v ./.env:/app/.env` (or a compose `volumes:` entry) of a ' +
    'file that does not exist on the host, which makes Docker create a directory. Create the ' +
    'file on the host (or drop the mount), remove the stray directory, and recreate the container.';
  // Read the stack BEFORE touching the message: V8 formats it lazily, so a
  // stack first read after the edit would already carry the hint (doubled below).
  const stack = err.stack;
  err.message = original + hint;
  if (typeof stack === 'string' && stack.includes(original)) {
    err.stack = stack.replace(original, err.message);
  }
  return err;
}
