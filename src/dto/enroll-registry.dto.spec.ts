import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { EnrollRegistryDto } from './enroll-registry.dto';

/**
 * tenant-enroll-quota-fix P2: re-enroll is PATCH-like, so the REAL pipe the
 * enroll handler uses must keep an explicit `null` distinct from an omitted
 * field (`@IsOptional()` lets `null` through without running the other
 * validators; `transform` must not coerce either into the other).
 */
describe('EnrollRegistryDto through the enroll ValidationPipe', () => {
  // Same options as RegistriesController.enroll's @Body pipe.
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const run = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: EnrollRegistryDto }) as Promise<
      EnrollRegistryDto & Record<string, unknown>
    >;

  it('keeps explicit nulls as null', async () => {
    const out = await run({
      authority: 'reg.example',
      baseUrl: null,
      registryDid: null,
      webhookSecret: null,
      enabled: null,
    });
    expect(out).toBeInstanceOf(EnrollRegistryDto);
    expect(out.baseUrl).toBeNull();
    expect(out.registryDid).toBeNull();
    expect(out.webhookSecret).toBeNull();
    expect(out.enabled).toBeNull();
  });

  it('leaves omitted fields undefined (never null)', async () => {
    // The instance may carry the key as an own property set to `undefined`
    // (ES2022 class-field semantics); the repository keys on the VALUE
    // (`!== undefined`), so only the value matters here.
    const out = await run({ authority: 'reg.example' });
    for (const k of ['baseUrl', 'registryDid', 'webhookSecret', 'enabled'] as const) {
      expect(out[k]).toBeUndefined();
      expect(out[k]).not.toBeNull();
    }
  });

  it('passes values through unchanged', async () => {
    const out = await run({
      authority: 'reg.example',
      baseUrl: 'https://reg.example',
      registryDid: 'did:web:reg.example',
      webhookSecret: 'a-sixteen-char-secret',
      enabled: false,
    });
    expect(out).toMatchObject({
      baseUrl: 'https://reg.example',
      registryDid: 'did:web:reg.example',
      webhookSecret: 'a-sixteen-char-secret',
      enabled: false,
    });
  });

  it('still rejects a short secret and a non-URL baseUrl (null is not a bypass for values)', async () => {
    await expect(run({ authority: 'reg.example', webhookSecret: 'short' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(run({ authority: 'reg.example', webhookSecret: '' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(run({ authority: 'reg.example', baseUrl: 'not a url' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('still requires authority (null is not accepted for the required field)', async () => {
    await expect(run({ authority: null })).rejects.toBeInstanceOf(BadRequestException);
  });

  // #246: an enrollment's tenant is immutable and the API has no delete route,
  // so a tenantId no key or claim can resolve to strands the authority for
  // good. TENANT_API_KEYS bindings are trimmed (tenant-context.ts), so a
  // padded value is unreachable — reject it rather than silently normalise.
  describe('tenantId (#246)', () => {
    it.each([
      ['trailing space', 'acme '],
      ['leading space', ' acme'],
      ['tab', 'acme\t'],
      ['newline', 'acme\n'],
      ['non-breaking space', 'acme '],
      ['whitespace only', '   '],
      ['empty', ''],
      ['control character', 'ac\u0000me'],
      ['DEL', 'ac\u007fme'],
    ])('rejects %s', async (_label, tenantId) => {
      await expect(run({ authority: 'reg.example', tenantId })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it.each(['acme', 'tenant-a', 'Acme Corp', 'org:team', 'a'])(
      'accepts %j unchanged (no charset beyond reachability)',
      async (tenantId) => {
        const out = await run({ authority: 'reg.example', tenantId });
        expect(out.tenantId).toBe(tenantId);
      },
    );

    it('still treats omitted / null as "use the caller tenant"', async () => {
      expect((await run({ authority: 'reg.example' })).tenantId).toBeUndefined();
      expect((await run({ authority: 'reg.example', tenantId: null })).tenantId).toBeNull();
    });
  });
});
