import {
  BadGatewayException,
  BadRequestException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
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

// Canonical ctx_ids under `CtxId::parse`: `acdp://` + lowercase DNS authority
// + lowercase v4 UUID. Anything else is a 400 before any outbound request.
const CTX_ID = 'acdp://acme.example/abcdef01-2345-4678-9abc-def012345678';
const OTHER_CTX_ID = 'acdp://acme.example/11111111-1111-4111-8111-111111111111';

/**
 * A `FullContext` retrieval envelope whose `body` is shaped well enough for
 * the SDK's strict `Body` deserialization — the binding check parses it for
 * real, so a hand-waved `{}` would (correctly) be refused as unverifiable.
 */
function fullContext(ctxId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    body: {
      ctx_id: ctxId,
      lineage_id: 'lin:sha256:' + 'c'.repeat(64),
      origin_registry: 'acme.example',
      created_at: '2026-06-12T00:00:00.000Z',
      content_hash: 'sha256:' + 'a'.repeat(64),
      signature: {
        algorithm: 'ed25519',
        key_id: 'did:web:agent.example#key-1',
        value: 'AAA',
      },
      version: 1,
      agent_id: 'did:web:agent.example',
      contributors: [],
      title: 'proxied context',
      type: 'analysis',
      data_refs: [],
      derived_from: [],
      visibility: 'public',
      ...extra,
    },
    registry_state: { status: 'active' },
  });
}

