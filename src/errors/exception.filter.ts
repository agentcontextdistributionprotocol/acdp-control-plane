import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { AppException } from './app-exception';
import { ErrorCode } from './error-codes';

/**
 * RFC-ACDP-0007 §4: ACDP responses (success and error) carry the
 * `application/acdp+json` media type. The sibling registry sets this on
 * every response including framework-generated errors; the control plane
 * mirrors that on its error bodies for cross-process parity.
 */
const ACDP_CONTENT_TYPE = 'application/acdp+json';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof AppException) {
      this.send(response, exception.getStatus(), exception.getResponse());
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      this.send(
        response,
        status,
        typeof body === 'string'
          ? { statusCode: status, errorCode: ErrorCode.INTERNAL_ERROR, message: body }
          : body,
      );
      return;
    }

    const message = exception instanceof Error ? exception.message : 'Internal server error';
    this.logger.error(
      `unhandled exception: ${message}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    this.send(response, HttpStatus.INTERNAL_SERVER_ERROR, {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    });
  }

  /**
   * Emit the error body with the `application/acdp+json` media type and,
   * for object bodies, an additive ACDP error envelope
   * (`{ error: { code, message, details } }`) alongside the existing
   * `{ statusCode, errorCode, message }` fields. Additive so existing CP
   * clients keep working while ACDP consumers can read `error.code`.
   */
  private send(response: Response, status: number, body: unknown): void {
    response.status(status).type(ACDP_CONTENT_TYPE).json(withAcdpEnvelope(body));
  }
}

function withAcdpEnvelope(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  if ('error' in b) return b; // already in ACDP envelope shape — leave it.
  return {
    ...b,
    error: {
      code: b.errorCode ?? ErrorCode.INTERNAL_ERROR,
      message: b.message ?? 'error',
      ...(b.metadata !== undefined ? { details: b.metadata } : {}),
    },
  };
}
