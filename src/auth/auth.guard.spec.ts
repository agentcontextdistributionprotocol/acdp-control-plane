import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import { AppConfigService } from '../config/app-config.service';
import { AuthGuard } from './auth.guard';
import { CrossIssuerValidator } from './cross-issuer-validator.service';
import { IS_PUBLIC_KEY } from './public.decorator';

describe('AuthGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let config: { authApiKeys: string[]; authAdminApiKeys: string[] };
  let request: Record<string, any>;
  let guard: AuthGuard;

  function ctx(req: Record<string, any>): ExecutionContext {
    const handler = function fakeHandler() {};
    class FakeClass {}
    return {
      getHandler: jest.fn().mockReturnValue(handler),
      getClass: jest.fn().mockReturnValue(FakeClass),
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: jest.fn(),
        getNext: jest.fn(),
      }),
      getArgs: jest.fn(),
      getArgByIndex: jest.fn(),
      switchToRpc: jest.fn(),
      switchToWs: jest.fn(),
      getType: jest.fn(),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    config = {
      authApiKeys: ['valid-token-12345678', 'admin-token-aaaaaaaa'],
      authAdminApiKeys: ['admin-token-aaaaaaaa'],
    };
    request = { headers: {} };
    // Default: no JWT validator wired (TOKEN_ISSUANCE_ENABLED=false path).
    guard = new AuthGuard(
      reflector as unknown as Reflector,
      config as AppConfigService,
    );
  });

  it('allows @Public() endpoints to pass through', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [
      expect.anything(),
      expect.anything(),
    ]);
  });

  it('rejects requests without Authorization header', async () => {
    await expect(guard.canActivate(ctx(request))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects requests with empty Bearer token', async () => {
    request.headers.authorization = 'Bearer ';
    await expect(guard.canActivate(ctx(request))).rejects.toThrow(UnauthorizedException);
  });

  it('accepts requests with a valid Bearer token', async () => {
    request.headers.authorization = 'Bearer valid-token-12345678';
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
    expect(request.actorId).toBe('valid-to...');
    expect(request.actorType).toBe('api-key');
    expect(request.actorIsAdmin).toBe(false);
    // API keys carry no JWT issuer and are never federated (#225).
    expect(request.actorFederated).toBe(false);
    expect(request.actorIssuer).toBeUndefined();
  });

  it('flags admin-listed api keys as actorIsAdmin', async () => {
    request.headers.authorization = 'Bearer admin-token-aaaaaaaa';
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
    expect(request.actorIsAdmin).toBe(true);
  });

  it('accepts requests with a raw API key (no Bearer prefix)', async () => {
    request.headers.authorization = 'valid-token-12345678';
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
  });

  it('rejects requests with an unknown token', async () => {
    request.headers.authorization = 'Bearer wrong-token';
    await expect(guard.canActivate(ctx(request))).rejects.toThrow(UnauthorizedException);
  });

  it('allows any token when AUTH_API_KEYS is empty (dev mode)', async () => {
    config.authApiKeys = [];
    request.headers.authorization = 'Bearer anything-goes';
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
  });

  it('rejects a JWT-shaped token when TOKEN_ISSUANCE_ENABLED=false (no validator)', async () => {
    // The token has 3 segments → looks like a JWT → we MUST NOT fall
    // through to api-key matching. Without a validator the guard rejects.
    request.headers.authorization = 'Bearer aaa.bbb.ccc';
    await expect(guard.canActivate(ctx(request))).rejects.toThrow(/JWT presented/);
  });

  it('rejects when X-Tenant-Id disagrees with the tenant a bound API key maps to', async () => {
    (config as Record<string, unknown>).tenantApiKeysRaw = 'tenant-a:valid-token-12345678';
    request.headers.authorization = 'Bearer valid-token-12345678';
    request.headers['x-tenant-id'] = 'tenant-b';
    await expect(guard.canActivate(ctx(request))).rejects.toMatchObject({ errorCode: ErrorCode.TENANT_MISMATCH, status: 403 });
  });

  it('strict mode (AUTH_REQUIRE_TENANT): a bare (unbound) API key is denied', async () => {
    (config as Record<string, unknown>).requireTenant = true;
    request.headers.authorization = 'Bearer valid-token-12345678';
    await expect(guard.canActivate(ctx(request))).rejects.toMatchObject({ errorCode: ErrorCode.TENANT_REQUIRED, status: 403 });
  });

  it('strict mode: a tenant-bound API key is allowed', async () => {
    (config as Record<string, unknown>).requireTenant = true;
    (config as Record<string, unknown>).tenantApiKeysRaw = 'tenant-a:valid-token-12345678';
    request.headers.authorization = 'Bearer valid-token-12345678';
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
    expect(request.tenantId).toBe('tenant-a');
  });

  it('strict mode: denies when AUTH_API_KEYS is empty', async () => {
    (config as Record<string, unknown>).requireTenant = true;
    config.authApiKeys = [];
    request.headers.authorization = 'Bearer anything';
    await expect(guard.canActivate(ctx(request))).rejects.toMatchObject({ errorCode: ErrorCode.TENANT_REQUIRED, status: 403 });
  });
});

