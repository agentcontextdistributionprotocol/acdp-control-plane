/**
 * Storage for agent capability declarations.
 *
 * `declare()` is idempotent — re-declaring the same `(agent_did,
 * capability_uri)` pair is a no-op (returns the prior row's
 * `declared_at`). Discovery queries are O(1) by capability_uri thanks
 * to the secondary index on `agent_capabilities.capability_uri`.
 *
 * Multi-tenant: every read filters by `tenant_id`. Writes default to
 * `DEFAULT_TENANT_ID` when the caller doesn't specify (backward
 * compat with single-tenant deployments).
 */
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { agentCapabilities, AgentCapability, NewAgentCapability } from '../db/schema';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';

export interface CapabilityRow {
  agentDid: string;
  capabilityUri: string;
  declaredAt: string;
  signedBy: string;
}

@Injectable()
export class CapabilityRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Insert-or-no-op. Returns the stored `(agentDid, capabilityUri,
   * declaredAt)` triple — the caller surfaces `declaredAt` so the
   * agent can observe the server-pinned timestamp.
   */
  async declare(row: NewAgentCapability): Promise<CapabilityRow> {
    const tenantId = row.tenantId ?? DEFAULT_TENANT_ID;
    const inserted = await this.db.db
      .insert(agentCapabilities)
      .values({ ...row, tenantId })
      .onConflictDoNothing({
        target: [
          agentCapabilities.tenantId,
          agentCapabilities.agentDid,
          agentCapabilities.capabilityUri,
        ],
      })
      .returning();
    if (inserted.length > 0) return rowToTriple(inserted[0]!);

    // Already exists — return the existing row's metadata.
    const existing = await this.db.db
      .select()
      .from(agentCapabilities)
      .where(
        and(
          eq(agentCapabilities.agentDid, row.agentDid),
          eq(agentCapabilities.capabilityUri, row.capabilityUri),
          eq(agentCapabilities.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (existing.length === 0) {
      // ON CONFLICT + RETURNING-empty + SELECT-empty implies the row
      // was deleted between the two statements — return what the
      // caller gave us as the best-effort answer.
      return {
        agentDid: row.agentDid,
        capabilityUri: row.capabilityUri,
        declaredAt: new Date().toISOString(),
        signedBy: row.signedBy,
      };
    }
    return rowToTriple(existing[0]!);
  }

  async findByAgent(
    agentDid: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<CapabilityRow[]> {
    const rows = await this.db.db
      .select()
      .from(agentCapabilities)
      .where(
        and(
          eq(agentCapabilities.agentDid, agentDid),
          eq(agentCapabilities.tenantId, tenantId),
        ),
      );
    return rows.map(rowToTriple);
  }

  async findByCapability(
    capabilityUri: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<CapabilityRow[]> {
    const rows = await this.db.db
      .select()
      .from(agentCapabilities)
      .where(
        and(
          eq(agentCapabilities.capabilityUri, capabilityUri),
          eq(agentCapabilities.tenantId, tenantId),
        ),
      );
    return rows.map(rowToTriple);
  }
}

function rowToTriple(r: AgentCapability): CapabilityRow {
  return {
    agentDid: r.agentDid,
    capabilityUri: r.capabilityUri,
    declaredAt: r.declaredAt,
    signedBy: r.signedBy,
  };
}
