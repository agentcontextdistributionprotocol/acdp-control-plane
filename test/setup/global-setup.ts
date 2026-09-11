import { execSync } from 'node:child_process';
import { Client } from 'pg';
import { redactUrl, truncateAll } from '../helpers/test-db';

const TEST_DB_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/acdp_control_plane_test';

/* eslint-disable no-console */
export default async function globalSetup(): Promise<void> {
  if (!process.env.CI) {
    try {
      execSync(
        'docker compose -f docker-compose.test.yml up -d postgres-test --wait',
        { stdio: 'inherit', cwd: process.cwd() },
      );
    } catch {
      console.warn(
        'Could not start docker compose. Assuming postgres-test is already running.',
      );
    }
  }

  // Retry until reachable, then surface WHY on give-up. The bare
  // "Test database not reachable" this used to throw named neither the target nor
  // the underlying driver error, which makes the most common real failure —
  // another process already owning the published port, so `docker compose --wait`
  // reports Healthy while connections land on a foreign server — look identical to
  // a database that is merely slow to start. Postgres reports that case as
  // `database "..." does not exist` (3D000); carrying that text up is the whole
  // difference between a ten-second mystery and an obvious diagnosis.
  let retries = 20;
  let lastError: unknown;
  while (retries > 0) {
    try {
      const client = new Client({ connectionString: TEST_DB_URL });
      await client.connect();
      await client.end();
      break;
    } catch (err) {
      lastError = err;
      retries--;
      if (retries === 0) {
        const detail = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(
          `Test database not reachable at ${redactUrl(TEST_DB_URL)} after 20 attempts: ` +
            `${detail}. If this says the database does not exist, another process likely ` +
            `owns that port — check \`lsof -nP -iTCP:<port> -sTCP:LISTEN\` and ` +
            `\`docker ps\` across every Docker context (\`docker context ls\`).`,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  process.env.DATABASE_URL = TEST_DB_URL;

  // Start every run from a clean database, not merely end one clean. Per-spec
  // cleanup makes the suite's final state depend on which spec happens to run
  // last, so a database reused across runs can hand leftover rows to whichever
  // spec runs first. Jest's sequencer orders previously-failed specs first, which
  // turns one local failure into a differently-ordered — and differently-failing
  // — next run. Truncating here makes a run's outcome independent of the previous
  // run's. On a first-ever run there are no tables yet and this is a no-op.
  await truncateAll();

  console.log('Integration test global setup complete.');
}
