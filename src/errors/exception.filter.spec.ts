import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { AppException } from './app-exception';
import { ErrorCode } from './error-codes';
import { GlobalExceptionFilter } from './exception.filter';

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let res: { status: jest.Mock; type: jest.Mock; json: jest.Mock };

  function host(): ArgumentsHost {
    return {
      switchToHttp: () => ({ getResponse: () => res, getRequest: jest.fn(), getNext: jest.fn() }),
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

  it('renders AppException with its structured body', () => {
    const ex = new AppException(ErrorCode.RUN_NOT_FOUND, 'no such run', HttpStatus.NOT_FOUND);
    filter.catch(ex, host());
    expect(res.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.NOT_FOUND,
        errorCode: ErrorCode.RUN_NOT_FOUND,
        message: 'no such run',
      }),
    );
  });

  it('emits application/acdp+json on every error response (RFC-ACDP-0007 §4)', () => {
    filter.catch(
      new AppException(ErrorCode.RUN_NOT_FOUND, 'no such run', HttpStatus.NOT_FOUND),
      host(),
    );
    expect(res.type).toHaveBeenCalledWith('application/acdp+json');
  });

  it('adds an additive ACDP error envelope alongside legacy fields', () => {
    filter.catch(
      new AppException(ErrorCode.RUN_NOT_FOUND, 'no such run', HttpStatus.NOT_FOUND),
      host(),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.NOT_FOUND,
        errorCode: ErrorCode.RUN_NOT_FOUND,
        message: 'no such run',
        error: { code: ErrorCode.RUN_NOT_FOUND, message: 'no such run' },
      }),
    );
  });

  it('surfaces AppException metadata as the ACDP envelope `details`', () => {
    const ex = new AppException(
      ErrorCode.RUN_NOT_FOUND,
      'no such run',
      HttpStatus.NOT_FOUND,
      { runId: 'abc' },
    );
    filter.catch(ex, host());
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: { code: ErrorCode.RUN_NOT_FOUND, message: 'no such run', details: { runId: 'abc' } },
      }),
    );
  });

  it('wraps string-bodied HttpException with INTERNAL_ERROR errorCode', () => {
    const ex = new HttpException('plain string body', HttpStatus.BAD_GATEWAY);
    filter.catch(ex, host());
    expect(res.status).toHaveBeenCalledWith(HttpStatus.BAD_GATEWAY);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.BAD_GATEWAY,
        errorCode: ErrorCode.INTERNAL_ERROR,
        message: 'plain string body',
        error: { code: ErrorCode.INTERNAL_ERROR, message: 'plain string body' },
      }),
    );
  });

  it('passes through HttpException with object body', () => {
    const ex = new HttpException(
      { statusCode: 418, errorCode: 'TEAPOT', message: 'short and stout' },
      418,
    );
    filter.catch(ex, host());
    expect(res.status).toHaveBeenCalledWith(418);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 418,
        errorCode: 'TEAPOT',
        message: 'short and stout',
        error: { code: 'TEAPOT', message: 'short and stout' },
      }),
    );
  });

  it('returns 500 INTERNAL_ERROR for unknown errors and does not leak the message', () => {
    filter.catch(new Error('boom — secret stack'), host());
    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        errorCode: ErrorCode.INTERNAL_ERROR,
        message: 'Internal server error',
      }),
    );
    const body = res.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toContain('secret stack');
  });
});