/** Run `fn` and return the thrown value (fails the test if nothing throws). */
async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to throw, but it resolved');
}

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

  /** Registry enrolled + upstream returns `response`. */
  function upstreamReturns(response: {
    status: number;
    contentType: string | null;
    body: string;
  }): void {
    registryRepo.findByAuthority.mockResolvedValue({ baseUrl: 'https://acme.example' });
    federationClient.get.mockResolvedValue(response);
  }

  describe('ctx_id validation (parseAcdpCtxId)', () => {
    // The route's grammar is the SDK's `CtxId::parse`, not a loose host
    // shape: `acdp://<lowercase DNS authority>/<lowercase v4 UUID>`. Each of
    // these is rejected locally, so no outbound request is ever made.
    const bad = [
      ['missing acdp:// scheme', 'https://acme.example/ctx-1'],
      ['no authority before the slash', 'acdp:///ctx-1'],
      ['authority but no id', 'acdp://acme.example/'],
      ['no slash at all', 'acdp://acme.example'],
      ['underscore in authority (not host-shaped)', 'acdp://ac_me/ctx-1'],
      ['space in authority', 'acdp://acme example/ctx-1'],
      ['uppercase authority', 'acdp://ACME.example/abcdef01-2345-4678-9abc-def012345678'],
      [
        'port-bearing authority (no conformant registry can mint one)',
        'acdp://acme.example:8443/abcdef01-2345-4678-9abc-def012345678',
      ],
      ['opaque non-uuid id', 'acdp://acme.example/ctx-1'],
      ['non-v4 uuid (version nibble)', 'acdp://acme.example/00000000-0000-0000-0000-000000000001'],
      [
        'uuid with a bad variant nibble',
        'acdp://acme.example/abcdef01-2345-4678-1abc-def012345678',
      ],
      [
        'uppercase uuid',
        'acdp://acme.example/ABCDEF01-2345-4678-9ABC-DEF012345678',
      ],
    ] as const;

    it.each(bad)('rejects %s with 400', async (_label, ctxId) => {
      await expect(
        controller.getContext(ctxId, req, fakeRes()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(registryRepo.findByAuthority).not.toHaveBeenCalled();
      expect(federationClient.get).not.toHaveBeenCalled();
    });

    it('accepts a canonical ctx_id and forwards to the registry base_url', async () => {
      registryRepo.findByAuthority.mockResolvedValue({
        baseUrl: 'https://acme.example/',
      });
      federationClient.get.mockResolvedValue({
        status: 200,
        contentType: 'application/json',
        body: fullContext(CTX_ID),
      });

      await controller.getContext(CTX_ID, req, fakeRes());

      expect(registryRepo.findByAuthority).toHaveBeenCalledWith('acme.example', 'default');
      expect(federationClient.get).toHaveBeenCalledWith(
        `https://acme.example/contexts/${encodeURIComponent(CTX_ID)}`,
      );
    });
  });

  it('joins string[] ctxId segments into a single ctx_id', async () => {
    upstreamReturns({
      status: 200,
      contentType: 'application/json',
      body: fullContext(CTX_ID),
    });

    // NestJS delivers the catch-all param as decoded path segments.
    await controller.getContext(
      ['acdp:', '', 'acme.example', 'abcdef01-2345-4678-9abc-def012345678'],
      req,
      fakeRes(),
    );

    expect(registryRepo.findByAuthority).toHaveBeenCalledWith('acme.example', 'default');
    const upstream = federationClient.get.mock.calls[0][0] as string;
    expect(upstream).toBe(`https://acme.example/contexts/${encodeURIComponent(CTX_ID)}`);
  });

  it('404s when the registry authority is unknown', async () => {
    registryRepo.findByAuthority.mockResolvedValue(undefined);

    await expect(
      controller.getContext(CTX_ID, req, fakeRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(federationClient.get).not.toHaveBeenCalled();
  });

  it('404s when the registry row has no base_url', async () => {
    registryRepo.findByAuthority.mockResolvedValue({ baseUrl: null });

    await expect(
      controller.getContext(CTX_ID, req, fakeRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('relays upstream status, content-type, and body verbatim on a non-2xx', async () => {
    // A 4xx problem document is not a context: the binding check must not
    // touch it, so the public-only relay still surfaces the registry's own
    // 401/403/404 exactly as it sent them.
    upstreamReturns({
      status: 403,
      contentType: 'application/problem+json',
      body: '{"error":"forbidden"}',
    });
    const res = fakeRes();

    await controller.getContext(CTX_ID, req, res);

    expect(res._status).toBe(403);
    expect(res._headers['Content-Type']).toBe('application/problem+json');
    expect(res._body).toBe('{"error":"forbidden"}');
  });

  it('relays a non-2xx body that is not even JSON, unchecked', async () => {
    upstreamReturns({ status: 404, contentType: 'text/plain', body: 'no such context' });
    const res = fakeRes();

    await controller.getContext(CTX_ID, req, res);

    expect(res._status).toBe(404);
    expect(res._body).toBe('no such context');
  });

  it('defaults the relayed Content-Type to application/json when upstream omits it', async () => {
    upstreamReturns({ status: 200, contentType: null, body: fullContext(CTX_ID) });
    const res = fakeRes();

    await controller.getContext(CTX_ID, req, res);

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
      controller.getContext(CTX_ID, req, fakeRes()),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('rethrows non-federation errors unchanged (e.g. upstream 429 → AppException)', async () => {
    registryRepo.findByAuthority.mockResolvedValue({
      baseUrl: 'https://acme.example',
    });
    const boom = new Error('rate limited');
    federationClient.get.mockRejectedValue(boom);

    await expect(controller.getContext(CTX_ID, req, fakeRes())).rejects.toBe(boom);
  });

  // ── RFC-ACDP-0006 §4.1 step 7 — served-vs-requested ctx_id binding ────────
  describe('ctx_id binding (RFC-ACDP-0006 §4.1 step 7)', () => {
    it('relays a matching 2xx byte-identically, with upstream status + content-type', async () => {
      const body = fullContext(CTX_ID);
      upstreamReturns({ status: 200, contentType: 'application/acdp+json', body });
      const res = fakeRes();

      await controller.getContext(CTX_ID, req, res);

      expect(res._status).toBe(200);
      expect(res._headers['Content-Type']).toBe('application/acdp+json');
      expect(res._body).toBe(body); // the exact upstream string, unmodified
    });

    it('relays a body carrying members the control plane does not know about', async () => {
      // The check reads `body.ctx_id` and nothing else — it must never
      // become a schema gate on a forward-compatible `FullContext`.
      const body = JSON.stringify({
        ...JSON.parse(fullContext(CTX_ID)),
        log_inclusion: { some: 'future proof' },
        a_member_from_acdp_0_9: true,
      });
      upstreamReturns({ status: 200, contentType: 'application/json', body });
      const res = fakeRes();

      await controller.getContext(CTX_ID, req, res);

      expect(res._status).toBe(200);
      expect(res._body).toBe(body);
    });

    it('refuses a 2xx serving a DIFFERENT context: 502 CONTEXT_ID_MISMATCH, body withheld', async () => {
      const substituted = fullContext(OTHER_CTX_ID);
      upstreamReturns({ status: 200, contentType: 'application/json', body: substituted });
      const res = fakeRes();

      const err = await caught(() => controller.getContext(CTX_ID, req, res));

      expect(err).toBeInstanceOf(AppException);
      expect((err as AppException).errorCode).toBe(ErrorCode.CONTEXT_ID_MISMATCH);
      expect((err as AppException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      // The substituted body never reaches the caller, and the error message
      // does not smuggle it back either.
      expect(res._body).toBeUndefined();
      expect((err as AppException).message).not.toContain('proxied context');
      expect((err as AppException).message).not.toContain(OTHER_CTX_ID);
    });

    const unverifiable: Array<[string, { contentType: string | null; body: string }]> = [
      ['a 2xx that is not JSON at all', { contentType: 'text/html', body: '<html>hi</html>' }],
      ['a 2xx JSON scalar', { contentType: 'application/json', body: '"just a string"' }],
      ['a 2xx JSON array', { contentType: 'application/json', body: '[]' }],
      ['a 2xx with no `body` member', { contentType: 'application/json', body: '{"ok":true}' }],
      [
        'a 2xx whose `body` member is not an object',
        { contentType: 'application/json', body: '{"body":"nope"}' },
      ],
      [
        'a 2xx whose `body` the SDK\'s strict Body parse rejects',
        { contentType: 'application/json', body: '{"body":{"ctx_id":"' + CTX_ID + '"}}' },
      ],
      ['an empty 2xx body', { contentType: null, body: '' }],
    ];

    it.each(unverifiable)(
      'refuses %s: 502 CONTEXT_BINDING_UNVERIFIABLE, body withheld',
      async (_label, upstream) => {
        upstreamReturns({ status: 200, ...upstream });
        const res = fakeRes();

        const err = await caught(() => controller.getContext(CTX_ID, req, res));

        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).errorCode).toBe(ErrorCode.CONTEXT_BINDING_UNVERIFIABLE);
        expect((err as AppException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
        expect(res._body).toBeUndefined();
      },
    );

    it('never reports an unverifiable response as a substitution', async () => {
      // The two codes must not collapse: no mismatch was established here,
      // so claiming one would be a detection that never happened.
      upstreamReturns({ status: 200, contentType: 'text/html', body: '<html>hi</html>' });

      const err = await caught(() => controller.getContext(CTX_ID, req, fakeRes()));

      expect((err as AppException).errorCode).not.toBe(ErrorCode.CONTEXT_ID_MISMATCH);
    });

    it('does not echo the unparseable upstream body in the error message', async () => {
      // `JSON.parse` failure messages quote a fragment of their input, so the
      // body we are refusing to relay must not leak through the error instead.
      upstreamReturns({
        status: 200,
        contentType: 'text/html',
        body: '<html>leaked-secret-marker</html>',
      });

      const err = await caught(() => controller.getContext(CTX_ID, req, fakeRes()));

      expect((err as AppException).message).not.toContain('leaked-secret-marker');
    });

    it('fails closed on a ctx_id the route mirror admits but the SDK grammar refuses', async () => {
      // `isCanonicalCtxId` deliberately does NOT mirror `CtxId::parse`'s
      // 63-character DNS-label bound (transcribing RFC 1035 by hand is the
      // exact class of divergence the mirror exists to avoid), so a ctx_id
      // with a 64-character label passes the route and is refused by the SDK
      // at the binding check. That is the chosen outcome: 502 unverifiable —
      // never a relay, and never miscalled a substitution.
      const longLabel = 'a'.repeat(64);
      const overLongCtxId = `acdp://${longLabel}.example/abcdef01-2345-4678-9abc-def012345678`;
      registryRepo.findByAuthority.mockResolvedValue({
        baseUrl: `https://${longLabel}.example`,
      });
      federationClient.get.mockResolvedValue({
        status: 200,
        contentType: 'application/json',
        body: fullContext(overLongCtxId, { origin_registry: `${longLabel}.example` }),
      });
      const res = fakeRes();

      const err = await caught(() => controller.getContext(overLongCtxId, req, res));

      // It reached the registry (the mirror admitted it) …
      expect(federationClient.get).toHaveBeenCalled();
      // … and the SDK is the final authority, so we refuse to relay.
      expect((err as AppException).errorCode).toBe(ErrorCode.CONTEXT_BINDING_UNVERIFIABLE);
      expect((err as AppException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect(res._body).toBeUndefined();
    });
  });
});
