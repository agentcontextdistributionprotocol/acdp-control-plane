import { HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { MetricsController } from './metrics.controller';

describe('MetricsController (admin-only /metrics)', () => {
  const makeRes = () => ({ set: jest.fn(), end: jest.fn() });
  let instrumentation: { getMetrics: jest.Mock; getContentType: jest.Mock };
  let controller: MetricsController;

  beforeEach(() => {
    instrumentation = {
      getMetrics: jest.fn().mockResolvedValue('# TYPE acdp_x counter\nacdp_x 1\n'),
      getContentType: jest.fn().mockReturnValue('text/plain; version=0.0.4'),
    };
    controller = new MetricsController(instrumentation as never);
  });

  it('is not @Public(): AuthGuard runs, so an unauthenticated scrape is a 401', () => {
    const reflector = new Reflector();
    expect(reflector.get(IS_PUBLIC_KEY, MetricsController)).toBeUndefined();
    expect(reflector.get(IS_PUBLIC_KEY, MetricsController.prototype.getMetrics)).toBeUndefined();
  });

  it('serves the exposition with its content type for an admin key', async () => {
    const res = makeRes();
    await controller.getMetrics({ actorIsAdmin: true } as never, res as never);
    expect(res.set).toHaveBeenCalledWith('Content-Type', 'text/plain; version=0.0.4');
    expect(res.end).toHaveBeenCalledWith('# TYPE acdp_x counter\nacdp_x 1\n');
  });

  it.each([
    ['a non-admin api key', { actorIsAdmin: false }],
    ['a JWT principal (never admin)', { actorIsAdmin: false, actorType: 'jwt' }],
    ['a request the guard never flagged', {}],
  ])('refuses %s with 403 ADMIN_REQUIRED without reading metrics', async (_label, req) => {
    const res = makeRes();
    const err = await controller
      .getMetrics(req as never, res as never)
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(AppException);
    expect((err as AppException).getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect((err as AppException).getResponse()).toEqual(
      expect.objectContaining({ errorCode: ErrorCode.ADMIN_REQUIRED }),
    );
    expect(instrumentation.getMetrics).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });
});
