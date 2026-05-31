import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { Registry, registries } from '../db/schema';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';

@Injectable()
export class RegistryRepository {
  constructor(private readonly database: DatabaseService) {}

  async upsert(
    authority: string,
    baseUrl?: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.database.db
      .insert(registries)
      .values({
        authority,
        tenantId,
        baseUrl: baseUrl ?? null,
        firstSeen: now,
        lastSeen: now,
        eventCount: 1,
      })
      .onConflictDoUpdate({
        target: [registries.tenantId, registries.authority],
        set: {
          lastSeen: now,
          eventCount: sql`${registries.eventCount} + 1`,
          ...(baseUrl ? { baseUrl } : {}),
        },
      });
  }

  async findByAuthority(
    authority: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<Registry | null> {
    const rows = await this.database.db
      .select()
      .from(registries)
      .where(and(eq(registries.authority, authority), eq(registries.tenantId, tenantId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async list(tenantId: string = DEFAULT_TENANT_ID): Promise<Registry[]> {
    return this.database.db
      .select()
      .from(registries)
      .where(eq(registries.tenantId, tenantId))
      .orderBy(desc(registries.lastSeen));
  }
}
