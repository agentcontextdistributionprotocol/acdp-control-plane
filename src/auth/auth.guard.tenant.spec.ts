/**
 * AuthGuard — tenant-extraction coverage layered on top of the auth
 * behavior tested in `auth.guard.spec.ts`.
 *
 * Kept in a separate file so the existing spec stays intact while #4
 * is in flight on a parallel branch; the two can land in either
 * order.
 */
 
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppConfigService } from '../config/app-config.service';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';
import { AuthGuard } from './auth.guard';

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

function newGuard(authApiKeys: string[], tenantApiKeysRaw = ''): { guard: AuthGuard; request: Record<string, any> } {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
  const config = {
    authApiKeys,
    authAdminApiKeys: [] as string[],
    tenantApiKeysRaw,
  } as unknown as AppConfigService;
  const guard = new AuthGuard(reflector as unknown as Reflector, config);
  const request = { headers: {} as Record<string, any> };
  return { guard, request };
}

describe('AuthGuard — tenant extraction', () => {
  it('binds the default tenant when no TENANT_API_KEYS mapping exists', () => {
    const { guard, request } = newGuard(['key-1']);
    request.headers.authorization = 'Bearer key-1';
    guard.canActivate(ctx(request));
    expect(request.tenantId).toBe(DEFAULT_TENANT_ID);
  });

  it('binds the request to the tenant the API key is mapped to', () => {
    const { guard, request } = newGuard(['key-a', 'key-b'], 'tenant-a:key-a,tenant-b:key-b');
    request.headers.authorization = 'Bearer key-a';
    guard.canActivate(ctx(request));
    expect(request.tenantId).toBe('tenant-a');

    const second = newGuard(['key-a', 'key-b'], 'tenant-a:key-a,tenant-b:key-b');
    second.request.headers.authorization = 'Bearer key-b';
    second.guard.canActivate(ctx(second.request));
    expect(second.request.tenantId).toBe('tenant-b');
  });

  it('falls back to the default tenant for keys not in TENANT_API_KEYS', () => {
    const { guard, request } = newGuard(['key-1', 'bare-key'], 'tenant-a:key-1');
    request.headers.authorization = 'Bearer bare-key';
    guard.canActivate(ctx(request));
    expect(request.tenantId).toBe(DEFAULT_TENANT_ID);
  });

  it('dev mode (empty AUTH_API_KEYS) still pins the default tenant', () => {
    const { guard, request } = newGuard([]);
    request.headers.authorization = 'Bearer anything-goes';
    guard.canActivate(ctx(request));
    expect(request.tenantId).toBe(DEFAULT_TENANT_ID);
  });

  it('builds the tenant lookup lazily (no parse until first request)', () => {
    // If the lookup were eager, a misconfigured TENANT_API_KEYS would
    // throw at construction. We construct cheaply and only throw on
    // first request — that way unit tests of unrelated config behavior
    // aren't blocked by a tenant-config typo.
    expect(() => newGuard(['key'], 'malformed-no-colon-and-still-fine')).not.toThrow();
  });

  describe('reserved tenant ("default") rejection', () => {
    it('rejects an explicit X-Tenant-Id: default assertion (bound key)', async () => {
      const { guard, request } = newGuard(['key-a'], 'tenant-a:key-a');
      request.headers.authorization = 'Bearer key-a';
      request.headers['x-tenant-id'] = DEFAULT_TENANT_ID;
      await expect(guard.canActivate(ctx(request))).rejects.toThrow(
        /reserved tenant sentinel/,
      );
    });

    it('rejects an explicit X-Tenant-Id: default assertion (bare key)', async () => {
      const { guard, request } = newGuard(['bare-key']);
      request.headers.authorization = 'Bearer bare-key';
      request.headers['x-tenant-id'] = DEFAULT_TENANT_ID;
      await expect(guard.canActivate(ctx(request))).rejects.toThrow(
        /reserved tenant sentinel/,
      );
    });

    it('still allows resolving to default via the ABSENCE of an assertion', async () => {
      const { guard, request } = newGuard(['bare-key']);
      request.headers.authorization = 'Bearer bare-key';
      await guard.canActivate(ctx(request));
      expect(request.tenantId).toBe(DEFAULT_TENANT_ID);
    });
  });
});
