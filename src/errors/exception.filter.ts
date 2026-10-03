import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Response } from "express";
import { AppException } from "./app-exception";
import { ErrorCode } from "./error-codes";

/**
 * RFC-ACDP-0007 §4: ACDP responses (success and error) carry the
 * `application/acdp+json` media type. The sibling registry sets this on
 * every response including framework-generated errors; the control plane
 * mirrors that on its error bodies for cross-process parity.
 */
const ACDP_CONTENT_TYPE = "application/acdp+json";

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
        typeof body === "string"
          ? {
              statusCode: status,
              // Keyed on the real status (#182): @nestjs/throttler's
              // ThrottlerException is string-bodied, and a 429 must not claim
              // to be a (retryable) server fault.
              errorCode: defaultErrorCode(status),
              message: body,
            }
          : body,
      );
      return;
    }

    // body-parser (registered via `app.useBodyParser` → a plain express
    // middleware) rejects with `http-errors` objects — 413 entity.too.large,
    // 415 charset.unsupported, 400 request.aborted, … — which are neither
    // HttpExceptions nor the SyntaxError Nest maps to a 400. Before #182 they
    // fell through to the 500 branch below. http-errors sets `expose: true`
    // only for 4xx, so forwarding its message leaks no server-side detail;
    // anything without `expose === true` keeps the generic 500.
    const clientError = asExposedClientError(exception);
    if (clientError) {
      this.logger.warn({
        msg: "exposed client error (non-HttpException)",
        statusCode: clientError.status,
        type: clientError.type,
      });
      this.send(response, clientError.status, {
        statusCode: clientError.status,
        errorCode: defaultErrorCode(clientError.status),
        message: clientError.message,
      });
      return;
    }

    const message =
      exception instanceof Error ? exception.message : "Internal server error";
    this.logger.error(
      `unhandled exception: ${message}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    this.send(response, HttpStatus.INTERNAL_SERVER_ERROR, {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: ErrorCode.INTERNAL_ERROR,
      message: "Internal server error",
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
    response
      .status(status)
      .type(ACDP_CONTENT_TYPE)
      .json(withAcdpEnvelope(body, status));
  }
}

/**
 * Status-keyed fallback for a body that carries no `errorCode` (#179, #182).
 * Total over 4xx: an unlabelled client error must never claim to be a server
 * fault, because INTERNAL_ERROR is in RFC-ACDP-0007 §5's retryable set.
 * Deliberately an explicit table, NOT `HttpStatus[status]` — that would
 * silently mint a new public code (e.g. `I_AM_A_TEAPOT`) for any status
 * anyone ever throws; every ErrorCode is a reviewed, one-way public name.
 */
export function defaultErrorCode(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ErrorCode.INVALID_PAYLOAD;
    case HttpStatus.UNAUTHORIZED:
      return ErrorCode.UNAUTHORIZED;
    case HttpStatus.FORBIDDEN:
      return ErrorCode.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ErrorCode.NOT_FOUND;
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return ErrorCode.PAYLOAD_TOO_LARGE;
    case HttpStatus.TOO_MANY_REQUESTS:
      return ErrorCode.RATE_LIMITED;
    default:
      return status >= 400 && status < 500
        ? ErrorCode.REQUEST_REJECTED
        : ErrorCode.INTERNAL_ERROR;
  }
}

/** An `http-errors`-shaped 4xx that its producer marked safe to expose. */
function asExposedClientError(
  exception: unknown,
): { status: number; message: string; type?: string } | undefined {
  if (!exception || typeof exception !== "object") return undefined;
  const e = exception as Record<string, unknown>;
  const status = e.status;
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 400 ||
    status >= 500 ||
    e.expose !== true
  ) {
    return undefined;
  }
  return {
    status,
    message: typeof e.message === "string" ? e.message : "client error",
    type: typeof e.type === "string" ? e.type : undefined,
  };
}

/**
 * `status` is the REAL HTTP status being sent, never the body's own
 * `statusCode` member (#182 defect 1): the quota/policy guards build object
 * bodies with no `statusCode`, and a body could even disagree with the
 * status it is thrown with — the wire status is what clients branch on.
 */
function withAcdpEnvelope(body: unknown, status: number): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  // Already in ACDP envelope shape — leave it. Only an OBJECT `error` member
  // counts: Nest's default body carries `error: "Not Found"` (a string), and
  // treating that as "already enveloped" skipped the envelope for every
  // string-constructed HttpException (#180).
  if (b.error !== null && typeof b.error === "object") return b;
  const code = b.errorCode ?? defaultErrorCode(status);
  return {
    ...b,
    errorCode: code,
    error: {
      code,
      message: b.message ?? "error",
      ...(b.metadata !== undefined ? { details: b.metadata } : {}),
    },
  };
}
