import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
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
    await expect(guard.canActivate(ctx(request))).rejects.toThrow(ForbiddenException);
  });

  it('strict mode (AUTH_REQUIRE_TENANT): a bare (unbound) API key is denied', async () => {
    (config as Record<string, unknown>).requireTenant = true;
    request.headers.authorization = 'Bearer valid-token-12345678';
    await expect(guard.canActivate(ctx(request))).rejects.toThrow(ForbiddenException);
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
    await expect(guard.canActivate(ctx(request))).rejects.toThrow(ForbiddenException);
  });
});

describe('AuthGuard — JWT path (TOKEN_ISSUANCE_ENABLED=true)', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let config: { authApiKeys: string[]; authAdminApiKeys: string[] };
  let request: Record<string, any>;
  let validator: Pick<CrossIssuerValidator, 'verify'>;
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
    validator = { verify: jest.fn() };
    guard = new AuthGuard(
      reflector as unknown as Reflector,
      config as AppConfigService,
      validator as CrossIssuerValidator,
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

  it('honors X-Tenant-Id header for JWT-authenticated requests', async () => {
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
    await expect(guard.canActivate(ctx(request))).rejects.toThrow(ForbiddenException);
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
    await expect(guard.canActivate(ctx(request))).rejects.toThrow(ForbiddenException);
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

  it('absent tenant claim → header still wins (backward compat with V0 tokens)', async () => {
    // V0 tokens minted before the migration don't carry `tenant`.
    // The header path remains the fallback so existing deployments
    // don't break.
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
});
