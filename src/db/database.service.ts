import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { AppConfigService } from '../config/app-config.service';
import { ShutdownFailures } from '../shutdown-failures';
import * as schema from './schema';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;
  readonly db: NodePgDatabase<typeof schema>;
  hasFatalError = false;

  constructor(
    config: AppConfigService,
    // Optional so unit specs can construct the service bare; the app always
    // provides it (ShutdownFailuresModule is global).
    @Optional() private readonly shutdownFailures?: ShutdownFailures,
  ) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax,
      idleTimeoutMillis: config.dbPoolIdleTimeout,
      connectionTimeoutMillis: config.dbPoolConnectionTimeout,
    });
    this.pool.on('error', (err) => {
      this.logger.error({ msg: 'database pool error', error: err.message });
      this.hasFatalError = true;
    });
    this.db = drizzle(this.pool, { schema });
  }

  async onModuleDestroy(): Promise<void> {
    // Tracked: under NestJS 12 a rejection here no longer rejects app.close(),
    // so without the collector a failed pool shutdown would exit 0 (#155).
    if (this.shutdownFailures) {
      await this.shutdownFailures.track('database pool', () => this.pool.end());
    } else {
      await this.pool.end();
    }
  }

  async tryAdvisoryLock(key: string): Promise<boolean> {
    const result = await this.db.execute(
      sql`SELECT pg_try_advisory_lock(hashtext(${key})) AS acquired`,
    );
    return (result.rows[0] as { acquired: boolean })?.acquired === true;
  }

  async advisoryUnlock(key: string): Promise<void> {
    await this.db.execute(sql`SELECT pg_advisory_unlock(hashtext(${key}))`);
  }
}
