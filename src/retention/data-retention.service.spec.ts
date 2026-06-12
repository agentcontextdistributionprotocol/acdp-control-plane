import { DataRetentionService } from './data-retention.service';

function makeDeps(overrides: { enabled?: boolean; ttlDays?: number; lock?: boolean } = {}) {
  const config = {
    dataRetentionEnabled: overrides.enabled ?? true,
    dataRetentionTtlDays: overrides.ttlDays ?? 30,
    dataRetentionIntervalHours: 6,
  } as any;
  const database = {
    tryAdvisoryLock: jest.fn().mockResolvedValue(overrides.lock ?? true),
    advisoryUnlock: jest.fn().mockResolvedValue(undefined),
  };
  const contextEventRepo = { deleteBefore: jest.fn().mockResolvedValue(5) };
  const runRepo = { deleteTerminalBefore: jest.fn().mockResolvedValue(3) };
  const deliveryRepo = { deleteDeliveredBefore: jest.fn().mockResolvedValue(2) };
  const svc = new DataRetentionService(
    config,
    database as any,
    contextEventRepo as any,
    runRepo as any,
    deliveryRepo as any,
  );
  return { svc, config, database, contextEventRepo, runRepo, deliveryRepo };
}

describe('DataRetentionService', () => {
  describe('purge()', () => {
    it('purges each table under an advisory lock and returns per-table counts', async () => {
      const { svc, database, contextEventRepo, runRepo, deliveryRepo } = makeDeps();

      const result = await svc.purge();

      expect(result).toEqual({ events: 5, runs: 3, deliveries: 2 });
      expect(database.tryAdvisoryLock).toHaveBeenCalledWith('acdp-cp-retention');
      // Lock is always released, even on the success path.
      expect(database.advisoryUnlock).toHaveBeenCalledWith('acdp-cp-retention');

      // Each repo is called with the same ISO cutoff string.
      const cutoff = contextEventRepo.deleteBefore.mock.calls[0][0] as string;
      expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(runRepo.deleteTerminalBefore).toHaveBeenCalledWith(cutoff);
      expect(deliveryRepo.deleteDeliveredBefore).toHaveBeenCalledWith(cutoff);
    });

    it('computes the cutoff as now minus TTL days', async () => {
      const { svc, contextEventRepo } = makeDeps({ ttlDays: 10 });
      const before = Date.now();
      await svc.purge();
      const cutoffMs = Date.parse(contextEventRepo.deleteBefore.mock.calls[0][0] as string);
      const expected = before - 10 * 24 * 60 * 60 * 1000;
      // Within a generous tolerance of the expected 10-day-ago instant.
      expect(Math.abs(cutoffMs - expected)).toBeLessThan(60_000);
    });

    it('skips the purge (and never touches repos) when the advisory lock is held elsewhere', async () => {
      const { svc, database, contextEventRepo, runRepo, deliveryRepo } = makeDeps({ lock: false });

      const result = await svc.purge();

      expect(result).toEqual({ events: 0, runs: 0, deliveries: 0 });
      expect(contextEventRepo.deleteBefore).not.toHaveBeenCalled();
      expect(runRepo.deleteTerminalBefore).not.toHaveBeenCalled();
      expect(deliveryRepo.deleteDeliveredBefore).not.toHaveBeenCalled();
      // Lock wasn't acquired, so we must NOT release it.
      expect(database.advisoryUnlock).not.toHaveBeenCalled();
    });

    it('releases the advisory lock even when a repo delete throws', async () => {
      const { svc, database, runRepo } = makeDeps();
      runRepo.deleteTerminalBefore.mockRejectedValue(new Error('db down'));

      await expect(svc.purge()).rejects.toThrow('db down');
      expect(database.advisoryUnlock).toHaveBeenCalledWith('acdp-cp-retention');
    });
  });

  describe('onModuleInit()', () => {
    it('does not start the timer when retention is disabled', () => {
      const { svc, database } = makeDeps({ enabled: false });
      svc.onModuleInit();
      svc.onModuleDestroy();
      expect(database.tryAdvisoryLock).not.toHaveBeenCalled();
    });

    it('starts (and cleanly stops) the sweep timer when enabled', () => {
      const { svc } = makeDeps({ enabled: true });
      const setSpy = jest.spyOn(global, 'setInterval');
      svc.onModuleInit();
      expect(setSpy).toHaveBeenCalled();
      // Destroy clears the timer — no throw, idempotent.
      svc.onModuleDestroy();
      svc.onModuleDestroy();
      setSpy.mockRestore();
    });
  });
});
