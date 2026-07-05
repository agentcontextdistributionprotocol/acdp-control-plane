import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { RegistryEnrollment, registryEnrollments } from '../db/schema';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';

export interface EnrollRegistryInput {
  authority: string;
  tenantId?: string;
  baseUrl?: string | null;
  registryDid?: string | null;
  webhookSecret?: string | null;
  enabled?: boolean;
}

@Injectable()
export class RegistryEnrollmentRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Create or update the enrollment for an authority (authority is the PK). */
  async upsert(input: EnrollRegistryInput): Promise<RegistryEnrollment> {
    const now = new Date().toISOString();
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
    const rows = await this.database.db
      .insert(registryEnrollments)
      .values({
        authority: input.authority,
        tenantId,
        baseUrl: input.baseUrl ?? null,
        registryDid: input.registryDid ?? null,
        webhookSecret: input.webhookSecret ?? null,
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: registryEnrollments.authority,
        set: {
          tenantId,
          baseUrl: input.baseUrl ?? null,
          registryDid: input.registryDid ?? null,
          webhookSecret: input.webhookSecret ?? null,
          enabled: input.enabled ?? true,
          updatedAt: now,
        },
      })
      .returning();
    return rows[0];
  }

  /** Lookup by authority. Authority is globally unique → one tenant. */
  async findByAuthority(authority: string): Promise<RegistryEnrollment | null> {
    const rows = await this.database.db
      .select()
      .from(registryEnrollments)
      .where(eq(registryEnrollments.authority, authority))
      .limit(1);
    return rows[0] ?? null;
  }

  async list(tenantId: string = DEFAULT_TENANT_ID): Promise<RegistryEnrollment[]> {
    return this.database.db
      .select()
      .from(registryEnrollments)
      .where(eq(registryEnrollments.tenantId, tenantId))
      .orderBy(desc(registryEnrollments.updatedAt));
  }

  /**
   * All ENABLED enrollments across every tenant — background pollers (the
   * checkpoint witness) iterate these; each row carries its own tenantId.
   */
  async listAllEnabled(): Promise<RegistryEnrollment[]> {
    return this.database.db
      .select()
      .from(registryEnrollments)
      .where(eq(registryEnrollments.enabled, true))
      .orderBy(registryEnrollments.authority);
  }

  /** Count of all enrollments — used to decide whether enrollment is in effect. */
  async count(): Promise<number> {
    const rows = await this.database.db
      .select({ authority: registryEnrollments.authority })
      .from(registryEnrollments);
    return rows.length;
  }
}
