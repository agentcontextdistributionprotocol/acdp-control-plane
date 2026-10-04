import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { HealthController } from './health.controller';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../db/database.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { DrainState } from '../shutdown-drain';

describe('HealthController', () => {
  const config = { clientVersion: '0.1.0', shutdownDrainRetryAfterSeconds: 4 } as AppConfigService;

  function makeController(
    query: () => Promise<unknown>,
    hasFatalError = false,
    drain: DrainState = new DrainState(),
  ) {
    const database = {
      pool: { query },
      hasFatalError,
    } as unknown as DatabaseService;
    return new HealthController(database, config, drain);
  }

  function response() {
    const headers: Record<string, string> = {};
    const res = {
      setHeader: jest.fn((k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      }),
    };
    return { res: res as unknown as Response, headers };
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

  describe('readyz', () => {
    it('reports the database status while serving (no drain)', async () => {
      const query = jest.fn(() => Promise.resolve({ rows: [{ ok: 1 }] }));
      const controller = makeController(query);
      const { res, headers } = response();

      await expect(controller.readyz(res)).resolves.toEqual({ ok: true, database: 'ok' });
      expect(query).toHaveBeenCalledTimes(1);
      expect(headers).toEqual({});
    });

    // #192 Phase 3: readiness = !draining && deps ok, DRAIN-FIRST. The DB is
    // never queried once draining — the pool is about to end.
    it.each([
      ['draining', (d: DrainState) => d.begin()],
      ['closing', (d: DrainState) => d.beginClosing()],
    ] as const)('answers 503 SERVICE_DRAINING with Retry-After when %s, WITHOUT querying the DB', async (_phase, enter) => {
      const query = jest.fn(() => Promise.resolve({ rows: [{ ok: 1 }] }));
      const drain = new DrainState();
      enter(drain);
      const controller = makeController(query, false, drain);
      const { res, headers } = response();

      let thrown: unknown;
      try {
        await controller.readyz(res);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(AppException);
      const ex = thrown as AppException;
      expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(ex.errorCode).toBe(ErrorCode.SERVICE_DRAINING);
      expect(headers['retry-after']).toBe('4');
      expect(query).not.toHaveBeenCalled();
    });

    it('a drain beats a healthy DB, and the liveness probe is unaffected by it', async () => {
      const query = jest.fn(() => Promise.resolve({ rows: [{ ok: 1 }] }));
      const drain = new DrainState();
      drain.begin();
      const controller = makeController(query, false, drain);

      await expect(controller.readyz(response().res)).rejects.toBeInstanceOf(AppException);
      // /healthz is liveness, not readiness: still answers (the drain gate, not
      // this controller, 503s it once the close begins).
      await expect(controller.healthz()).resolves.toMatchObject({ ok: true });
    });
  });
});
