import { HealthController } from './health.controller';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../db/database.service';

describe('HealthController', () => {
  const config = { clientVersion: '0.1.0' } as AppConfigService;

  function makeController(query: () => Promise<unknown>, hasFatalError = false) {
    const database = {
      pool: { query },
      hasFatalError,
    } as unknown as DatabaseService;
    return new HealthController(database, config);
  }

  describe('healthz', () => {
    it('reports ok and the configured version when the DB check succeeds', async () => {
      const controller = makeController(() => Promise.resolve({ rows: [{ ok: 1 }] }));

      await expect(controller.healthz()).resolves.toEqual({
        ok: true,
        service: 'acdp-control-plane',
        version: '0.1.0',
      });
    });

    it('reports ok: false, but still returns version, when the DB check throws', async () => {
      const controller = makeController(() => Promise.reject(new Error('connection refused')));

      await expect(controller.healthz()).resolves.toEqual({
        ok: false,
        service: 'acdp-control-plane',
        version: '0.1.0',
      });
    });

    it('reports ok: false when the DB check succeeds but a fatal error is latched', async () => {
      const controller = makeController(() => Promise.resolve({ rows: [{ ok: 1 }] }), true);

      await expect(controller.healthz()).resolves.toEqual({
        ok: false,
        service: 'acdp-control-plane',
        version: '0.1.0',
      });
    });
  });
});
