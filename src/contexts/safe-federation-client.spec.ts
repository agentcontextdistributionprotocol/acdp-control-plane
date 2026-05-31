import { HttpStatus, Logger } from '@nestjs/common';
import { SsrfPolicy } from '../auth/did-web/ssrf-guard';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { FederationFetchError, SafeFederationClient } from './safe-federation-client';

function resp(init: {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}): Response {
  const headers = new Headers(init.headers ?? {});
  return {
    status: init.status ?? 200,
    headers,
    arrayBuffer: async () =>
      new TextEncoder().encode(init.body ?? '').buffer as ArrayBuffer,
  } as unknown as Response;
}

describe('SafeFederationClient', () => {
  // localhost-based tests need loopback allowed (no real network — fetch is mocked).
  const loopbackPolicy = new SsrfPolicy({ allowHttp: true, allowLoopback: true });

  it('returns status + content-type + body on a 200', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      resp({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }),
    );
    const client = new SafeFederationClient(loopbackPolicy, fetchMock as unknown as typeof fetch);

    const r = await client.get('https://localhost/contexts/x');
    expect(r).toEqual({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  it('rejects non-https schemes before any fetch (SSRF)', async () => {
    const fetchMock = jest.fn();
    const client = new SafeFederationClient(new SsrfPolicy(), fetchMock as unknown as typeof fetch);

    await expect(client.get('http://evil.example/x')).rejects.toMatchObject({ code: 'SSRF' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects IP-literal authorities (IMDS) before any fetch (SSRF)', async () => {
    const fetchMock = jest.fn();
    const client = new SafeFederationClient(new SsrfPolicy(), fetchMock as unknown as typeof fetch);

    await expect(
      client.get('https://169.254.169.254/latest/meta-data/'),
    ).rejects.toMatchObject({ code: 'SSRF' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a cross-authority redirect', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(resp({ status: 302, headers: { location: 'https://localhost:9999/x' } }));
    const client = new SafeFederationClient(loopbackPolicy, fetchMock as unknown as typeof fetch);

    await expect(client.get('https://localhost/contexts/x')).rejects.toMatchObject({
      code: 'REDIRECT',
    });
  });

  it('follows a same-authority redirect', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(resp({ status: 302, headers: { location: 'https://localhost/final' } }))
      .mockResolvedValueOnce(resp({ status: 200, body: 'done' }));
    const client = new SafeFederationClient(loopbackPolicy, fetchMock as unknown as typeof fetch);

    const r = await client.get('https://localhost/contexts/x');
    expect(r.status).toBe(200);
    expect(r.body).toBe('done');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an oversized body by Content-Length', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      resp({ status: 200, headers: { 'content-length': String(2 * 1024 * 1024) }, body: 'x' }),
    );
    const client = new SafeFederationClient(loopbackPolicy, fetchMock as unknown as typeof fetch);

    await expect(client.get('https://localhost/contexts/x')).rejects.toMatchObject({
      code: 'BODY_TOO_LARGE',
    });
  });

  it('wraps a 502 response (does not throw) — upstream status is relayed', async () => {
    const fetchMock = jest.fn().mockResolvedValue(resp({ status: 404, body: 'nope' }));
    const client = new SafeFederationClient(loopbackPolicy, fetchMock as unknown as typeof fetch);

    const r = await client.get('https://localhost/contexts/x');
    expect(r.status).toBe(404);
    expect(r.body).toBe('nope');
  });

  it('maps a 429 to an AppException (503) and logs the Retry-After hint', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetchMock = jest.fn().mockResolvedValue(
      resp({ status: 429, headers: { 'retry-after': '30' } }),
    );
    const client = new SafeFederationClient(loopbackPolicy, fetchMock as unknown as typeof fetch);

    let caught: unknown;
    try {
      await client.get('https://localhost/contexts/x');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(AppException);
    const ex = caught as AppException;
    expect(ex.errorCode).toBe(ErrorCode.FEDERATION_UPSTREAM_RATE_LIMITED);
    expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(ex.getStatus()).toBe(503);
    // Retry-After hint is surfaced in both the log and the error message.
    expect(ex.message).toContain('30');
    expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('30'))).toBe(true);
    expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('429'))).toBe(true);

    warnSpy.mockRestore();
  });

  it('surfaces FederationFetchError for transport failures', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new SafeFederationClient(loopbackPolicy, fetchMock as unknown as typeof fetch);

    await expect(client.get('https://localhost/contexts/x')).rejects.toBeInstanceOf(
      FederationFetchError,
    );
  });
});
