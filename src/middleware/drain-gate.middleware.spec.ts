import { HttpStatus } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { DRAIN_ARRIVAL, DrainState, type DrainPhase } from '../shutdown-drain';
import { DrainGateMiddleware, isSseRequest, requestPath } from './drain-gate.middleware';

function setup(retryAfter = 7) {
  const drain = new DrainState();
  const rejections = { inc: jest.fn() };
  const gate = new DrainGateMiddleware(
    drain,
    { shutdownDrainRetryAfterSeconds: retryAfter } as never,
    { shutdownDrainRejectionsTotal: rejections } as never,
  );
  return { drain, gate, rejections };
}

function request(url: string, mark?: DrainPhase, method = 'GET'): Request {
  // `path` deliberately WRONG: inside Nest's forRoutes('*') mount, Express has
  // stripped req.url, so req.path reads '/'. The gate must not rely on it.
  const req: Record<string | symbol, unknown> = { method, originalUrl: url, path: '/' };
  if (mark !== undefined) req[DRAIN_ARRIVAL] = mark;
  return req as unknown as Request;
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

describe('DrainGateMiddleware (issue #192)', () => {
  it('passes an unmarked request (the marker never saw it)', () => {
    const { gate, drain } = setup();
    drain.beginClosing();
    const next = jest.fn() as NextFunction;
    const { res } = response();

    gate.use(request('/runs'), res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes a request marked as arriving before the drain', () => {
    const { gate } = setup();
    const next = jest.fn() as NextFunction;
    const { res } = response();

    gate.use(request('/runs', 'serving'), res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each(['serving', 'draining'] as const)(
    'decides from the ARRIVAL mark, not the live phase: headers in %s, body after the close began → next()',
    (mark) => {
      // The arrival-marker regression (plan review #1): a POST whose headers
      // arrived before the close reaches module middleware only after its body
      // has been parsed — by then the live phase is already `closing`.
      const { gate, drain, rejections } = setup();
      drain.beginClosing();
      const next = jest.fn() as NextFunction;
      const { res } = response();

      gate.use(request('/ingest/acdp', mark, 'POST'), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(rejections.inc).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['GET', '/readyz'],
    ['GET', '/healthz'],
    ['GET', '/runs'],
    ['POST', '/ingest/acdp'],
  ])('passes EVERYTHING that arrived during the drain delay (phase draining): %s %s', (method, path) => {
    // #192 Phase 3: the delay exists so a lagging load balancer's requests are
    // still served. Readiness during the delay is the health controller's 503,
    // not a gate rule — the gate has no readiness special case.
    const { gate, drain, rejections } = setup();
    drain.begin();
    const next = jest.fn() as NextFunction;
    const { res, headers } = response();

    gate.use(request(path, 'draining', method), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(headers).toEqual({});
    expect(rejections.inc).not.toHaveBeenCalled();
  });

  it('answers a request that arrived during closing with 503 SERVICE_DRAINING, Retry-After and Connection: close', () => {
    const { gate, drain, rejections } = setup(7);
    const next = jest.fn() as NextFunction;
    const { res, headers } = response();

    let thrown: unknown;
    try {
      gate.use(request('/readyz', 'closing'), res, next);
    } catch (err) {
      thrown = err;
    }

    expect(next).not.toHaveBeenCalled();
    expect(thrown).toBeInstanceOf(AppException);
    const ex = thrown as AppException;
    expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(ex.errorCode).toBe(ErrorCode.SERVICE_DRAINING);
    // Set on the response BEFORE the throw: the filter keeps them, never adds them.
    expect(headers['retry-after']).toBe('7');
    expect(headers.connection).toBe('close');
    expect(rejections.inc).toHaveBeenCalledTimes(1);
    expect(drain.stats().drainRejections).toBe(1);
  });

  it.each([
    '/events/stream',
    '/events/stream/',
    '/runs/r1/events/stream',
    '/Runs/R1/Events/Stream/',
    '/EVENTS/STREAM',
  ])('exempts GET %s (SSE: 200 + event: shutdown, never 503)', (path) => {
    const { gate, rejections } = setup();
    const next = jest.fn() as NextFunction;
    const { res, headers } = response();

    gate.use(request(path, 'closing'), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(headers).toEqual({});
    expect(rejections.inc).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/events/stream'],
    ['GET', '/events'],
    ['GET', '/events/stream/extra'],
    ['GET', '/runs/r1/events'],
    ['GET', '/runs/a/b/events/stream'],
    ['GET', '/runs//events/stream'],
    ['GET', '/xevents/stream'],
  ])('does not exempt %s %s', (method, path) => {
    const { gate } = setup();
    expect(() => gate.use(request(path, 'closing', method), response().res, jest.fn())).toThrow(
      AppException,
    );
  });

  it('isSseRequest is GET-only and anchored, and ignores the query string', () => {
    expect(isSseRequest({ method: 'GET', originalUrl: '/events/stream' })).toBe(true);
    expect(isSseRequest({ method: 'GET', originalUrl: '/events/stream?lastEventId=3' })).toBe(true);
    expect(isSseRequest({ method: 'GET', originalUrl: '/runs/r1/events/stream?x=/y' })).toBe(true);
    expect(isSseRequest({ method: 'HEAD', originalUrl: '/events/stream' })).toBe(false);
    expect(isSseRequest({ method: 'GET', originalUrl: '/api/events/stream' })).toBe(false);
  });

  it('requestPath reduces an absolute-form target to its path', () => {
    expect(requestPath({ originalUrl: 'http://cp.example:8080/events/stream?a=1' })).toBe(
      '/events/stream',
    );
    expect(requestPath({ originalUrl: 'http://cp.example' })).toBe('/');
    expect(requestPath({ originalUrl: '/runs?x=1' })).toBe('/runs');
  });
});
