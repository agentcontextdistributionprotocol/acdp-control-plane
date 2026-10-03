import { ArgumentsHost, HttpException, HttpStatus, NotFoundException } from "@nestjs/common";
import { AppException } from "./app-exception";
import { ErrorCode } from "./error-codes";
import { defaultErrorCode, GlobalExceptionFilter } from "./exception.filter";

describe("GlobalExceptionFilter", () => {
  let filter: GlobalExceptionFilter;
  let res: { status: jest.Mock; type: jest.Mock; json: jest.Mock };

  function host(): ArgumentsHost {
    return {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: jest.fn(),
        getNext: jest.fn(),
      }),
      switchToRpc: jest.fn(),
      switchToWs: jest.fn(),
      getArgs: jest.fn(),
      getArgByIndex: jest.fn(),
      getType: jest.fn(),
    } as unknown as ArgumentsHost;
  }

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    res = {
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  });

  it("renders AppException with its structured body", () => {
    const ex = new AppException(
      ErrorCode.RUN_NOT_FOUND,
      "no such run",
      HttpStatus.NOT_FOUND,
    );
    filter.catch(ex, host());
    expect(res.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.NOT_FOUND,
        errorCode: ErrorCode.RUN_NOT_FOUND,
        message: "no such run",
      }),
    );
  });

  it("emits application/acdp+json on every error response (RFC-ACDP-0007 §4)", () => {
    filter.catch(
      new AppException(
        ErrorCode.RUN_NOT_FOUND,
        "no such run",
        HttpStatus.NOT_FOUND,
      ),
      host(),
    );
    expect(res.type).toHaveBeenCalledWith("application/acdp+json");
  });

  it("adds an additive ACDP error envelope alongside legacy fields", () => {
    filter.catch(
      new AppException(
        ErrorCode.RUN_NOT_FOUND,
        "no such run",
        HttpStatus.NOT_FOUND,
      ),
      host(),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.NOT_FOUND,
        errorCode: ErrorCode.RUN_NOT_FOUND,
        message: "no such run",
        error: { code: ErrorCode.RUN_NOT_FOUND, message: "no such run" },
      }),
    );
  });

  it("surfaces AppException metadata as the ACDP envelope `details`", () => {
    const ex = new AppException(
      ErrorCode.RUN_NOT_FOUND,
      "no such run",
      HttpStatus.NOT_FOUND,
      { runId: "abc" },
    );
    filter.catch(ex, host());
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: {
          code: ErrorCode.RUN_NOT_FOUND,
          message: "no such run",
          details: { runId: "abc" },
        },
      }),
    );
  });

  it("wraps string-bodied HttpException with INTERNAL_ERROR errorCode", () => {
    const ex = new HttpException("plain string body", HttpStatus.BAD_GATEWAY);
    filter.catch(ex, host());
    expect(res.status).toHaveBeenCalledWith(HttpStatus.BAD_GATEWAY);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.BAD_GATEWAY,
        errorCode: ErrorCode.INTERNAL_ERROR,
        message: "plain string body",
        error: { code: ErrorCode.INTERNAL_ERROR, message: "plain string body" },
      }),
    );
  });

  it("passes through HttpException with object body", () => {
    const ex = new HttpException(
      { statusCode: 418, errorCode: "TEAPOT", message: "short and stout" },
      418,
    );
    filter.catch(ex, host());
    expect(res.status).toHaveBeenCalledWith(418);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 418,
        errorCode: "TEAPOT",
        message: "short and stout",
        error: { code: "TEAPOT", message: "short and stout" },
      }),
    );
  });

  it("returns 500 INTERNAL_ERROR for unknown errors and does not leak the message", () => {
    filter.catch(new Error("boom — secret stack"), host());
    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        errorCode: ErrorCode.INTERNAL_ERROR,
        message: "Internal server error",
      }),
    );
    const body = res.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toContain("secret stack");
  });

  it("envelopes Nest's string-constructed default body (error: 'Not Found') as NOT_FOUND — #180, #182", () => {
    filter.catch(
      new HttpException(
        { statusCode: 404, message: "x", error: "Not Found" },
        404,
      ),
      host(),
    );
    const body = res.json.mock.calls[0][0];
    expect(body.errorCode).toBe(ErrorCode.NOT_FOUND);
    expect(body.error).toEqual({
      code: ErrorCode.NOT_FOUND,
      message: "x",
    });
  });

  it("labels an unlabelled 400 (ValidationPipe) INVALID_PAYLOAD, not INTERNAL_ERROR — #179", () => {
    filter.catch(
      new HttpException(
        {
          statusCode: 400,
          message: ["name must be a string"],
          error: "Bad Request",
        },
        400,
      ),
      host(),
    );
    const body = res.json.mock.calls[0][0];
    expect(body.errorCode).toBe(ErrorCode.INVALID_PAYLOAD);
    expect(body.error).toEqual({
      code: ErrorCode.INVALID_PAYLOAD,
      message: ["name must be a string"],
    });
  });

  it("honours a NestJS 12 framework-native errorCode on a built-in exception — #155", () => {
    // Nest 12 added HttpExceptionOptions.errorCode: built-ins stamp it into
    // their string-constructed body. The filter must keep it rather than
    // overwrite it with the status-keyed fallback (NOT_FOUND).
    filter.catch(
      new NotFoundException("agent gone", { errorCode: ErrorCode.AGENT_NOT_FOUND }),
      host(),
    );
    expect(res.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    const body = res.json.mock.calls[0][0];
    expect(body.errorCode).toBe(ErrorCode.AGENT_NOT_FOUND);
    expect(body.error).toEqual({
      code: ErrorCode.AGENT_NOT_FOUND,
      message: "agent gone",
    });
  });

  it("keeps AppException's own errorCode despite the Nest 12 base-class field of the same name — #155", () => {
    const ex = new AppException(ErrorCode.RUN_NOT_FOUND, "no such run", HttpStatus.NOT_FOUND);
    expect(ex.errorCode).toBe(ErrorCode.RUN_NOT_FOUND);
    filter.catch(ex, host());
    expect(res.json.mock.calls[0][0].errorCode).toBe(ErrorCode.RUN_NOT_FOUND);
  });

  it("leaves an already-enveloped (object error) body untouched", () => {
    const b = { error: { code: "X", message: "m" } };
    filter.catch(new HttpException(b, 400), host());
    expect(res.json).toHaveBeenCalledWith(b);
  });

  describe("status-keyed fallback for unlabelled 4xx (#182)", () => {
    const expected: Record<number, ErrorCode> = {
      400: ErrorCode.INVALID_PAYLOAD,
      401: ErrorCode.UNAUTHORIZED,
      403: ErrorCode.FORBIDDEN,
      404: ErrorCode.NOT_FOUND,
      405: ErrorCode.REQUEST_REJECTED,
      409: ErrorCode.REQUEST_REJECTED,
      413: ErrorCode.PAYLOAD_TOO_LARGE,
      415: ErrorCode.REQUEST_REJECTED,
      418: ErrorCode.REQUEST_REJECTED,
      422: ErrorCode.REQUEST_REJECTED,
      429: ErrorCode.RATE_LIMITED,
    };

    it.each(Object.entries(expected))(
      "string-bodied HttpException(%s) → %s, never INTERNAL_ERROR",
      (status, code) => {
        filter.catch(new HttpException("x", Number(status)), host());
        expect(res.status).toHaveBeenCalledWith(Number(status));
        const body = res.json.mock.calls[0][0];
        expect(body.statusCode).toBe(Number(status));
        expect(body.errorCode).toBe(code);
        expect(body.errorCode).not.toBe(ErrorCode.INTERNAL_ERROR);
        expect(body.error.code).toBe(body.errorCode);
      },
    );

    it.each(Object.entries(expected))(
      "object-bodied HttpException(%s) with NO statusCode member → %s (defect 1: real status, not body)",
      (status, code) => {
        // The QuotaGuard/PolicyGuard body shape: hand-built, no statusCode.
        filter.catch(
          new HttpException({ message: "x", code: "legacy" }, Number(status)),
          host(),
        );
        const body = res.json.mock.calls[0][0];
        expect(body.errorCode).toBe(code);
        expect(body.error.code).toBe(body.errorCode);
        expect(body.code).toBe("legacy"); // legacy top-level fields survive
      },
    );

    it.each([500, 502, 503])(
      "string-bodied %s still → INTERNAL_ERROR",
      (status) => {
        filter.catch(new HttpException("x", status), host());
        expect(res.json.mock.calls[0][0].errorCode).toBe(
          ErrorCode.INTERNAL_ERROR,
        );
      },
    );

    it("keys on the real HTTP status when the body's statusCode disagrees", () => {
      filter.catch(
        new HttpException({ statusCode: 400, message: "x" }, 403),
        host(),
      );
      expect(res.status).toHaveBeenCalledWith(403);
      const body = res.json.mock.calls[0][0];
      expect(body.errorCode).toBe(ErrorCode.FORBIDDEN);
      expect(body.error.code).toBe(ErrorCode.FORBIDDEN);
    });

    it("an explicit errorCode on the body still wins over the fallback", () => {
      filter.catch(
        new HttpException({ errorCode: "SPECIFIC", message: "x" }, 403),
        host(),
      );
      const body = res.json.mock.calls[0][0];
      expect(body.errorCode).toBe("SPECIFIC");
      expect(body.error.code).toBe("SPECIFIC");
    });

    it("leaves an array body untouched", () => {
      filter.catch(new HttpException(["a"] as unknown as object, 403), host());
      expect(res.json).toHaveBeenCalledWith(["a"]);
    });

    it("defaultErrorCode is total: every 4xx maps away from INTERNAL_ERROR, 1xx-3xx/5xx do not", () => {
      for (let s = 400; s < 500; s++) {
        expect(defaultErrorCode(s)).not.toBe(ErrorCode.INTERNAL_ERROR);
      }
      expect(defaultErrorCode(399)).toBe(ErrorCode.INTERNAL_ERROR);
      expect(defaultErrorCode(500)).toBe(ErrorCode.INTERNAL_ERROR);
      expect(defaultErrorCode(599)).toBe(ErrorCode.INTERNAL_ERROR);
    });
  });

  describe("http-errors (body-parser) client errors (#182 defect 3)", () => {
    function httpError(
      status: number,
      message: string,
      extra: Record<string, unknown> = {},
    ): Error {
      // The shape body-parser rejects with: an Error carrying status /
      // statusCode / expose / type (the http-errors package).
      return Object.assign(new Error(message), {
        status,
        statusCode: status,
        expose: status < 500,
        ...extra,
      });
    }

    it("413 entity.too.large → 413 PAYLOAD_TOO_LARGE with its own message, logged at warn not error", () => {
      const warn = jest
        .spyOn((filter as unknown as { logger: { warn: jest.Mock } }).logger, "warn")
        .mockImplementation(() => undefined);
      const error = jest
        .spyOn((filter as unknown as { logger: { error: jest.Mock } }).logger, "error")
        .mockImplementation(() => undefined);
      filter.catch(
        httpError(413, "request entity too large", { type: "entity.too.large" }),
        host(),
      );
      expect(res.status).toHaveBeenCalledWith(413);
      expect(res.type).toHaveBeenCalledWith("application/acdp+json");
      const body = res.json.mock.calls[0][0];
      expect(body).toMatchObject({
        statusCode: 413,
        errorCode: ErrorCode.PAYLOAD_TOO_LARGE,
        message: "request entity too large",
        error: {
          code: ErrorCode.PAYLOAD_TOO_LARGE,
          message: "request entity too large",
        },
      });
      expect(error).not.toHaveBeenCalled();
      // Structured object, not a stringified message (CLAUDE.md logger rule).
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 413, type: "entity.too.large" }),
      );
    });

    it("415 charset.unsupported → 415 REQUEST_REJECTED", () => {
      jest
        .spyOn((filter as unknown as { logger: { warn: jest.Mock } }).logger, "warn")
        .mockImplementation(() => undefined);
      filter.catch(
        httpError(415, 'unsupported charset "X"', { type: "charset.unsupported" }),
        host(),
      );
      expect(res.status).toHaveBeenCalledWith(415);
      expect(res.json.mock.calls[0][0].errorCode).toBe(
        ErrorCode.REQUEST_REJECTED,
      );
    });

    it("a 4xx with expose:false stays on the generic 500 path and does not leak its message", () => {
      jest
        .spyOn((filter as unknown as { logger: { error: jest.Mock } }).logger, "error")
        .mockImplementation(() => undefined);
      filter.catch(httpError(413, "secret detail", { expose: false }), host());
      expect(res.status).toHaveBeenCalledWith(500);
      const body = res.json.mock.calls[0][0];
      expect(body.errorCode).toBe(ErrorCode.INTERNAL_ERROR);
      expect(JSON.stringify(body)).not.toContain("secret detail");
    });

    it("an exposed 5xx-shaped error stays a generic 500", () => {
      jest
        .spyOn((filter as unknown as { logger: { error: jest.Mock } }).logger, "error")
        .mockImplementation(() => undefined);
      filter.catch(httpError(503, "upstream detail", { expose: true }), host());
      expect(res.status).toHaveBeenCalledWith(500);
      expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain(
        "upstream detail",
      );
    });

    it("a non-integer or non-numeric status stays a generic 500", () => {
      jest
        .spyOn((filter as unknown as { logger: { error: jest.Mock } }).logger, "error")
        .mockImplementation(() => undefined);
      filter.catch(httpError(413.5, "x"), host());
      filter.catch(
        Object.assign(new Error("y"), { status: "413", expose: true }),
        host(),
      );
      expect(res.status).toHaveBeenNthCalledWith(1, 500);
      expect(res.status).toHaveBeenNthCalledWith(2, 500);
    });
  });
});
