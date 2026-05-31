import { EventProcessorService } from './event-processor.service';

function mockInstrumentation() {
  return {
    eventsIngestedTotal: { inc: jest.fn() },
  } as any;
}

function makePayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: 'context_published',
    ctx_id: 'acdp://reg/c1',
    lineage_id: 'lin-1',
    agent_id: 'did:web:agent.example',
    context_type: 'task',
    visibility: 'public',
    version: 1,
    derived_from: [],
    registry_authority: 'reg.example',
    scenario_id: 's1',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('EventProcessorService', () => {
  let ceRepo: any;
  let runRepo: any;
  let lineageRepo: any;
  let agentRepo: any;
  let registryRepo: any;
  let streamHub: any;
  let webhookService: any;
  let processor: EventProcessorService;

  beforeEach(() => {
    ceRepo = { create: jest.fn().mockResolvedValue({}) };
    runRepo = { upsertFromEvent: jest.fn().mockResolvedValue(undefined) };
    lineageRepo = { upsert: jest.fn().mockResolvedValue(undefined) };
    agentRepo = { upsert: jest.fn().mockResolvedValue(undefined) };
    registryRepo = { upsert: jest.fn().mockResolvedValue(undefined) };
    streamHub = {
      publishToRun: jest.fn(),
      publishGlobal: jest.fn(),
    };
    webhookService = { fireEvent: jest.fn().mockResolvedValue(undefined) };

    processor = new EventProcessorService(
      ceRepo,
      runRepo,
      lineageRepo,
      agentRepo,
      registryRepo,
      streamHub,
      mockInstrumentation(),
      webhookService,
    );
  });

  it('persists the raw event with normalized fields', async () => {
    await processor.process(makePayload(), 'run-1');
    expect(ceRepo.create).toHaveBeenCalledTimes(1);
    const arg = ceRepo.create.mock.calls[0][0];
    expect(arg).toEqual(
      expect.objectContaining({
        eventType: 'context_published',
        runId: 'run-1',
        ctxId: 'acdp://reg/c1',
        agentId: 'did:web:agent.example',
        registryAuthority: 'reg.example',
        scenarioId: 's1',
        derivedFrom: [],
      }),
    );
  });

  it('upserts the run when a runId is supplied; skips when not', async () => {
    await processor.process(makePayload(), 'run-1');
    expect(runRepo.upsertFromEvent).toHaveBeenCalledWith('run-1', 's1', 'reg.example', 'default');

    runRepo.upsertFromEvent.mockClear();
    await processor.process(makePayload(), undefined);
    expect(runRepo.upsertFromEvent).not.toHaveBeenCalled();
  });

  it('inserts one lineage edge per derived_from entry on context_published', async () => {
    await processor.process(
      makePayload({
        ctx_id: 'acdp://reg/c3',
        derived_from: ['acdp://reg/c1', 'acdp://reg/c2'],
      }),
      'run-1',
    );
    expect(lineageRepo.upsert).toHaveBeenCalledTimes(2);
    expect(lineageRepo.upsert).toHaveBeenCalledWith({
      fromCtxId: 'acdp://reg/c1',
      toCtxId: 'acdp://reg/c3',
      runId: 'run-1',
      tenantId: 'default',
    });
    expect(lineageRepo.upsert).toHaveBeenCalledWith({
      fromCtxId: 'acdp://reg/c2',
      toCtxId: 'acdp://reg/c3',
      runId: 'run-1',
      tenantId: 'default',
    });
  });

  it('does not insert lineage edges for non-context_published events', async () => {
    await processor.process(
      makePayload({ type: 'context_archived', derived_from: ['acdp://reg/c1'] }),
      'run-1',
    );
    expect(lineageRepo.upsert).not.toHaveBeenCalled();
  });

  it('publishes to per-run stream when runId present, always publishes globally', async () => {
    await processor.process(makePayload(), 'run-1');
    expect(streamHub.publishToRun).toHaveBeenCalledWith('run-1', expect.any(Object), 'default');
    expect(streamHub.publishGlobal).toHaveBeenCalledTimes(1);
    expect(streamHub.publishGlobal).toHaveBeenCalledWith(expect.any(Object), 'default');

    streamHub.publishToRun.mockClear();
    streamHub.publishGlobal.mockClear();
    await processor.process(makePayload(), undefined);
    expect(streamHub.publishToRun).not.toHaveBeenCalled();
    expect(streamHub.publishGlobal).toHaveBeenCalledTimes(1);
  });

  it('upserts agent and registry, and fires outbound webhooks', async () => {
    await processor.process(makePayload(), 'run-1');
    expect(agentRepo.upsert).toHaveBeenCalledWith('did:web:agent.example', 'reg.example', 'default');
    expect(registryRepo.upsert).toHaveBeenCalledWith('reg.example', undefined, 'default');
    expect(webhookService.fireEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'context_published', runId: 'run-1' }),
      'default',
    );
  });

  it('skips all downstream side effects when the event is a duplicate (create → null)', async () => {
    ceRepo.create.mockResolvedValueOnce(null);
    await processor.process(makePayload(), 'run-1');
    expect(runRepo.upsertFromEvent).not.toHaveBeenCalled();
    expect(lineageRepo.upsert).not.toHaveBeenCalled();
    expect(streamHub.publishGlobal).not.toHaveBeenCalled();
    expect(webhookService.fireEvent).not.toHaveBeenCalled();
  });

  it('sets a fingerprint on the persisted event', async () => {
    await processor.process(makePayload(), 'run-1');
    expect(ceRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: expect.stringMatching(/^[a-f0-9]{32}$/) }),
    );
  });

  it('propagates registry base URL from the Origin header to registryRepo.upsert', async () => {
    await processor.process(makePayload(), 'run-1', 'default', 'https://reg-a.example');
    expect(registryRepo.upsert).toHaveBeenCalledWith(
      'reg.example',
      'https://reg-a.example',
      'default',
    );
  });

  it('prefers payload.registry_base_url over the Origin header', async () => {
    await processor.process(
      makePayload({ registry_base_url: 'https://from-payload.example' }),
      'run-1',
      'default',
      'https://from-origin.example',
    );
    expect(registryRepo.upsert).toHaveBeenCalledWith(
      'reg.example',
      'https://from-payload.example',
      'default',
    );
  });

  it('extracts scenarioId from metadata when not on the top-level', async () => {
    const payload = makePayload({
      scenario_id: undefined,
      metadata: { scenario_id: 'from-meta' },
    });
    await processor.process(payload, 'run-1');
    expect(runRepo.upsertFromEvent).toHaveBeenCalledWith('run-1', 'from-meta', 'reg.example', 'default');
  });

  it('falls back to "unknown" scenario when no scenarioId is anywhere', async () => {
    const payload = makePayload({ scenario_id: undefined });
    await processor.process(payload, 'run-1');
    expect(runRepo.upsertFromEvent).toHaveBeenCalledWith('run-1', 'unknown', 'reg.example', 'default');
  });

  it('defaults event timestamp to "now" when payload omits created_at', async () => {
    const payload = makePayload({ created_at: undefined });
    await processor.process(payload, 'run-1');
    const arg = ceRepo.create.mock.calls[0][0];
    expect(typeof arg.eventTs).toBe('string');
    expect(arg.eventTs.length).toBeGreaterThan(0);
  });
});
