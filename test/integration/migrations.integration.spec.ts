import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate';
import { TEST_DB_URL } from '../helpers/test-db';

/**
 * The migration runner executes at EVERY boot (main.ts and each test app),
 * so drizzle/*.sql must stay re-runnable against an already-migrated
 * database. This pins that contract explicitly instead of relying on it
 * incidentally holding while other suites boot apps.
 */
describe('Migrations (integration)', () => {
  it('is idempotent — re-running against an already-migrated database is a no-op', async () => {
    await runMigrations(TEST_DB_URL);
    await expect(runMigrations(TEST_DB_URL)).resolves.not.toThrow();
  });

  it('produces the core tables the pipeline writes to', async () => {
    await runMigrations(TEST_DB_URL);
    const pool = new Pool({ connectionString: TEST_DB_URL });
    try {
      const { rows } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      const tables = new Set(rows.map((r) => r.table_name));
      for (const required of [
        'context_events',
        'runs',
        'lineage_edges',
        'agents',
        'registries',
        'webhook_deliveries',
        'receipt_audits',
        'log_witness_checkpoints',
        'log_witness_cursors',
        'log_inclusion_audits',
      ]) {
        expect(tables).toContain(required);
      }
    } finally {
      await pool.end();
    }
  });
});
