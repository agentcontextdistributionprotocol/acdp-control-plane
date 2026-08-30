import { HttpStatus, Logger } from '@nestjs/common';
import { SsrfPolicy } from '../auth/did-web/ssrf-guard';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { FederationFetchError, SafeFederationClient } from './safe-federation-client';

/**
 * Builds a genuine streaming `ReadableStream<Uint8Array>` so tests exercise
 * the real `getReader()` code path in `readCapped` rather than a mocked
 * `arrayBuffer()`. `pull` hands out one chunk per read; `hang` simulates a
 * body-read that never resolves (no enqueue, no close) for timeout tests;
 * `onCancel` observes `reader.cancel()` via the underlying source's cancel
 * algorithm — the one call the spec actually reaches for.
 */
function makeStream(
  chunks: Uint8Array[],
  opts: { hang?: boolean; onCancel?: () => void } = {},
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.hang) {
        // Never enqueue or close — the reader's `read()` promise stays
        // pending forever, simulating a stalled body read.
        return;
      }
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
    cancel() {
      opts.onCancel?.();
    },
  });
}

function resp(init: {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Deliver the body across multiple chunks (no auto Content-Length). */
  chunks?: string[];
  /** A body stream whose read never resolves — timeout simulation. */
  hang?: boolean;
  /** `resp.body === null` — e.g. a 204. */
  noBody?: boolean;
  /** Observes `reader.cancel()` on this response's body stream. */
  onCancel?: () => void;
}): Response {
  const headers = new Headers(init.headers ?? {});
  const encoder = new TextEncoder();

  let body: ReadableStream<Uint8Array> | null;
  if (init.noBody) {
    body = null;
  } else if (init.hang) {
    body = makeStream([], { hang: true, onCancel: init.onCancel });
  } else if (init.chunks) {
    body = makeStream(
      init.chunks.map((c) => encoder.encode(c)),
      { onCancel: init.onCancel },
    );
  } else {
    body = makeStream([encoder.encode(init.body ?? '')], { onCancel: init.onCancel });
  }

  return {
    status: init.status ?? 200,
    headers,
    body,
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

  it('rejects a redirect with no Location header', async () => {
    const fetchMock = jest.fn().mockResolvedValue(resp({ status: 302 }));
    const client = new SafeFederationClient(loopbackPolicy, fetchMock as unknown as typeof fetch);

    await expect(client.get('https://localhost/contexts/x')).rejects.toMatchObject({
      code: 'REDIRECT',
    });
  });

  it('rejects a redirect whose Location is an unparseable URL', async () => {
    // A scheme-relative target with a space cannot resolve against the base URL.
    const fetchMock = jest
      .fn()
      .mockResolvedValue(resp({ status: 302, headers: { location: 'http://[bad' } }));
    const client = new SafeFederationClient(loopbackPolicy, fetchMock as unknown as typeof fetch);

    await expect(client.get('https://localhost/contexts/x')).rejects.toMatchObject({
      code: 'REDIRECT',
    });
  });

  it('rejects after exceeding the redirect limit (same-authority loop)', async () => {
    // Always redirect back to a same-authority target → never terminates,
    // so the hop counter trips the MAX_REDIRECTS guard.
    const fetchMock = jest
      .fn()
      .mockResolvedValue(resp({ status: 302, headers: { location: 'https://localhost/again' } }));
    const client = new SafeFederationClient(loopbackPolicy, fetchMock as unknown as typeof fetch);

    await expect(client.get('https://localhost/contexts/x')).rejects.toMatchObject({
      code: 'REDIRECT',
    });
    // initial + MAX_REDIRECTS (3) follows = 4 fetches before giving up.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('rejects an oversized body by actual bytes when Content-Length is absent', async () => {
    const big = 'x'.repeat(1024 * 1024 + 1);
    const fetchMock = jest.fn().mockResolvedValue(resp({ status: 200, body: big }));
    const client = new SafeFederationClient(loopbackPolicy, fetchMock as unknown as typeof fetch);

    await expect(client.get('https://localhost/contexts/x')).rejects.toMatchObject({
      code: 'BODY_TOO_LARGE',
    });
  });

  it('rejects at DNS time when no resolved address passes the policy (SSRF)', async () => {
    const fetchMock = jest.fn();
    // A policy that lets the scheme/IP-literal gate pass but fails DNS resolution.
    const dnsFailPolicy = {
      checkUrl: () => undefined,
      checkResolvedHost: async () => {
        throw new Error('resolved to a blocked address');
      },
    } as unknown as SsrfPolicy;
    const client = new SafeFederationClient(dnsFailPolicy, fetchMock as unknown as typeof fetch);

    await expect(client.get('https://internal.example/x')).rejects.toMatchObject({
      code: 'SSRF',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized chunked body with no Content-Length, cancelling the reader', async () => {
    const onCancel = jest.fn();
    // 20 x 100 KiB chunks (2 MiB total), no Content-Length header — the
    // byte-counting loop (not the advisory header check) must catch this.
    // Deliberately many small chunks, not two big ones: a `ReadableStream`
    // reader reads one chunk ahead of the consumer (default highWaterMark
    // of 1), so the underlying source can race to natural EOF before our
    // cap-check fires; plenty of headroom keeps the source open so
    // `reader.cancel()` genuinely stops an in-flight drain rather than
    // racing a source that already closed itself.
    const chunk = 'x'.repeat(100 * 1024);
    const chunks = Array.from({ length: 20 }, () => chunk);
    const fetchMock = jest.fn().mockResolvedValue(resp({ status: 200, chunks, onCancel }));
    const client = new SafeFederationClient(loopbackPolicy, fetchMock as unknown as typeof fetch);

    await expect(client.get('https://localhost/contexts/x')).rejects.toMatchObject({
      code: 'BODY_TOO_LARGE',
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('aborts a body read that hangs past the timeout, surfacing a FETCH error', async () => {
    jest.useFakeTimers();
    try {
      // A stub SSRF policy that resolves instantly — keeps this test on
      // fake timers only, no real DNS I/O to race against the clock.
      const instantPolicy = {
        checkUrl: () => undefined,
        checkResolvedHost: async () => undefined,
      } as unknown as SsrfPolicy;
      const fetchMock = jest.fn().mockResolvedValue(resp({ status: 200, hang: true }));
      const client = new SafeFederationClient(
        instantPolicy,
        fetchMock as unknown as typeof fetch,
      );

      const pending = client.get('https://localhost/contexts/x');
      // Attach a handler immediately so the eventual rejection (raised
      // once the fake clock advances below) is never briefly unhandled —
      // Jest flags a same-tick unhandled rejection against the currently
      // running test even when it's awaited a moment later.
      pending.catch(() => undefined);
      // Advances fake time while flushing the microtask queue between
      // ticks, so the pending SSRF/fetch awaits progress far enough for
      // the per-hop setTimeout to actually be scheduled before it fires.
      await jest.advanceTimersByTimeAsync(10_000);

      await expect(pending).rejects.toMatchObject({ code: 'FETCH' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns an empty body when resp.body is null (e.g. a 204)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(resp({ status: 204, noBody: true }));
    const client = new SafeFederationClient(loopbackPolicy, fetchMock as unknown as typeof fetch);

    const r = await client.get('https://localhost/contexts/x');
    expect(r).toEqual({ status: 204, contentType: null, body: '' });
  });

  it('cancels a redirect response body before following the next hop', async () => {
    const onCancel = jest.fn();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        resp({
          status: 302,
          headers: { location: 'https://localhost/final' },
          body: 'ignored',
          onCancel,
        }),
      )
      .mockResolvedValueOnce(resp({ status: 200, body: 'done' }));
    const client = new SafeFederationClient(loopbackPolicy, fetchMock as unknown as typeof fetch);

    const r = await client.get('https://localhost/contexts/x');
    expect(r.body).toBe('done');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
