import { HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { HealthController } from './health.controller';
import { ReadinessService, ReadinessVerdict } from './readiness.service';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../db/database.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { DrainState } from '../shutdown-drain';

describe('HealthController', () => {
  const config = { clientVersion: '0.1.0', shutdownDrainRetryAfterSeconds: 4 } as AppConfigService;

  const READY: ReadinessVerdict = {
    ready: true,
    checkedAt: 1,
    checks: { database: { status: 'up', latencyMs: 2 } },
  };
  const DOWN: ReadinessVerdict = {
    ready: false,
    checkedAt: 1,
    checks: { database: { status: 'down', reason: 'timeout', latencyMs: 300 } },
  };

  function makeController(
    query: () => Promise<unknown>,
    hasFatalError = false,
    drain: DrainState = new DrainState(),
    evaluate: jest.Mock = jest.fn().mockResolvedValue(READY),
  ) {
    const database = {
      pool: { query },
      hasFatalError,
    } as unknown as DatabaseService;
    const readiness = { evaluate } as unknown as ReadinessService;
    return new HealthController(database, config, drain, readiness);
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
    it('answers 200 { ok, database, checks } with Cache-Control: no-store when ready (no direct DB access)', async () => {
      const query = jest.fn(() => Promise.resolve({ rows: [{ ok: 1 }] }));
      const evaluate = jest.fn().mockResolvedValue(READY);
      const controller = makeController(query, false, new DrainState(), evaluate);
      const { res, headers } = response();

      await expect(controller.readyz(res)).resolves.toEqual({
        ok: true,
        database: 'ok',
        checks: READY.checks,
      });
      expect(evaluate).toHaveBeenCalledTimes(1);
      // The probe goes through ReadinessService only (bounded, single-flight).
      expect(query).not.toHaveBeenCalled();
      expect(headers).toEqual({ 'cache-control': 'no-store' });
    });

    it('throws 503 DEPENDENCY_UNAVAILABLE with the legacy keys + checks in metadata when not ready', async () => {
      const controller = makeController(
        jest.fn(),
        false,
        new DrainState(),
        jest.fn().mockResolvedValue(DOWN),
      );
      const { res, headers } = response();

      const thrown = await controller.readyz(res).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(thrown).toBeInstanceOf(AppException);
      const ex = thrown as AppException;
      expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(ex.errorCode).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
      expect(ex.metadata).toEqual({ ok: false, database: 'unhealthy', checks: DOWN.checks });
      expect(headers['cache-control']).toBe('no-store');
      // A DB outage has no known duration: no Retry-After on this arm.
      expect(headers['retry-after']).toBeUndefined();
    });

    it('@SkipThrottle() is on readyz() (cached) and NOT on healthz() (uncached DB query, until #210 Phase 2)', () => {
      const reflector = new Reflector();
      // @nestjs/throttler's skip key for the default (unnamed) throttler.
      expect(reflector.get('THROTTLER:SKIPdefault', HealthController.prototype.readyz)).toBe(true);
      expect(reflector.get('THROTTLER:SKIPdefault', HealthController.prototype.healthz)).toBeUndefined();
      expect(reflector.get('THROTTLER:SKIPdefault', HealthController)).toBeUndefined();
    });

    // #192 Phase 3: readiness = !draining && deps ok, DRAIN-FIRST. The DB is
    // never queried once draining — the pool is about to end.
    it.each([
      ['draining', (d: DrainState) => d.begin()],
      ['closing', (d: DrainState) => d.beginClosing()],
    ] as const)('answers 503 SERVICE_DRAINING with Retry-After when %s, WITHOUT querying the DB', async (_phase, enter) => {
      const query = jest.fn(() => Promise.resolve({ rows: [{ ok: 1 }] }));
      const evaluate = jest.fn().mockResolvedValue(READY);
      const drain = new DrainState();
      enter(drain);
      const controller = makeController(query, false, drain, evaluate);
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
      expect(headers['cache-control']).toBe('no-store');
      expect(query).not.toHaveBeenCalled();
      // Drain-first (#210 composition rule 1): no cache lookup, no probe.
      expect(evaluate).not.toHaveBeenCalled();
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
