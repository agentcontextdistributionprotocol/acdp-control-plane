import { HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as client from 'prom-client';
import type { Response } from 'express';
import { HealthController } from './health.controller';
import { ReadinessService, ReadinessVerdict } from './readiness.service';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../db/database.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { DrainState } from '../shutdown-drain';
import { InstrumentationService } from '../telemetry/instrumentation.service';

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
    drain: DrainState = new DrainState(),
    evaluate: jest.Mock = jest.fn().mockResolvedValue(READY),
    snapshot: jest.Mock = jest.fn().mockReturnValue(undefined),
    isStale: jest.Mock = jest.fn().mockReturnValue(false),
  ) {
    const readiness = { evaluate, snapshot, isStale } as unknown as ReadinessService;
    return new HealthController(config, drain, readiness);
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

  describe('healthz (issue #210 Phase 2: pure liveness)', () => {
    const BODY = { service: 'acdp-control-plane', version: '0.1.0' };

    it('takes no DatabaseService at all: the controller cannot reach the pool', () => {
      // The constructor's parameter list is the proof: HealthController is
      // built from config, drain state and readiness only.
      expect(HealthController.length).toBe(3);
    });

    it('before any probe: 200 { ok: true } synchronously, Cache-Control: no-store, and starts ONE background refresh', () => {
      const evaluate = jest.fn().mockResolvedValue(READY);
      const controller = makeController(new DrainState(), evaluate);
      const { res, headers } = response();

      const out = controller.healthz(res);

      // Not a promise: liveness never awaits anything.
      expect(out).toEqual({ ok: true, ...BODY });
      expect(headers).toEqual({ 'cache-control': 'no-store' });
      expect(evaluate).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['ready', READY, true],
      ['not ready', DOWN, false],
    ] as const)('mirrors the last verdict (%s) without refreshing a fresh snapshot', (_n, verdict, ok) => {
      const evaluate = jest.fn().mockResolvedValue(READY);
      const isStale = jest.fn().mockReturnValue(false);
      const controller = makeController(
        new DrainState(),
        evaluate,
        jest.fn().mockReturnValue(verdict),
        isStale,
      );

      expect(controller.healthz(response().res)).toEqual({ ok, ...BODY });
      expect(isStale).toHaveBeenCalledWith(verdict);
      expect(evaluate).not.toHaveBeenCalled();
    });

    it('a STALE snapshot: answers from it at once and refreshes in the background', () => {
      // A refresh that never settles: the answer must not wait for it.
      const evaluate = jest.fn(() => new Promise<ReadinessVerdict>(() => undefined));
      const controller = makeController(
        new DrainState(),
        evaluate,
        jest.fn().mockReturnValue(DOWN),
        jest.fn().mockReturnValue(true),
      );

      expect(controller.healthz(response().res)).toEqual({ ok: false, ...BODY });
      expect(evaluate).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['draining', (d: DrainState) => d.begin()],
      ['closing', (d: DrainState) => d.beginClosing()],
    ] as const)('while %s: still 200 from the snapshot, but starts NO background refresh', (_p, enter) => {
      const drain = new DrainState();
      enter(drain);
      for (const snapshot of [undefined, DOWN]) {
        const evaluate = jest.fn().mockResolvedValue(READY);
        const controller = makeController(
          drain,
          evaluate,
          jest.fn().mockReturnValue(snapshot),
          jest.fn().mockReturnValue(true),
        );
        expect(controller.healthz(response().res)).toEqual({ ok: snapshot?.ready ?? true, ...BODY });
        expect(evaluate).not.toHaveBeenCalled();
      }
    });

    it('with a REAL ReadinessService and a mocked pool: draining + stale snapshot issues no pool.query', async () => {
      jest.useFakeTimers({ now: 1_000_000 });
      client.register.clear();
      try {
        const query = jest.fn().mockResolvedValue({ rows: [] });
        const database = { pool: { query, on: jest.fn() } } as unknown as DatabaseService;
        const readiness = new ReadinessService(
          database,
          { readinessCacheMs: 1000, readinessDbTimeoutMs: 1000 } as AppConfigService,
          new InstrumentationService(),
        );
        const drain = new DrainState();
        const controller = new HealthController(config, drain, readiness);

        controller.healthz(response().res); // no snapshot: one background probe
        await jest.advanceTimersByTimeAsync(0);
        expect(query).toHaveBeenCalledTimes(1);
        expect(readiness.snapshot()?.ready).toBe(true);

        jest.setSystemTime(1_000_000 + 60_000); // well past the stale window
        drain.begin();
        expect(controller.healthz(response().res)).toEqual({ ok: true, ...BODY });
        drain.beginClosing();
        expect(controller.healthz(response().res)).toEqual({ ok: true, ...BODY });
        await jest.advanceTimersByTimeAsync(0);
        expect(query).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
        client.register.clear();
      }
    });
  });

  describe('readyz', () => {
    it('answers 200 { ok, database, checks } with Cache-Control: no-store when ready (via ReadinessService only)', async () => {
      const evaluate = jest.fn().mockResolvedValue(READY);
      const controller = makeController(new DrainState(), evaluate);
      const { res, headers } = response();

      await expect(controller.readyz(res)).resolves.toEqual({
        ok: true,
        database: 'ok',
        checks: READY.checks,
      });
      // The probe goes through ReadinessService only (bounded, single-flight).
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(headers).toEqual({ 'cache-control': 'no-store' });
    });

    it('throws 503 DEPENDENCY_UNAVAILABLE with the legacy keys + checks in metadata when not ready', async () => {
      const controller = makeController(new DrainState(), jest.fn().mockResolvedValue(DOWN));
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

    it('@SkipThrottle() is CLASS-level now that every route is bounded (#210 Phase 2)', () => {
      const reflector = new Reflector();
      // @nestjs/throttler's skip key for the default (unnamed) throttler.
      expect(reflector.get('THROTTLER:SKIPdefault', HealthController)).toBe(true);
    });

    // #192 Phase 3: readiness = !draining && deps ok, DRAIN-FIRST. The DB is
    // never queried once draining — the pool is about to end.
    it.each([
      ['draining', (d: DrainState) => d.begin()],
      ['closing', (d: DrainState) => d.beginClosing()],
    ] as const)('answers 503 SERVICE_DRAINING with Retry-After when %s, WITHOUT querying the DB', async (_phase, enter) => {
      const evaluate = jest.fn().mockResolvedValue(READY);
      const drain = new DrainState();
      enter(drain);
      const controller = makeController(drain, evaluate);
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
      // Drain-first (#210 composition rule 1): no cache lookup, no probe.
      expect(evaluate).not.toHaveBeenCalled();
    });

    it('a drain beats a healthy DB, and the liveness probe is unaffected by it', async () => {
      const drain = new DrainState();
      drain.begin();
      const controller = makeController(drain);

      await expect(controller.readyz(response().res)).rejects.toBeInstanceOf(AppException);
      // /healthz is liveness, not readiness: still answers (the drain gate, not
      // this controller, 503s it once the close begins).
      expect(controller.healthz(response().res)).toMatchObject({ ok: true });
    });
  });
});
