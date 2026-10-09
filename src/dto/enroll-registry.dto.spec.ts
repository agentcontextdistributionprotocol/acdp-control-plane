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
});
