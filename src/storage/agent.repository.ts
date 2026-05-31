import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { Agent, agents } from '../db/schema';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';

@Injectable()
export class AgentRepository {
  constructor(private readonly database: DatabaseService) {}

  async upsert(
    agentDid: string,
    registryAuthority?: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.database.db
      .insert(agents)
      .values({
        agentDid,
        tenantId,
        firstSeen: now,
        lastSeen: now,
        registryAuthority: registryAuthority || null,
        contextCount: 1,
      })
      .onConflictDoUpdate({
        target: [agents.tenantId, agents.agentDid],
        set: {
          lastSeen: now,
          contextCount: sql`${agents.contextCount} + 1`,
          ...(registryAuthority
            ? { registryAuthority: registryAuthority }
            : {}),
        },
      });
  }

  async findByDid(
    agentDid: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<Agent | null> {
    const rows = await this.database.db
      .select()
      .from(agents)
      .where(and(eq(agents.agentDid, agentDid), eq(agents.tenantId, tenantId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async list(
    limit = 200,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<Agent[]> {
    return this.database.db
      .select()
      .from(agents)
      .where(eq(agents.tenantId, tenantId))
      .orderBy(desc(agents.lastSeen))
      .limit(limit);
  }
}
