import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../db/database.service';
import { DashboardService } from './dashboard.service';

/**
 * Auto-chaining thenable stub for Drizzle's fluent `db.select()` builder.
 * Every property access (`.from`, `.where`, `.orderBy`, `.limit`, ...)
 * returns the same proxy, so any chain shape resolves without needing
 * per-call fidelity; only `then` actually resolves, to `resolvedValue`.
 */
function chainable(resolvedValue: unknown): any {
  const proxy: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(resolvedValue);
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}

type FlagOverrides = Partial<{
  receiptAuditEnabled: boolean;
  keyRevocationCheckEnabled: boolean;
  logWitnessEnabled: boolean;
  logInclusionAuditEnabled: boolean;
  witnessCosigningEnabled: boolean;
  witnessQuorumEnabled: boolean;
}>;

function build(flags: FlagOverrides = {}) {
  const execute = jest.fn().mockResolvedValue({ rows: [] });
  const select = jest.fn(() => chainable([]));
  const database = { db: { select, execute } } as unknown as DatabaseService;
  const config = {
    receiptAuditEnabled: false,
    keyRevocationCheckEnabled: false,
    logWitnessEnabled: false,
    logInclusionAuditEnabled: false,
    witnessCosigningEnabled: false,
    witnessQuorumEnabled: false,
    ...flags,
  } as unknown as AppConfigService;
  return { service: new DashboardService(database, config), execute };
}

/**
 * Issue #176: `keyRevocation`/`logWitness` were built unconditionally with
 * `?? 0` defaults, so "checked, clean" and "never checked" produced the
 * identical all-zero shape. These tests prove the fix at the unit level —
 * including the query-skip efficiency claim the integration suite can't
 * observe (it only sees response shape, never how many queries actually ran).
 */
describe('DashboardService — feature-flag gated tiles (#176)', () => {
  it('nulls keyRevocation/logWitness and skips their queries when both flags are off', async () => {
    const { service, execute } = build();
    const overview = await service.getOverview({});

    expect(overview.keyRevocation).toBeNull();
    expect(overview.logWitness).toBeNull();
    expect(overview.features).toEqual({
      receiptAudit: false,
      keyRevocationCheck: false,
      logWitness: false,
      logInclusionAudit: false,
      witnessCosigning: false,
      witnessQuorum: false,
    });
    // 5 unconditional db.execute()-backed queries (the other 4 use
    // db.select()) — the two gated ones must be skipped entirely, not
    // run-then-discarded.
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it('populates keyRevocation/logWitness and runs their queries when both flags are on', async () => {
    const { service, execute } = build({
      receiptAuditEnabled: true,
      keyRevocationCheckEnabled: true,
      logWitnessEnabled: true,
    });
    const overview = await service.getOverview({});

    expect(overview.keyRevocation).toEqual({
      preCompromise: 0,
      revokedAtOrAfter: 0,
      revokedTimeUnverifiable: 0,
    });
    expect(overview.logWitness).toEqual({
      witnessedLogs: 0,
      activeAlerts: 0,
      unacknowledgedAlerts: 0,
      headsMeetingQuorum: 0,
    });
    expect(overview.features.keyRevocationCheck).toBe(true);
    expect(overview.features.logWitness).toBe(true);
    expect(execute).toHaveBeenCalledTimes(7);
  });

  it('reports the remaining flags in features independent of the tile-gating ones', async () => {
    const { service } = build({
      logInclusionAuditEnabled: true,
      witnessCosigningEnabled: true,
      witnessQuorumEnabled: true,
    });
    const overview = await service.getOverview({});

    expect(overview.features).toEqual({
      receiptAudit: false,
      keyRevocationCheck: false,
      logWitness: false,
      logInclusionAudit: true,
      witnessCosigning: true,
      witnessQuorum: true,
    });
    // Neither gated tile turns on just because unrelated flags did.
    expect(overview.keyRevocation).toBeNull();
    expect(overview.logWitness).toBeNull();
  });
});
