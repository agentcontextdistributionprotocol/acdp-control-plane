import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { RequestLoggerMiddleware } from './request-logger.middleware';

/**
 * Issue #210 D11: probes are unthrottled, so a SUCCESSFUL GET/HEAD /healthz or
 * /readyz request line logs at `debug`; a failing probe and every non-probe
 * request stay at `info` (`log`). Fields are structured either way.
 */
describe('RequestLoggerMiddleware — probe log level (issue #210, D11)', () => {
  let info: jest.SpyInstance;
  let debug: jest.SpyInstance;
  const instrumentation = {
    httpRequestDuration: { observe: jest.fn() },
    httpRequestsTotal: { inc: jest.fn() },
  } as unknown as InstrumentationService;

  beforeEach(() => {
    info = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  });

  afterEach(() => {
    info.mockRestore();
    debug.mockRestore();
  });

  function run(method: string, url: string, statusCode: number): void {
    const mw = new RequestLoggerMiddleware(instrumentation);
    const res = Object.assign(new EventEmitter(), { statusCode }) as unknown as Response;
    const req = { method, originalUrl: url, requestId: 'r-1' } as unknown as Request;
    mw.use(req, res, jest.fn() as NextFunction);
    (res as unknown as EventEmitter).emit('finish');
  }

  it.each([
    ['GET', '/readyz', 200],
    ['GET', '/healthz', 200],
    ['HEAD', '/readyz', 200],
    ['GET', '/readyz?x=1', 200],
  ])('%s %s %i logs at debug, not info', (method, url, status) => {
    run(method, url, status);
    expect(info).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ method, path: url, statusCode: status, requestId: 'r-1' }),
    );
  });

  it.each([
    ['GET', '/readyz', 503],
    ['GET', '/healthz', 503],
    ['GET', '/runs', 200],
    ['GET', '/ingest/health', 200],
    ['POST', '/readyz', 404],
    ['OPTIONS', '/readyz', 204],
    ['GET', '/readyz/extra', 404],
  ])('%s %s %i stays at info', (method, url, status) => {
    run(method, url, status);
    expect(debug).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.any(String), method, statusCode: status }),
    );
  });
});
