import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import { TenantedRequest } from '../tenant/request-tenant';
import { ContextsController } from './contexts.controller';
import { FederationFetchError } from './safe-federation-client';

interface FakeRes {
  _status?: number;
  _headers: Record<string, string>;
  _body?: unknown;
  status(code: number): FakeRes;
  set(key: string, value: string): FakeRes;
  send(body: unknown): FakeRes;
}

/** A minimal express Response double that records what was sent. */
function fakeRes(): FakeRes & Response {
  const res: FakeRes = {
    _headers: {},
    status(code: number) {
      this._status = code;
      return this;
    },
    set(key: string, value: string) {
      this._headers[key] = value;
      return this;
    },
    send(body: unknown) {
      this._body = body;
      return this;
    },
  };
  return res as unknown as FakeRes & Response;
}

const req = { tenantId: 'default' } as unknown as TenantedRequest;

describe('ContextsController', () => {
  let registryRepo: { findByAuthority: jest.Mock };
  let federationClient: { get: jest.Mock };
  let controller: ContextsController;

  beforeEach(() => {
    registryRepo = { findByAuthority: jest.fn() };
    federationClient = { get: jest.fn() };
    controller = new ContextsController(
      registryRepo as never,
      federationClient as never,
    );
  });

  describe('ctx_id validation (parseAcdpCtxId)', () => {
    const bad = [
      ['missing acdp:// scheme', 'https://acme.example/ctx-1'],
      ['no authority before the slash', 'acdp:///ctx-1'],
      ['authority but no id', 'acdp://acme.example/'],
      ['no slash at all', 'acdp://acme.example'],
      ['underscore in authority (not host-shaped)', 'acdp://ac_me/ctx-1'],
      ['space in authority', 'acdp://acme example/ctx-1'],
    ] as const;

    it.each(bad)('rejects %s with 400', async (_label, ctxId) => {
      await expect(
        controller.getContext(ctxId, req, fakeRes()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(registryRepo.findByAuthority).not.toHaveBeenCalled();
    });

    it('accepts a host:port authority and forwards to the registry base_url', async () => {
      registryRepo.findByAuthority.mockResolvedValue({
        baseUrl: 'https://acme.example:8443/',
      });
      federationClient.get.mockResolvedValue({
        status: 200,
        contentType: 'application/json',
        body: '{"ok":true}',
      });

      await controller.getContext('acdp://acme.example:8443/ctx-1', req, fakeRes());

      expect(registryRepo.findByAuthority).toHaveBeenCalledWith(
        'acme.example:8443',
        'default',
      );
    });
  });

  it('joins string[] ctxId segments into a single ctx_id', async () => {
    registryRepo.findByAuthority.mockResolvedValue({
      baseUrl: 'https://acme.example',
    });
    federationClient.get.mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    });

    // NestJS delivers the catch-all param as decoded path segments.
    await controller.getContext(['acdp:', '', 'acme.example', 'ctx-1'], req, fakeRes());

    // 'acdp:' + '' + 'acme.example' + 'ctx-1' joined by '/' → acdp://acme.example/ctx-1
    expect(registryRepo.findByAuthority).toHaveBeenCalledWith('acme.example', 'default');
    const upstream = federationClient.get.mock.calls[0][0] as string;
    expect(upstream).toBe(
      'https://acme.example/contexts/' +
        encodeURIComponent('acdp://acme.example/ctx-1'),
    );
  });

  it('404s when the registry authority is unknown', async () => {
    registryRepo.findByAuthority.mockResolvedValue(undefined);

    await expect(
      controller.getContext('acdp://acme.example/ctx-1', req, fakeRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(federationClient.get).not.toHaveBeenCalled();
  });

  it('404s when the registry row has no base_url', async () => {
    registryRepo.findByAuthority.mockResolvedValue({ baseUrl: null });

    await expect(
      controller.getContext('acdp://acme.example/ctx-1', req, fakeRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('relays upstream status, content-type, and body verbatim on success', async () => {
    registryRepo.findByAuthority.mockResolvedValue({
      baseUrl: 'https://acme.example',
    });
    federationClient.get.mockResolvedValue({
      status: 403,
      contentType: 'application/problem+json',
      body: '{"error":"forbidden"}',
    });
    const res = fakeRes();

    await controller.getContext('acdp://acme.example/ctx-1', req, res);

    expect(res._status).toBe(403);
    expect(res._headers['Content-Type']).toBe('application/problem+json');
    expect(res._body).toBe('{"error":"forbidden"}');
  });

  it('defaults the relayed Content-Type to application/json when upstream omits it', async () => {
    registryRepo.findByAuthority.mockResolvedValue({
      baseUrl: 'https://acme.example',
    });
    federationClient.get.mockResolvedValue({
      status: 200,
      contentType: null,
      body: '{}',
    });
    const res = fakeRes();

    await controller.getContext('acdp://acme.example/ctx-1', req, res);

    expect(res._headers['Content-Type']).toBe('application/json');
  });

  it('maps a FederationFetchError (SSRF/transport) to 502 BadGateway', async () => {
    registryRepo.findByAuthority.mockResolvedValue({
      baseUrl: 'https://acme.example',
    });
    federationClient.get.mockRejectedValue(
      new FederationFetchError('SSRF', 'blocked address'),
    );

    await expect(
      controller.getContext('acdp://acme.example/ctx-1', req, fakeRes()),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('rethrows non-federation errors unchanged (e.g. upstream 429 → AppException)', async () => {
    registryRepo.findByAuthority.mockResolvedValue({
      baseUrl: 'https://acme.example',
    });
    const boom = new Error('rate limited');
    federationClient.get.mockRejectedValue(boom);

    await expect(
      controller.getContext('acdp://acme.example/ctx-1', req, fakeRes()),
    ).rejects.toBe(boom);
  });
});
