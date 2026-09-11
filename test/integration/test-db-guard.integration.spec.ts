/**
 * Regression coverage for `truncateAll`'s non-test-database guard.
 *
 * WHY THIS FILE EXISTS. `truncateAll` discovers its targets from `pg_tables` and
 * issues `TRUNCATE ... CASCADE` over every table in the `public` schema. The only
 * thing standing between that and a non-test database is `assertTestDatabase`
 * (`test/helpers/test-db.ts`), and until this spec the guard had NO automated
 * coverage at all — `ASSUMPTIONS.md` claimed a negative test that was in fact a
 * manual one-off run during the phase.
 *
 * That gap is not theoretical. An earlier revision of the guard validated the
 * module's default `TEST_DB_URL` while truncating a CALLER-SUPPLIED pool, so it
 * never inspected the database it was protecting — and it wiped a decoy database
 * during phase verification. The fix was to derive the name from
 * `select current_database()` on the pool actually being truncated. A refactor
 * reintroducing that bug would ship green without this spec, because every other
 * integration spec points at a correctly-named `*_test` database and so can never
 * exercise the refusal path.
 *
 * WHAT IT PINS. Both halves of the guard:
 *   1. the name is read from the CONNECTION, not from a URL — proved by handing
 *      `truncateAll` a pool aimed at a differently-named database than
 *      `TEST_DB_URL` describes, and requiring it to refuse;
 *   2. the error redacts the password, so a CI log never carries a credential.
 * Plus the property that actually matters: the rows are still there afterwards.
 */
import { Pool } from 'pg';
import { TEST_DB_URL, redactUrl, truncateAll } from '../helpers/test-db';

/** Same server, but the `postgres` maintenance database — whose name does not
 *  end in `_test`, so the guard must refuse it. Using an existing database keeps
 *  this spec from needing CREATE DATABASE rights. */
function maintenanceDbUrl(): string {
  const u = new URL(TEST_DB_URL);
  u.pathname = '/postgres';
  return u.toString();
}

const CANARY_TABLE = 'truncate_guard_canary';

describe('truncateAll refuses a non-test database', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: maintenanceDbUrl() });
    await pool.query(`drop table if exists public.${CANARY_TABLE}`);
    await pool.query(`create table public.${CANARY_TABLE} (id int primary key)`);
    await pool.query(`insert into public.${CANARY_TABLE} (id) values (1), (2), (3)`);
  });

  afterAll(async () => {
    await pool.query(`drop table if exists public.${CANARY_TABLE}`);
    await pool.end();
  });

  it('rejects, naming the database and explaining why', async () => {
    // Sanity: we really are pointed somewhere the guard should reject, and it is
    // NOT the database TEST_DB_URL describes — which is the whole point, since a
    // guard that reads the URL instead of the connection would wrongly allow this.
    const { rows } = await pool.query<{ db: string }>('select current_database() as db');
    expect(rows[0].db).toBe('postgres');
    expect(new URL(TEST_DB_URL).pathname.slice(1)).not.toBe(rows[0].db);

    await expect(truncateAll(pool)).rejects.toThrow(
      /refusing to truncate database 'postgres'/,
    );
  });

  it('never puts the password in the error message', async () => {
    const password = new URL(TEST_DB_URL).password;
    const err: unknown = await truncateAll(pool).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    const { message } = err as Error;
    // Assert the credential POSITION, not a bare substring. The default fixture
    // password is `postgres`, which is also the username, the maintenance database
    // name and part of the scheme — so `not.toContain(password)` could never pass
    // and would have failed on a correctly-redacted message. What actually matters
    // is that no `:<password>@` appears in the userinfo slot.
    if (password) {
      expect(message).not.toContain(`:${password}@`);
      expect(message).toContain(':***@');
    }
  });

  it('leaves the data intact — the assertion the guard exists for', async () => {
    await truncateAll(pool).catch(() => undefined);

    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from public.${CANARY_TABLE}`,
    );
    expect(rows[0].count).toBe('3');
  });
});

describe('redactUrl', () => {
  it('replaces the password and leaves the rest addressable', () => {
    const out = redactUrl('postgres://user:hunter2@localhost:5433/acdp_control_plane_test');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('***');
    expect(out).toContain('localhost:5433');
    expect(out).toContain('acdp_control_plane_test');
  });

  it('degrades to a placeholder rather than throwing on an unparseable string', () => {
    expect(redactUrl('not a url')).toBe('<unparseable connection string>');
  });
});
