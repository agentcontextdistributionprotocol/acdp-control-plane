import { Injectable } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { RegistryEnrollment, registryEnrollments } from '../db/schema';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';

/**
 * Enrollment upsert input. For the three nullable fields the distinction
 * between `undefined` and `null` is load-bearing on the UPDATE (re-enroll)
 * path — see {@link buildEnrollmentUpdateSet}: `undefined` = omitted, keep
 * the stored value; `null` = explicitly clear it.
 */
export interface EnrollRegistryInput {
  authority: string;
  tenantId?: string;
  baseUrl?: string | null | undefined;
  registryDid?: string | null | undefined;
  webhookSecret?: string | null | undefined;
  /** NOT NULL column: `null`/`undefined` both mean "omitted" (never written as NULL). */
  enabled?: boolean | null | undefined;
}

/** The column subset a re-enroll may write (never `tenantId` / `createdAt`). */
export type EnrollmentUpdateSet = Partial<
  Pick<RegistryEnrollment, 'baseUrl' | 'registryDid' | 'webhookSecret' | 'enabled'>
> &
  Pick<RegistryEnrollment, 'updatedAt'>;

/**
 * Build the `ON CONFLICT DO UPDATE SET` object for a re-enroll with
 * PATCH-like semantics (tenant-enroll-quota-fix P2). Built conditionally in
 * TS rather than with SQL `coalesce(excluded.x, x)`, because `excluded.x` is
 * NULL both for an omitted field and an explicit null, so SQL cannot tell
 * "keep" from "clear":
 *  - nullable fields: key ABSENT when the input is `undefined` (stored value
 *    kept), `null` written when the input is `null` (cleared), value otherwise;
 *  - `enabled` (NOT NULL): written only when a boolean — `null` and
 *    `undefined` are both "omitted", so a re-enroll never re-enables an
 *    operator-disabled registry and never writes NULL;
 *  - `updatedAt` always; `tenantId` and `createdAt` never.
 */
export function buildEnrollmentUpdateSet(
  input: EnrollRegistryInput,
  now: string,
): EnrollmentUpdateSet {
  const set: EnrollmentUpdateSet = { updatedAt: now };
  if (input.baseUrl !== undefined) set.baseUrl = input.baseUrl;
  if (input.registryDid !== undefined) set.registryDid = input.registryDid;
  if (input.webhookSecret !== undefined) set.webhookSecret = input.webhookSecret;
  if (typeof input.enabled === 'boolean') set.enabled = input.enabled;
  return set;
}

@Injectable()
export class RegistryEnrollmentRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Create or update the enrollment for an authority (authority is the PK).
   *
   * The tenant binding is IMMUTABLE once written: an authority is bound to
   * exactly one tenant, and ingest resolves the tenant from the authority
   * alone (before HMAC), so re-pointing it would silently move a registry's
   * traffic into another tenant. The conflict branch therefore never writes
   * `tenantId`, and only fires when the existing row's tenant equals the
   * requested one (`setWhere`). Because the check is part of the single
   * `INSERT … ON CONFLICT … DO UPDATE … WHERE` statement it is atomic — no
   * check-then-write race; concurrent first-enrolls serialize on the PK.
   *
   * A FIRST enroll inserts with defaults (omitted nullable fields → NULL,
   * `enabled` → true). A RE-enroll (same tenant) is PATCH-like: omitted fields
   * keep their stored values, explicit `null` clears — see
   * {@link buildEnrollmentUpdateSet}.
   *
   * Returns the inserted/updated row, or `null` when the authority is already
   * enrolled under a DIFFERENT tenant (`RETURNING` is empty because the
   * conflict update was suppressed) — the row is left untouched.
   */
  async upsert(input: EnrollRegistryInput): Promise<RegistryEnrollment | null> {
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
        // `tenantId` is deliberately absent — see the docblock.
        // PATCH-like: only the fields the caller supplied (see the builder).
        set: buildEnrollmentUpdateSet(input, now),
        setWhere: sql`${registryEnrollments.tenantId} = excluded.tenant_id`,
      })
      .returning();
    return rows[0] ?? null;
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
