import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';
import { DomainPackRegistry } from '../domain-packs/domain-pack';
import { FINANCE_PACK } from '../domain-packs/finance.pack';
import { EventProcessorService } from '../processor/event-processor.service';
import { extractAuthorityFromCtxId, IngestService } from './ingest.service';

describe('IngestService', () => {
  const secret = 'svc-test-secret';
  const validPayload = {
    type: 'context_published',
    agent_id: 'did:web:a.example',
    registry_authority: 'reg.example',
    created_at: '2026-01-01T00:00:00Z',
  };

  let processor: { process: jest.Mock };
  let config: Partial<AppConfigService>;
  let packs: DomainPackRegistry;
  let enrollmentRepo: { findByAuthority: jest.Mock };
  let instrumentation: { ingestRejectedTotal: { inc: jest.Mock } };
  let service: IngestService;

  function sign(body: Buffer): string {
    return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }

  beforeEach(() => {
    processor = { process: jest.fn().mockResolvedValue(undefined) };
    config = { webhookSecret: secret } as Partial<AppConfigService>;
    packs = new DomainPackRegistry(); // empty → context-type gate is inactive
    enrollmentRepo = { findByAuthority: jest.fn().mockResolvedValue(null) };
    instrumentation = { ingestRejectedTotal: { inc: jest.fn() } };
    service = new IngestService(
      config as AppConfigService,
      processor as unknown as EventProcessorService,
      packs,
      enrollmentRepo as any,
      instrumentation as any,
    );
  });

  it('verifies HMAC, parses JSON, and delegates to the processor', async () => {
    const body = Buffer.from(JSON.stringify(validPayload));
    await service.handle(body, sign(body), 'run-123');

    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(processor.process).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'context_published' }),
      'run-123',
      'default',
      undefined,
      undefined,
    );
  });

  it('prefers X-Run-Id header over payload.run_id when both are present', async () => {
    const withEmbedded = { ...validPayload, run_id: 'payload-run' };
    const body = Buffer.from(JSON.stringify(withEmbedded));
    await service.handle(body, sign(body), 'header-run');
    expect(processor.process).toHaveBeenCalledWith(
      expect.any(Object),
      'header-run',
      'default',
      undefined,
      undefined,
    );
  });

  it('falls back to payload.run_id when no header is provided', async () => {
    const withEmbedded = { ...validPayload, run_id: 'payload-run' };
    const body = Buffer.from(JSON.stringify(withEmbedded));
    await service.handle(body, sign(body), undefined);
    expect(processor.process).toHaveBeenCalledWith(
      expect.any(Object),
      'payload-run',
      'default',
      undefined,
      undefined,
    );
  });

  it('threads the X-ACDP-Event-Id header into the processor as the dedup id', async () => {
    const body = Buffer.from(JSON.stringify(validPayload));
    await service.handle(body, sign(body), 'run-1', 'default', undefined, 'evt-hdr-1');
    expect(processor.process).toHaveBeenCalledWith(
      expect.any(Object),
      'run-1',
      'default',
      undefined,
      'evt-hdr-1',
    );
  });

  it('falls back to payload.event_id when the header is absent', async () => {
    const withId = { ...validPayload, event_id: 'evt-body-1' };
    const body = Buffer.from(JSON.stringify(withId));
    await service.handle(body, sign(body), 'run-1');
    expect(processor.process).toHaveBeenCalledWith(
      expect.any(Object),
      'run-1',
      'default',
      undefined,
      'evt-body-1',
    );
  });

  describe('agent_id requirement (scoped to context_published)', () => {
    it('accepts context_retrieved with no agent_id', async () => {
      const payload = {
        type: 'context_retrieved',
        registry_authority: 'reg.example',
        ctx_id: 'acdp://reg.example/c1',
        created_at: '2026-01-01T00:00:00Z',
      };
      const body = Buffer.from(JSON.stringify(payload));
      await service.handle(body, sign(body), undefined);
      expect(processor.process).toHaveBeenCalledTimes(1);
    });

    it('accepts search_executed with no agent_id', async () => {
      const payload = {
        type: 'search_executed',
        registry_authority: 'reg.example',
        created_at: '2026-01-01T00:00:00Z',
      };
      const body = Buffer.from(JSON.stringify(payload));
      await service.handle(body, sign(body), undefined);
      expect(processor.process).toHaveBeenCalledTimes(1);
    });

    it('still rejects context_published with no agent_id', async () => {
      const payload = {
        type: 'context_published',
        registry_authority: 'reg.example',
        created_at: '2026-01-01T00:00:00Z',
      };
      const body = Buffer.from(JSON.stringify(payload));
      await expect(service.handle(body, sign(body), undefined)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(processor.process).not.toHaveBeenCalled();
    });
  });

  it('throws Unauthorized on bad signature', async () => {
    const body = Buffer.from(JSON.stringify(validPayload));
    await expect(service.handle(body, 'sha256=deadbeef', undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(processor.process).not.toHaveBeenCalled();
  });

  it('throws BadRequest on invalid JSON', async () => {
    const body = Buffer.from('not json');
    await expect(service.handle(body, sign(body), undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws BadRequest when required fields are missing', async () => {
    const body = Buffer.from(JSON.stringify({ type: 'x' }));
    await expect(service.handle(body, sign(body), undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws BadRequest on a non-object payload', async () => {
    const body = Buffer.from('null');
    await expect(service.handle(body, sign(body), undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('skips HMAC verification when webhookSecret is empty (dev mode)', async () => {
    // AppConfigService fields are readonly, so re-instantiate instead of mutating.
    const emptySecretConfig = { webhookSecret: '' } as Partial<AppConfigService>;
    service = new IngestService(
      emptySecretConfig as AppConfigService,
      processor as unknown as EventProcessorService,
      packs,
      enrollmentRepo as any,
      instrumentation as any,
    );
    const body = Buffer.from(JSON.stringify(validPayload));
    await service.handle(body, '', undefined);
    expect(processor.process).toHaveBeenCalledTimes(1);
  });

  describe('domain-pack context-type gate', () => {
    it('rejects events whose context_type is not declared by any active pack', async () => {
      const reg = new DomainPackRegistry();
      reg.register(FINANCE_PACK);
      service = new IngestService(
        config as AppConfigService,
        processor as unknown as EventProcessorService,
        reg,
        enrollmentRepo as any,
        instrumentation as any,
      );
      const body = Buffer.from(
        JSON.stringify({ ...validPayload, context_type: 'task' }),
      );
      await expect(
        service.handle(body, sign(body), undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(processor.process).not.toHaveBeenCalled();
      // The rejection must be observable (warn-log counterpart + metric), not silent.
      expect(instrumentation.ingestRejectedTotal.inc).toHaveBeenCalledWith({
        reason: 'pack_gate',
      });
    });

    it('accepts events whose context_type matches a pack-declared type', async () => {
      const reg = new DomainPackRegistry();
      reg.register(FINANCE_PACK);
      service = new IngestService(
        config as AppConfigService,
        processor as unknown as EventProcessorService,
        reg,
        enrollmentRepo as any,
        instrumentation as any,
      );
      const body = Buffer.from(
        JSON.stringify({ ...validPayload, context_type: 'earnings_report' }),
      );
      await service.handle(body, sign(body), undefined);
      expect(processor.process).toHaveBeenCalledTimes(1);
    });

    it('accepts base ACDP types even when a pack is active (FEAT-CP-07)', async () => {
      const reg = new DomainPackRegistry();
      reg.register(FINANCE_PACK);
      service = new IngestService(
        config as AppConfigService,
        processor as unknown as EventProcessorService,
        reg,
        enrollmentRepo as any,
        instrumentation as any,
      );
      const body = Buffer.from(
        JSON.stringify({ ...validPayload, context_type: 'data_snapshot' }),
      );
      await service.handle(body, sign(body), undefined);
      expect(processor.process).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when no packs are registered (backward compat)', async () => {
      // service from beforeEach uses an empty registry
      const body = Buffer.from(
        JSON.stringify({ ...validPayload, context_type: 'anything-goes' }),
      );
      await service.handle(body, sign(body), undefined);
      expect(processor.process).toHaveBeenCalledTimes(1);
    });
  });

  describe('registry enrollment', () => {
    it('derives tenant from the enrollment and verifies against its per-registry secret', async () => {
      const perRegistrySecret = 'per-registry-secret-1234';
      enrollmentRepo.findByAuthority.mockResolvedValue({
        authority: 'reg.example',
        tenantId: 'tenant-enrolled',
        webhookSecret: perRegistrySecret,
        baseUrl: 'https://reg.example',
        enabled: true,
      });
      const body = Buffer.from(JSON.stringify(validPayload));
      const sig = `sha256=${createHmac('sha256', perRegistrySecret).update(body).digest('hex')}`;

      await service.handle(body, sig, 'run-x', 'header-tenant-ignored');

      expect(processor.process).toHaveBeenCalledTimes(1);
      const call = processor.process.mock.calls[0];
      expect(call[2]).toBe('tenant-enrolled'); // tenant from enrollment, not header
      expect(call[3]).toBe('https://reg.example'); // base URL from enrollment
    });

    it('rejects when the global secret signature is used but a per-registry secret is enrolled', async () => {
      enrollmentRepo.findByAuthority.mockResolvedValue({
        authority: 'reg.example',
        tenantId: 'tenant-enrolled',
        webhookSecret: 'per-registry-secret-1234',
        enabled: true,
      });
      const body = Buffer.from(JSON.stringify(validPayload));
      // Signed with the GLOBAL secret, which no longer applies.
      await expect(service.handle(body, sign(body), undefined)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(processor.process).not.toHaveBeenCalled();
    });

    it('rejects ingest from a disabled enrollment', async () => {
      enrollmentRepo.findByAuthority.mockResolvedValue({
        authority: 'reg.example',
        tenantId: 'tenant-enrolled',
        webhookSecret: null,
        enabled: false,
      });
      const body = Buffer.from(JSON.stringify(validPayload));
      await expect(service.handle(body, sign(body), undefined)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('rejects unenrolled authorities when INGEST_REQUIRE_ENROLLMENT is set', async () => {
      const strictConfig = {
        webhookSecret: secret,
        ingestRequireEnrollment: true,
      } as Partial<AppConfigService>;
      service = new IngestService(
        strictConfig as AppConfigService,
        processor as unknown as EventProcessorService,
        packs,
        enrollmentRepo as any, // findByAuthority → null (not enrolled)
        instrumentation as any,
      );
      const body = Buffer.from(JSON.stringify(validPayload));
      await expect(service.handle(body, sign(body), undefined)).rejects.toMatchObject({
        status: 403,
      });
      expect(processor.process).not.toHaveBeenCalled();
    });
  });

  it('extracts registry_authority from ctx_id when the payload omits it', async () => {
    // Mirrors what an actual ACDP registry WebhookEvent looks like: no
    // explicit `registry_authority`, but `ctx_id` is `acdp://<authority>/<id>`.
    const payload = {
      type: 'context_published',
      agent_id: 'did:web:a.example',
      ctx_id: 'acdp://registry-a.playground.local/01H3X4Y5',
      created_at: '2026-01-01T00:00:00Z',
    };
    const body = Buffer.from(JSON.stringify(payload));
    await service.handle(body, sign(body), undefined);

    expect(processor.process).toHaveBeenCalledTimes(1);
    const [forwarded] = processor.process.mock.calls[0];
    expect(forwarded.registry_authority).toBe('registry-a.playground.local');
  });

  it('throws BadRequest when both registry_authority and ctx_id authority are missing', async () => {
    const payload = {
      type: 'context_published',
      agent_id: 'did:web:a.example',
      // no ctx_id, no registry_authority
    };
    const body = Buffer.from(JSON.stringify(payload));
    await expect(service.handle(body, sign(body), undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('extractAuthorityFromCtxId', () => {
  it('returns the authority for a well-formed acdp:// ctx_id', () => {
    expect(extractAuthorityFromCtxId('acdp://registry-a.example/01ABC')).toBe(
      'registry-a.example',
    );
  });
  it('returns undefined for non-acdp URIs', () => {
    expect(extractAuthorityFromCtxId('https://example.com/x')).toBeUndefined();
    expect(extractAuthorityFromCtxId('')).toBeUndefined();
    expect(extractAuthorityFromCtxId(undefined)).toBeUndefined();
    expect(extractAuthorityFromCtxId(null)).toBeUndefined();
    expect(extractAuthorityFromCtxId(42)).toBeUndefined();
  });
  it('returns undefined when the acdp:// prefix is followed by an empty authority', () => {
    expect(extractAuthorityFromCtxId('acdp:///01ABC')).toBeUndefined();
  });
});
