import { Pool } from 'pg';

export const TEST_DB_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/acdp_control_plane_test';

/**
 * The one table `truncateAll` must never clear: `runMigrations()` records applied
 * migrations here, and the integration suite applies them once in globalSetup.
 * Truncating it would make every subsequent spec re-run all migrations.
 */
const PRESERVED_TABLES = ['_migrations'];

/**
 * Guard against truncating something that is not a test database.
 *
 * This matters more since the table list became dynamic: the old hardcoded
 * TRUNCATE failed loudly against a foreign database ('relation
 * "webhook_deliveries" does not exist'), whereas "every table in `public`" will
 * cheerfully wipe whatever it is pointed at. Overriding `DATABASE_URL` is a
 * normal workflow — a machine where another process owns the usual port is
 * exactly the situation that prompts it — so require an opt-in `_test` suffix.
 *
 * `name` MUST come from `select current_database()` on the pool being truncated,
 * never from parsing `TEST_DB_URL`. An earlier version validated the module's
 * default URL while truncating a caller-supplied pool, so the guard never saw the
 * database it was protecting: passing a pool aimed elsewhere wiped it without a
 * word. Asking the connection itself is the only answer that cannot drift from
 * the target. `url` is carried purely for the error message.
 *
 * Known limit, stated rather than papered over: a *foreign* database that happens
 * to end in `_test` still passes — including `aitp_control_plane_test`, the very
 * database this phase found squatting on port 5433. The defense against that case
 * is the loud connection error in `global-setup.ts`, not this check. This guard
 * stops the catastrophic case (a non-test database), not every wrong one.
 */
function assertTestDatabase(name: string, url: string): void {
  if (!name.endsWith('_test')) {
    throw new Error(
      `truncateAll: refusing to truncate database '${name}' — it does not end in ` +
        `'_test'. truncateAll wipes every table in the 'public' schema, so it only ` +
        `runs against a database explicitly named as a test database. Target: ` +
        `${redactUrl(url)}`,
    );
  }
}

/** Strip the password from a connection string before it reaches a log or error. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<unparseable connection string>';
  }
}

/**
 * Truncate all tables to ensure clean state between tests. CASCADE handles
 * foreign-key relationships; retries handle transient deadlocks.
 *
 * The table list is discovered from `pg_tables` rather than hardcoded. It used to
 * be a literal list, which silently drifted as the schema grew: by 2026-09 it was
 * missing `agent_capabilities`, `auth_challenges`, `issuance_ledger`,
 * `revocation_cursors` and `revoked_tokens`. Because CI provisions a fresh
 * Postgres service container per run, the leak was invisible there — but running
 * the suite twice against one database failed on
 * `revocation-repository.contract.ts:86` ("returns null before any cursor is set"
 * received a cursor left over from the previous run). Discovering the list keeps
 * a newly added table from re-introducing that class of failure.
 */
export async function truncateAll(pool?: Pool): Promise<void> {
  const p = pool ?? new Pool({ connectionString: TEST_DB_URL });
  const ownPool = !pool;

  const maxRetries = 3;
  try {
    // Ask the connection which database it is on, rather than trusting a URL that
    // may describe a different one. See assertTestDatabase.
    const { rows } = await p.query<{ db: string }>('select current_database() as db');
    assertTestDatabase(rows[0].db, TEST_DB_URL);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // PRESERVED_TABLES is a module-level constant of plain identifiers and is
        // never user input, so inlining it as a literal IN-list carries no
        // injection surface. A DO block takes no bind parameters, hence no $1.
        // Names are schema-qualified so the statement does not depend on
        // search_path containing 'public', and ordered so every session takes
        // locks in the same sequence — an unordered string_agg would let two
        // concurrent truncates grab tables in opposite orders and deadlock, which
        // is exactly what the 40P01 retry below exists to absorb.
        const preserved = PRESERVED_TABLES.map((t) => `'${t}'`).join(', ');
        await p.query(`
          DO $$
          DECLARE
            target text;
          BEGIN
            SELECT string_agg(
                     quote_ident(schemaname) || '.' || quote_ident(tablename),
                     ', ' ORDER BY tablename
                   )
              INTO target
              FROM pg_tables
             WHERE schemaname = 'public'
               AND tablename NOT IN (${preserved});
            IF target IS NOT NULL THEN
              EXECUTE 'TRUNCATE ' || target || ' CASCADE';
            END IF;
          END $$;
        `);
        return;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === '40P01' && attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  } finally {
    if (ownPool) await p.end();
  }
}

export function createTestPool(): Pool {
  return new Pool({ connectionString: TEST_DB_URL, max: 5 });
}
