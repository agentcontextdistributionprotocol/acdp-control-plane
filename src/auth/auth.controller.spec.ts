/**
 * Verifies the OpenAPI document generated for AuthController:
 *   - both endpoints are present at their expected paths,
 *   - all DTO fields are documented,
 *   - response schemas reference the correct DTOs.
 *
 * Catches regressions where someone adds a new field to a DTO but
 * forgets the @ApiProperty annotation (which would otherwise silently
 * drop it from the generated spec).
 */
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AuthController, extractIp } from './auth.controller';
import { TokenIssuer } from './token-issuer.service';

describe('AuthController OpenAPI', () => {
  let document: ReturnType<typeof SwaggerModule.createDocument>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: TokenIssuer,
          useValue: {
            issueChallenge: jest.fn(),
            issueToken: jest.fn(),
          },
        },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    const config = new DocumentBuilder()
      .setTitle('test')
      .setVersion('1')
      .addBearerAuth()
      .addTag('auth')
      .build();
    document = SwaggerModule.createDocument(app, config);
    await app.close();
  });

  it('mounts POST /auth/challenge under the `auth` tag', () => {
    const op = document.paths['/auth/challenge']?.post;
    expect(op).toBeDefined();
    expect(op?.tags).toContain('auth');
    expect(op?.summary).toMatch(/signing input/i);
  });

  it('mounts POST /auth/token under the `auth` tag', () => {
    const op = document.paths['/auth/token']?.post;
    expect(op).toBeDefined();
    expect(op?.tags).toContain('auth');
    expect(op?.summary).toMatch(/bearer JWT/i);
  });

  it('documents ChallengeRequestDto.agent_id', () => {
    const schema = document.components?.schemas?.ChallengeRequestDto as any;
    expect(schema).toBeDefined();
    expect(schema.properties?.agent_id).toBeDefined();
    expect(schema.properties?.agent_id?.description).toMatch(/DID/);
  });

  it('documents all ChallengeResponseDto fields', () => {
    const schema = document.components?.schemas?.ChallengeResponseDto as any;
    expect(schema).toBeDefined();
    for (const field of ['nonce', 'registry_authority', 'expires_at', 'signing_input']) {
      expect(schema.properties?.[field]).toBeDefined();
    }
  });

  it('documents all TokenRequestDto fields including algorithm enum', () => {
    const schema = document.components?.schemas?.TokenRequestDto as any;
    expect(schema).toBeDefined();
    for (const field of [
      'agent_id',
      'key_id',
      'nonce',
      'expires_at',
      'algorithm',
      'signature',
    ]) {
      expect(schema.properties?.[field]).toBeDefined();
    }
    expect(schema.properties?.algorithm?.enum).toEqual(
      expect.arrayContaining(['ed25519', 'ecdsa-p256']),
    );
  });

  it('documents all TokenResponseDto fields', () => {
    const schema = document.components?.schemas?.TokenResponseDto as any;
    expect(schema).toBeDefined();
    for (const field of ['token', 'token_type', 'expires_at']) {
      expect(schema.properties?.[field]).toBeDefined();
    }
  });

  it('publishes 400 and 401 error responses on POST /auth/token', () => {
    const op = document.paths['/auth/token']?.post;
    expect(op?.responses?.['400']).toBeDefined();
    expect(op?.responses?.['401']).toBeDefined();
  });
});

describe('AuthController throttling metadata', () => {
  // Defends against the regression where @Throttle is silently removed
  // and the credential endpoints fall back to the global 200/min default.
  // @nestjs/throttler writes one metadata key per named-bucket override:
  // `THROTTLER:LIMIT<name>` and `THROTTLER:TTL<name>` on the method target.
  // We use 'default' (the canonical bucket name).
  for (const method of ['challenge', 'token'] as const) {
    it(`${method}() carries a tight throttle override`, () => {
      const target = AuthController.prototype[method];
      const limit = Reflect.getMetadata('THROTTLER:LIMITdefault', target);
      const ttl = Reflect.getMetadata('THROTTLER:TTLdefault', target);
      expect(limit).toBe(20);
      expect(ttl).toBe(60_000);
    });
  }
});

describe('extractIp (issuance-ledger signerIp)', () => {
  it('returns req.ip — the address Express resolved under TRUST_PROXY', () => {
    expect(extractIp({ ip: '198.51.100.4' })).toBe('198.51.100.4');
  });

  it('ignores X-Forwarded-For entirely (leftmost entry is client-written)', () => {
    const req = { ip: '127.0.0.1', headers: { 'x-forwarded-for': '6.6.6.6, 198.51.100.4' } };
    expect(extractIp(req as never)).toBe('127.0.0.1');
  });

  it('a 100-char spoofed X-Forwarded-For can no longer overflow signer_ip varchar(64)', () => {
    const req = { ip: '10.0.0.2', headers: { 'x-forwarded-for': 'x'.repeat(100) } };
    const out = extractIp(req as never);
    expect(out).toBe('10.0.0.2');
    expect(out!.length).toBeLessThanOrEqual(64);
  });

  it('undefined when Express has no address (socket already gone) or it is empty', () => {
    expect(extractIp({ ip: undefined })).toBeUndefined();
    expect(extractIp({ ip: '' })).toBeUndefined();
  });
});
