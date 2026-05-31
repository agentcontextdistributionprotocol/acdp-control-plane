import { Pool } from 'pg';

export const TEST_DB_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/acdp_control_plane_test';

/**
 * Truncate all tables to ensure clean state between tests. CASCADE handles
 * foreign-key relationships; retries handle transient deadlocks.
 */
export async function truncateAll(pool?: Pool): Promise<void> {
  const p = pool ?? new Pool({ connectionString: TEST_DB_URL });
  const ownPool = !pool;

  const maxRetries = 3;
  try {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await p.query(`
          TRUNCATE
            webhook_deliveries,
            webhooks,
            lineage_edges,
            context_events,
            agents,
            registries,
            registry_enrollments,
            runs
          CASCADE
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
