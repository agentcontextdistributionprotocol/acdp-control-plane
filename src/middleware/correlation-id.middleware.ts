import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { correlationStorage } from '../common/correlation';

export const CORRELATION_HEADER = 'x-request-id';

// The store and its reader live in `common/correlation` so `PinoLogger` can
// read them without pulling express + the DI decorators into `common/`.
// Re-exported here because this middleware is the only writer, and so
// existing imports of `getCorrelationId` from this path keep resolving.
export { correlationStorage, getCorrelationId } from '../common/correlation';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = (req.headers[CORRELATION_HEADER] as string) || randomUUID();
    res.setHeader(CORRELATION_HEADER, requestId);
    (req as unknown as Record<string, unknown>).requestId = requestId;
    correlationStorage.run(requestId, () => next());
  }
}