describe('AuthGuard — JWT path (TOKEN_ISSUANCE_ENABLED=true)', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let config: { authApiKeys: string[]; authAdminApiKeys: string[] };
  let request: Record<string, any>;
  // `verify` is the per-test claims mock; `verifyWithProvenance` (what the guard
  // calls) wraps it and reports `trustedEntry` as the vouching trust entry.
  let validator: { verify: jest.Mock; verifyWithProvenance: jest.Mock };
  let trustedEntry: unknown;
  let guard: AuthGuard;

  function ctx(req: Record<string, any>): ExecutionContext {
    return {
      getHandler: jest.fn().mockReturnValue(function fakeHandler() {}),
      getClass: jest.fn().mockReturnValue(class FakeClass {}),
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: jest.fn(),
        getNext: jest.fn(),
      }),
      getArgs: jest.fn(),
      getArgByIndex: jest.fn(),
      switchToRpc: jest.fn(),
      switchToWs: jest.fn(),
      getType: jest.fn(),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    config = { authApiKeys: [], authAdminApiKeys: [] };
    request = { headers: {} };
    trustedEntry = null;
    validator = {
      verify: jest.fn(),
      verifyWithProvenance: jest.fn(async (t: string) => ({
        claims: await validator.verify(t),
        trusted: trustedEntry,
      })),
    };
    guard = new AuthGuard(
      reflector as unknown as Reflector,
      config as AppConfigService,
      validator as unknown as CrossIssuerValidator,
    );
  });

  function fakeJwt(claims: Record<string, unknown>): string {
    return jwt.sign(claims, 'irrelevant-secret-' + 'x'.repeat(32), {
      algorithm: 'HS256',
    });
  }

  it('accepts a valid JWT and populates actorDid + actorType=jwt', async () => {
    const tok = fakeJwt({ iss: 'cp.local', sub: 'did:web:alice', jti: 'j1', exp: 9_999_999_999 });
    (validator.verify as jest.Mock).mockResolvedValue({
      iss: 'cp.local',
      sub: 'did:web:alice',
      jti: 'j1',
      exp: 9_999_999_999,
      iat: 0,
      acdp: { registry: 'cp.local', key_id: 'did:web:alice#k1' },
    });
    request.headers.authorization = `Bearer ${tok}`;
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
    expect(request.actorType).toBe('jwt');
    expect(request.actorDid).toBe('did:web:alice');
    expect(request.actorId).toBe('did:web:alice');
    expect(request.actorIsAdmin).toBe(false);
  });

  it('exposes the union of scope/scopes/scp as actorScopes, and [] when absent (#225)', async () => {
    const claims = {
      iss: 'cp.local', sub: 'did:web:alice', jti: 'j1', exp: 9_999_999_999, iat: 0,
      acdp: { registry: 'cp.local', key_id: 'k' },
    };
    (validator.verify as jest.Mock).mockResolvedValueOnce({ ...claims, scp: 'a b', scope: 'b c' });
    request.headers.authorization = `Bearer ${fakeJwt({ sub: 'x' })}`;
    await guard.canActivate(ctx(request));
    expect(request.actorScopes).toEqual(['b', 'c', 'a']);

    const req2: Record<string, any> = { headers: { authorization: request.headers.authorization } };
    (validator.verify as jest.Mock).mockResolvedValueOnce(claims);
    await guard.canActivate(ctx(req2));
    expect(req2.actorScopes).toEqual([]);

    const req3: Record<string, any> = { headers: { authorization: request.headers.authorization } };
    (validator.verify as jest.Mock).mockResolvedValueOnce({ ...claims, scp: 'only-scp' });
    await guard.canActivate(ctx(req3));
    expect(req3.actorScopes).toEqual(['only-scp']);
  });

  it('tags provenance: local token → issuer=iss, federated=false; trusted → federated=true (#225)', async () => {
    const base = { sub: 'did:web:alice', jti: 'j', exp: 9_999_999_999, iat: 0, acdp: { registry: 'x', key_id: 'k' } };
    const tok = `Bearer ${fakeJwt({ sub: 'x' })}`;

    const local: Record<string, any> = { headers: { authorization: tok } };
    validator.verify.mockResolvedValueOnce({ ...base, iss: 'cp.local' });
    await guard.canActivate(ctx(local));
    expect(local.actorIssuer).toBe('cp.local');
    expect(local.actorFederated).toBe(false);

    trustedEntry = { iss: 'registry-a.peer', alg: 'HS256', audience: 'registry-a.peer' };
    const fed: Record<string, any> = { headers: { authorization: tok } };
    validator.verify.mockResolvedValueOnce({ ...base, iss: 'registry-a.peer' });
    await guard.canActivate(ctx(fed));
    expect(fed.actorIssuer).toBe('registry-a.peer');
    expect(fed.actorFederated).toBe(true);
  });

  describe('per-issuer read_only (#225)', () => {
    const claims = {
      iss: 'registry-a.peer',
      sub: 'did:web:alice',
      jti: 'j',
      exp: 9_999_999_999,
      iat: 0,
      acdp: { registry: 'x', key_id: 'k' },
    };
    const run = async (
      method: string,
      over: { readOnly?: boolean; path?: string; extra?: Record<string, any>; claims?: object } = {},
    ) => {
      trustedEntry = { iss: claims.iss, alg: 'HS256', audience: claims.iss, readOnly: over.readOnly ?? true };
      validator.verify.mockResolvedValue({ ...claims, ...over.claims });
      const req: Record<string, any> = {
        headers: { authorization: `Bearer ${fakeJwt({ sub: 'x' })}`, ...(over.extra ?? {}) },
        method,
        path: over.path ?? '/webhooks',
      };
      return guard.canActivate(ctx(req));
    };
    const expectReadOnlyDenied = async (p: Promise<boolean>) => {
      const e: any = await p.then(
        () => null,
        (err) => err,
      );
      expect(e).toBeInstanceOf(AppException);
      expect(e.getStatus()).toBe(403);
      expect(e.errorCode).toBe(ErrorCode.ISSUER_READ_ONLY);
    };

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('denies %s with ISSUER_READ_ONLY (403)', async (m) => {
      await expectReadOnlyDenied(run(m));
    });

    it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('allows safe method %s', async (m) => {
      await expect(run(m)).resolves.toBe(true);
    });

    it('default-off: readOnly=false issuer may POST', async () => {
      await expect(run('POST', { readOnly: false })).resolves.toBe(true);
    });

    it('exempts POST /auth/introspect (read-shaped) but not POST /auth/token/revoke', async () => {
      await expect(run('POST', { path: '/auth/introspect' })).resolves.toBe(true);
      await expect(run('POST', { path: '/Auth/Introspect/' })).resolves.toBe(true);
      await expectReadOnlyDenied(run('POST', { path: '/auth/token/revoke' }));
      await expectReadOnlyDenied(run('POST', { path: '/auth/introspect/x' }));
    });

    it('never affects a local token (trusted === null)', async () => {
      trustedEntry = null;
      validator.verify.mockResolvedValue(claims);
      const req = { headers: { authorization: `Bearer ${fakeJwt({ sub: 'x' })}` }, method: 'POST', path: '/webhooks' };
      await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
    });

    it('tenant checks keep precedence: bad X-Tenant-Id on POST → TENANT_MISMATCH, not ISSUER_READ_ONLY', async () => {
      const e: any = await run('POST', {
        claims: { tenant: 'tenant-a' },
        extra: { 'x-tenant-id': 'tenant-b' },
      }).then(
        () => null,
        (err) => err,
      );
      expect(e).toBeInstanceOf(AppException);
      expect(e.errorCode).toBe(ErrorCode.TENANT_MISMATCH);
    });
  });

  it('rejects an invalid JWT (no fallthrough to api-key matching)', async () => {
    config.authApiKeys = ['aaa.bbb.ccc']; // intentionally JWT-shaped api key
    (validator.verify as jest.Mock).mockRejectedValue(
      new Error('verification failed'),
    );
    request.headers.authorization = 'Bearer aaa.bbb.ccc';
    await expect(guard.canActivate(ctx(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('TENANT_HEADER_TRUST=any_peer: honors X-Tenant-Id for a JWT with no tenant claim', async () => {
    (config as Record<string, unknown>).tenantHeaderTrust = 'any_peer';
    const tok = fakeJwt({ iss: 'cp.local', sub: 'did:web:bob', jti: 'j2', exp: 9_999_999_999 });
    (validator.verify as jest.Mock).mockResolvedValue({
      iss: 'cp.local',
      sub: 'did:web:bob',
      jti: 'j2',
      exp: 9_999_999_999,
      iat: 0,
      acdp: { registry: 'cp.local', key_id: 'did:web:bob#k1' },
    });
    request.headers.authorization = `Bearer ${tok}`;
    request.headers['x-tenant-id'] = 'tenant-blue';
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
    expect(request.tenantId).toBe('tenant-blue');
  });

  it('falls back to default tenant when X-Tenant-Id is absent', async () => {
    const tok = fakeJwt({ iss: 'cp.local', sub: 'did:web:eve', jti: 'j3', exp: 9_999_999_999 });
    (validator.verify as jest.Mock).mockResolvedValue({
      iss: 'cp.local',
      sub: 'did:web:eve',
      jti: 'j3',
      exp: 9_999_999_999,
      iat: 0,
      acdp: { registry: 'cp.local', key_id: 'did:web:eve#k1' },
    });
    request.headers.authorization = `Bearer ${tok}`;
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
    expect(request.tenantId).toBe('default');
  });

  it('JWT tenant claim is authoritative over X-Tenant-Id when they agree', async () => {
    const tok = fakeJwt({ sub: 'did:web:carol' });
    (validator.verify as jest.Mock).mockResolvedValue({
      iss: 'cp.local',
      sub: 'did:web:carol',
      jti: 'j4',
      exp: 9_999_999_999,
      iat: 0,
      acdp: { registry: 'cp.local', key_id: 'did:web:carol#k1' },
      tenant: 'tenant-a',
    });
    request.headers.authorization = `Bearer ${tok}`;
    request.headers['x-tenant-id'] = 'tenant-a';
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
    expect(request.tenantId).toBe('tenant-a');
  });

  it('JWT tenant claim wins when X-Tenant-Id is absent', async () => {
    const tok = fakeJwt({ sub: 'did:web:carol' });
    (validator.verify as jest.Mock).mockResolvedValue({
      iss: 'cp.local',
      sub: 'did:web:carol',
      jti: 'j5',
      exp: 9_999_999_999,
      iat: 0,
      acdp: { registry: 'cp.local', key_id: 'did:web:carol#k1' },
      tenant: 'tenant-a',
    });
    request.headers.authorization = `Bearer ${tok}`;
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
    expect(request.tenantId).toBe('tenant-a');
  });

  it('rejects when X-Tenant-Id disagrees with the JWT tenant claim', async () => {
    // The header is asserting a tenant the issuer didn't bind.
    // Refuse — it's either a misconfigured client or a hostile request.
    const tok = fakeJwt({ sub: 'did:web:dan' });
    (validator.verify as jest.Mock).mockResolvedValue({
      iss: 'cp.local',
      sub: 'did:web:dan',
      jti: 'j6',
      exp: 9_999_999_999,
      iat: 0,
      acdp: { registry: 'cp.local', key_id: 'did:web:dan#k1' },
      tenant: 'tenant-a',
    });
    request.headers.authorization = `Bearer ${tok}`;
    request.headers['x-tenant-id'] = 'tenant-b';
    await expect(guard.canActivate(ctx(request))).rejects.toMatchObject({ errorCode: ErrorCode.TENANT_MISMATCH, status: 403 });
  });

  it('strict mode (AUTH_REQUIRE_TENANT): JWT without a tenant claim is denied', async () => {
    (config as Record<string, unknown>).requireTenant = true;
    const tok = fakeJwt({ sub: 'did:web:nobody' });
    (validator.verify as jest.Mock).mockResolvedValue({
      iss: 'cp.local',
      sub: 'did:web:nobody',
      jti: 'js1',
      exp: 9_999_999_999,
      iat: 0,
      acdp: { registry: 'cp.local', key_id: 'did:web:nobody#k1' },
      // no tenant claim, and a spoofable header must NOT satisfy strict mode
    });
    request.headers.authorization = `Bearer ${tok}`;
    request.headers['x-tenant-id'] = 'tenant-spoof';
    await expect(guard.canActivate(ctx(request))).rejects.toMatchObject({ errorCode: ErrorCode.TENANT_REQUIRED, status: 403 });
  });

  it('strict mode: JWT carrying a tenant claim is allowed', async () => {
    (config as Record<string, unknown>).requireTenant = true;
    const tok = fakeJwt({ sub: 'did:web:bound' });
    (validator.verify as jest.Mock).mockResolvedValue({
      iss: 'cp.local',
      sub: 'did:web:bound',
      jti: 'js2',
      exp: 9_999_999_999,
      iat: 0,
      acdp: { registry: 'cp.local', key_id: 'did:web:bound#k1' },
      tenant: 'tenant-a',
    });
    request.headers.authorization = `Bearer ${tok}`;
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
    expect(request.tenantId).toBe('tenant-a');
  });

  it('absent tenant claim + any_peer → header wins (opt-in legacy behaviour)', async () => {
    (config as Record<string, unknown>).tenantHeaderTrust = 'any_peer';
    const tok = fakeJwt({ sub: 'did:web:eve' });
    (validator.verify as jest.Mock).mockResolvedValue({
      iss: 'cp.local',
      sub: 'did:web:eve',
      jti: 'j7',
      exp: 9_999_999_999,
      iat: 0,
      acdp: { registry: 'cp.local', key_id: 'did:web:eve#k1' },
      // no `tenant` field
    });
    request.headers.authorization = `Bearer ${tok}`;
    request.headers['x-tenant-id'] = 'tenant-legacy';
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
    expect(request.tenantId).toBe('tenant-legacy');
  });

  describe('TENANT_HEADER_TRUST (default none) — header on a claim-less JWT', () => {
    const claimsOf = (extra: Record<string, unknown> = {}) => ({
      iss: 'cp.local',
      sub: 'did:web:eve',
      jti: 'jh',
      exp: 9_999_999_999,
      iat: 0,
      acdp: { registry: 'cp.local', key_id: 'did:web:eve#k1' },
      ...extra,
    });
    const run = async (opts: { claim?: string; header?: string; federated?: boolean }) => {
      trustedEntry = opts.federated ? { iss: 'cp.local', alg: 'HS256', audience: 'a', readOnly: false } : null;
      validator.verify.mockResolvedValue(claimsOf(opts.claim ? { tenant: opts.claim } : {}));
      const req: Record<string, any> = {
        headers: {
          authorization: `Bearer ${fakeJwt({ sub: 'x' })}`,
          ...(opts.header ? { 'x-tenant-id': opts.header } : {}),
        },
      };
      const out = await guard.canActivate(ctx(req)).then(
        () => ({ ok: true as const, tenantId: req.tenantId }),
        (e) => ({ ok: false as const, code: e.errorCode, status: e.getStatus?.() }),
      );
      return out;
    };

    it.each([false, true])('none: claim-less token + header → 403 TENANT_HEADER_UNTRUSTED (federated=%s)', async (fed) => {
      expect(await run({ header: 'tenant-x', federated: fed })).toEqual({
        ok: false,
        code: ErrorCode.TENANT_HEADER_UNTRUSTED,
        status: 403,
      });
    });

    it('none: no header → default tenant (unchanged)', async () => {
      expect(await run({})).toEqual({ ok: true, tenantId: 'default' });
    });

    it('none: claim, header absent or equal → claim wins (corroboration is fine)', async () => {
      expect(await run({ claim: 'tenant-a' })).toEqual({ ok: true, tenantId: 'tenant-a' });
      expect(await run({ claim: 'tenant-a', header: 'tenant-a' })).toEqual({ ok: true, tenantId: 'tenant-a' });
    });

    it('none: claim + different header → TENANT_MISMATCH (precedence over untrusted)', async () => {
      expect(await run({ claim: 'tenant-a', header: 'tenant-b' })).toMatchObject({
        ok: false,
        code: ErrorCode.TENANT_MISMATCH,
      });
    });

    it('none: header asserting reserved `default` → TENANT_RESERVED (precedence)', async () => {
      expect(await run({ header: 'default' })).toMatchObject({ ok: false, code: ErrorCode.TENANT_RESERVED });
    });

    it('strict mode keeps TENANT_REQUIRED for a claim-less token (unchanged, before the trust check)', async () => {
      (config as Record<string, unknown>).requireTenant = true;
      expect(await run({ header: 'tenant-x' })).toMatchObject({ ok: false, code: ErrorCode.TENANT_REQUIRED });
    });

    it('any_peer + strict mode: claim-less token → TENANT_REQUIRED (strict still wins)', async () => {
      (config as Record<string, unknown>).tenantHeaderTrust = 'any_peer';
      (config as Record<string, unknown>).requireTenant = true;
      expect(await run({ header: 'tenant-x' })).toMatchObject({ ok: false, code: ErrorCode.TENANT_REQUIRED });
    });

    it('any_peer: claim-less token + header → header wins', async () => {
      (config as Record<string, unknown>).tenantHeaderTrust = 'any_peer';
      expect(await run({ header: 'tenant-x', federated: true })).toEqual({ ok: true, tenantId: 'tenant-x' });
    });
  });
});
