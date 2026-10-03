import { HttpException, HttpStatus } from "@nestjs/common";
import { ErrorCode } from "./error-codes";

export class AppException extends HttpException {
  readonly errorCode: ErrorCode;
  readonly metadata?: Record<string, unknown>;

  constructor(
    errorCode: ErrorCode,
    message: string,
    httpStatus: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR,
    metadata?: Record<string, unknown>,
  ) {
    super(
      {
        statusCode: httpStatus,
        errorCode,
        message,
        ...(metadata ? { metadata } : {}),
      },
      httpStatus,
    );
    this.errorCode = errorCode;
    this.metadata = metadata;
  }
}
