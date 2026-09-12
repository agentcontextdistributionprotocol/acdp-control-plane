import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { InstrumentationService } from '../telemetry/instrumentation.service';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly instrumentation: InstrumentationService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    const { method, originalUrl } = req;
    const requestId = (req as unknown as Record<string, unknown>).requestId ?? '-';

    res.on('finish', () => {
      const duration = Date.now() - start;
      const { statusCode } = res;
      const path = this.normalizePath(originalUrl);
      this.instrumentation.httpRequestDuration.observe(
        { method, path, status_code: String(statusCode) },
        duration / 1000,
      );
      this.instrumentation.httpRequestsTotal.inc({
        method,
        path,
        status_code: String(statusCode),
      });
      // Structured fields, NOT a stringified message: pino puts an object
      // message's own keys at the top level of the line, so an aggregator can
      // filter on `statusCode` / `durationMs` / `requestId` without re-parsing
      // `msg` per line. `msg` stays a short human-readable summary.
      // `requestId` is read off the request rather than the ambient store
      // because this fires from a `res` 'finish' listener, which is not
      // guaranteed to run inside the AsyncLocalStorage context.
      this.logger.log({
        msg: `${method} ${originalUrl} ${statusCode} ${duration}ms`,
        method,
        path: originalUrl,
        statusCode,
        durationMs: duration,
        requestId,
      });
    });

    next();
  }

  private normalizePath(url: string): string {
    return url
      .split('?')[0]
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
  }
}
