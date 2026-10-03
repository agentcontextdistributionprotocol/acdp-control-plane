import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IssuanceLedgerService } from './auth/issuance-ledger.service';
import { AppConfigService } from './config/app-config.service';
import { DatabaseService } from './db/database.service';
import { StreamHubService } from './events/stream-hub.service';
import { StreamHubStrategy } from './events/stream-hub.interface';
import { QuotaModule } from './quota/quota.module';
import { QuotaStore } from './quota/quota-store';
import { ShutdownFailures, ShutdownFailuresModule } from './shutdown-failures';

describe('ShutdownFailures', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  it('starts empty', () => {
    const f = new ShutdownFailures();
    expect(f.any()).toBe(false);
    expect(f.list()).toEqual([]);
  });

  it('records a failure with its step name and logs it as structured fields', () => {
    const f = new ShutdownFailures();
    const err = new Error('pool exploded');
    f.record('database pool', err);

    expect(f.any()).toBe(true);
    expect(f.list()).toEqual([{ name: 'database pool', error: err }]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'database pool', error: 'pool exploded' }),
    );
  });

  it('still records when the logger throws', () => {
    errorSpy.mockImplementation(() => {
      throw new Error('logger down');
    });
    const f = new ShutdownFailures();
    expect(() => f.record('x', 'non-error reason')).not.toThrow();
    expect(f.any()).toBe(true);
  });

  describe('track', () => {
    it('runs a succeeding step without recording anything', async () => {
      const f = new ShutdownFailures();
      const step = jest.fn(async () => undefined);
      await expect(f.track('ok', step)).resolves.toBeUndefined();
      expect(step).toHaveBeenCalledTimes(1);
      expect(f.any()).toBe(false);
    });

    it('records AND rethrows a rejecting step, so Nest still logs it', async () => {
      const f = new ShutdownFailures();
      const err = new Error('Called end on pool more than once');
      await expect(f.track('database pool', () => Promise.reject(err))).rejects.toBe(err);
      expect(f.list()).toEqual([{ name: 'database pool', error: err }]);
    });

    it('records a synchronous throw too', async () => {
      const f = new ShutdownFailures();
      await expect(
        f.track('stream hub', () => {
          throw new Error('sync boom');
        }),
      ).rejects.toThrow('sync boom');
      expect(f.any()).toBe(true);
    });
  });
});

/**
 * Every resource-owning destroy hook must route its teardown through the
 * collector. Otherwise, under NestJS 12 (which only logs hook rejections),
 * its failure exits 0 (issue #155).
 */
describe('resource-owning destroy hooks report into ShutdownFailures', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  const config = {
    databaseUrl: 'postgres://u:p@127.0.0.1:1/none',
    dbPoolMax: 1,
    dbPoolIdleTimeout: 1000,
    dbPoolConnectionTimeout: 1000,
    authPersistence: 'memory',
  } as unknown as AppConfigService;

  it('DatabaseService: a failing pool.end() is recorded and rethrown', async () => {
    const f = new ShutdownFailures();
    const svc = new DatabaseService(config, f);
    const realEnd = svc.pool.end.bind(svc.pool);
    jest.spyOn(svc.pool, 'end').mockImplementation(async () => {
      await realEnd();
      throw new Error('end failed');
    });

    await expect(svc.onModuleDestroy()).rejects.toThrow('end failed');
    expect(f.list().map((x) => x.name)).toEqual(['database pool']);
  });

  it('DatabaseService: a clean pool.end() records nothing', async () => {
    const f = new ShutdownFailures();
    const svc = new DatabaseService(config, f);
    await svc.onModuleDestroy();
    expect(f.any()).toBe(false);
  });

  it('DatabaseService: still ends the pool without a collector (bare construction)', async () => {
    const svc = new DatabaseService(config);
    const end = jest.spyOn(svc.pool, 'end');
    await svc.onModuleDestroy();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('StreamHubService: a throwing strategy destroy() is recorded', async () => {
    const f = new ShutdownFailures();
    const strategy = {
      destroy: () => {
        throw new Error('hub teardown failed');
      },
    } as unknown as StreamHubStrategy;
    await expect(new StreamHubService(strategy, f).onModuleDestroy()).rejects.toThrow(
      'hub teardown failed',
    );
    expect(f.list().map((x) => x.name)).toEqual(['stream hub']);
  });

  it('StreamHubService: a strategy without destroy() is a no-op', async () => {
    const f = new ShutdownFailures();
    await new StreamHubService({} as StreamHubStrategy, f).onModuleDestroy();
    expect(f.any()).toBe(false);
  });

  it('QuotaModule: a rejecting store close() is recorded', async () => {
    const f = new ShutdownFailures();
    const store = {
      close: jest.fn(async () => {
        throw new Error('quit failed');
      }),
    } as unknown as QuotaStore;
    await expect(new QuotaModule(store, f).onModuleDestroy()).rejects.toThrow('quit failed');
    expect(f.list().map((x) => x.name)).toEqual(['quota store']);
  });

  it('QuotaModule: a store without close() records nothing', async () => {
    const f = new ShutdownFailures();
    await new QuotaModule({} as QuotaStore, f).onModuleDestroy();
    expect(f.any()).toBe(false);
  });

  it('IssuanceLedgerService: a failing final drain is recorded', async () => {
    const f = new ShutdownFailures();
    const ledger = new IssuanceLedgerService(config, {} as DatabaseService, f);
    jest.spyOn(ledger, 'drain').mockRejectedValue(new Error('drain failed'));
    await expect(ledger.onModuleDestroy()).rejects.toThrow('drain failed');
    expect(f.list().map((x) => x.name)).toEqual(['issuance ledger drain']);
  });

  it('is resolvable from the global module, as main.ts reads it', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ShutdownFailuresModule],
    }).compile();
    expect(moduleRef.get(ShutdownFailures)).toBeInstanceOf(ShutdownFailures);
    await moduleRef.close();
  });
});
