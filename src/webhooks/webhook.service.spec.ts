import { WebhookService } from './webhook.service';

function mockInstrumentation() {
  return { webhookDeliveriesTotal: { inc: jest.fn() } } as any;
}

describe('WebhookService', () => {
  let webhookRepo: any;
  let deliveryRepo: any;
  let svc: WebhookService;
  let originalFetch: typeof fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    webhookRepo = {
      create: jest.fn(),
      list: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      listActive: jest.fn(),
      findById: jest.fn(),
    };
    deliveryRepo = {
      create: jest.fn().mockImplementation((input) =>
        Promise.resolve({
          id: 'del-1',
          ...input,
          status: 'pending',
          attempts: 0,
        }),
      ),
      markDelivered: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      listPending: jest.fn().mockResolvedValue([]),
      listAllPending: jest.fn().mockResolvedValue([]),
    };

    originalFetch = global.fetch;
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;

    svc = new WebhookService(
      webhookRepo,
      deliveryRepo,
      mockInstrumentation(),
      { webhookRetryIntervalMs: 0 } as any,
    );
  });

  afterEach(() => {
    (global as any).fetch = originalFetch;
  });

  it('only delivers to subscriptions whose events list matches (empty list = all)', async () => {
    webhookRepo.listActive.mockResolvedValue([
      { id: 'wh-all', url: 'https://a.example/h', secret: 's1', events: [] },
      { id: 'wh-match', url: 'https://b.example/h', secret: 's2', events: ['context_published'] },
      { id: 'wh-other', url: 'https://c.example/h', secret: 's3', events: ['context_archived'] },
    ]);
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await svc.fireEvent({
      event: 'context_published',
      runId: 'r-1',
      timestamp: '2026-01-01T00:00:00Z',
    });

    expect(deliveryRepo.create).toHaveBeenCalledTimes(2);
    const webhookIds = deliveryRepo.create.mock.calls.map(
      (c: any[]) => c[0].webhookId,
    );
    expect(webhookIds.sort()).toEqual(['wh-all', 'wh-match']);
  });

  it('signs the body with HMAC-SHA256 and sets X-ACDP-Signature + X-ACDP-Event headers', async () => {
    webhookRepo.listActive.mockResolvedValue([
      { id: 'wh-1', url: 'https://x.example/h', secret: 'shh', events: [] },
    ]);
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await svc.fireEvent({
      event: 'context_published',
      runId: 'r-1',
      timestamp: '2026-01-01T00:00:00Z',
    });
    // Wait a microtask for the fire-and-forget delivery to run
    await new Promise((r) => setImmediate(r));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://x.example/h',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-ACDP-Event': 'context_published',
          'X-ACDP-Signature': expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
        }),
      }),
    );
  });

  it('marks delivery successful on 2xx and increments the delivered counter', async () => {
    webhookRepo.listActive.mockResolvedValue([
      { id: 'wh-1', url: 'https://x.example/h', secret: 's', events: [] },
    ]);
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await svc.fireEvent({
      event: 'context_published',
      runId: 'r-1',
      timestamp: '2026-01-01T00:00:00Z',
    });
    await new Promise((r) => setImmediate(r));

    expect(deliveryRepo.markDelivered).toHaveBeenCalledWith('del-1', 200, 'default');
  });

  it('swallows repository errors so fire-and-forget callers do not crash', async () => {
    webhookRepo.listActive.mockRejectedValue(new Error('db down'));
    await expect(
      svc.fireEvent({
        event: 'context_published',
        runId: 'r-1',
        timestamp: '2026-01-01T00:00:00Z',
      }),
    ).resolves.toBeUndefined();
    expect(deliveryRepo.create).not.toHaveBeenCalled();
  });

  it('scopes fireEvent to the given tenant (listActive + delivery + markDelivered)', async () => {
    webhookRepo.listActive.mockResolvedValue([
      { id: 'wh-1', url: 'https://x.example/h', secret: 's', events: [] },
    ]);
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await svc.fireEvent(
      { event: 'context_published', runId: 'r-1', timestamp: '2026-01-01T00:00:00Z' },
      'tenant-a',
    );
    await new Promise((r) => setImmediate(r));

    expect(webhookRepo.listActive).toHaveBeenCalledWith('tenant-a');
    expect(deliveryRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: 'wh-1', tenantId: 'tenant-a' }),
    );
    expect(deliveryRepo.markDelivered).toHaveBeenCalledWith('del-1', 200, 'tenant-a');
  });

  it('retryAllPending re-delivers across tenants, scoping each lookup to its delivery tenant', async () => {
    deliveryRepo.listAllPending.mockResolvedValue([
      { id: 'del-a', webhookId: 'wh-a', tenantId: 'tenant-a', payload: { event: 'e', runId: 'r', timestamp: 't' }, attempts: 1 },
      { id: 'del-b', webhookId: 'wh-b', tenantId: 'tenant-b', payload: { event: 'e', runId: 'r', timestamp: 't' }, attempts: 1 },
    ]);
    webhookRepo.findById.mockImplementation((id: string, tenantId: string) =>
      Promise.resolve({ id, url: `https://${tenantId}.example/h`, secret: 's', events: [] }),
    );
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const n = await svc.retryAllPending();
    await new Promise((r) => setImmediate(r));

    expect(n).toBe(2);
    expect(webhookRepo.findById).toHaveBeenCalledWith('wh-a', 'tenant-a');
    expect(webhookRepo.findById).toHaveBeenCalledWith('wh-b', 'tenant-b');
    expect(deliveryRepo.markDelivered).toHaveBeenCalledWith('del-a', 200, 'tenant-a');
    expect(deliveryRepo.markDelivered).toHaveBeenCalledWith('del-b', 200, 'tenant-b');
  });

  it('honors a 429 Retry-After (delta-seconds): schedules next attempt >= 30s out', async () => {
    webhookRepo.listActive.mockResolvedValue([
      { id: 'wh-1', url: 'https://x.example/h', secret: 's', events: [] },
    ]);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '30' }),
    });

    const before = Date.now();
    await svc.fireEvent({
      event: 'context_published',
      runId: 'r-1',
      timestamp: '2026-01-01T00:00:00Z',
    });
    await new Promise((r) => setImmediate(r));

    expect(deliveryRepo.markFailed).toHaveBeenCalledTimes(1);
    const call = deliveryRepo.markFailed.mock.calls[0];
    // markFailed(id, attempt, errorMessage, responseStatus, tenantId, nextAttemptAt)
    const [id, attempt, , responseStatus, tenantId, nextAttemptAt] = call;
    expect(id).toBe('del-1');
    expect(attempt).toBe(1);
    expect(responseStatus).toBe(429);
    expect(tenantId).toBe('default');
    const scheduledMs = Date.parse(nextAttemptAt);
    expect(scheduledMs).toBeGreaterThanOrEqual(before + 30_000);
    // It defers to the sweep — does NOT mark delivered.
    expect(deliveryRepo.markDelivered).not.toHaveBeenCalled();
  });

  it('honors a 429 Retry-After in HTTP-date form', async () => {
    webhookRepo.listActive.mockResolvedValue([
      { id: 'wh-1', url: 'https://x.example/h', secret: 's', events: [] },
    ]);
    const target = new Date(Date.now() + 45_000);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': target.toUTCString() }),
    });

    await svc.fireEvent({
      event: 'context_published',
      runId: 'r-1',
      timestamp: '2026-01-01T00:00:00Z',
    });
    await new Promise((r) => setImmediate(r));

    expect(deliveryRepo.markFailed).toHaveBeenCalledTimes(1);
    const nextAttemptAt = deliveryRepo.markFailed.mock.calls[0][5];
    // HTTP-date has second precision; allow a 1s floor for rounding.
    expect(Date.parse(nextAttemptAt)).toBeGreaterThanOrEqual(target.getTime() - 1000);
  });

  it('falls back to normal backoff when a 429 carries no parseable Retry-After', async () => {
    webhookRepo.listActive.mockResolvedValue([
      { id: 'wh-1', url: 'https://x.example/h', secret: 's', events: [] },
    ]);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers(),
    });

    await svc.fireEvent({
      event: 'context_published',
      runId: 'r-1',
      timestamp: '2026-01-01T00:00:00Z',
    });
    // One microtask lets the first inline attempt record its failure (before
    // the backoff sleep), which is all we assert on here.
    await new Promise((r) => setImmediate(r));

    // The first inline attempt records a failure with NO scheduled next
    // attempt (the 429 deferral path passes a 6th arg; the ordinary failure
    // path does not), i.e. normal backoff applies.
    expect(deliveryRepo.markFailed).toHaveBeenCalled();
    const firstCall = deliveryRepo.markFailed.mock.calls[0];
    expect(firstCall[5]).toBeUndefined();
  });

  it('does not deliver when no active webhook matches the event', async () => {
    webhookRepo.listActive.mockResolvedValue([
      { id: 'wh-1', url: 'https://x.example/h', secret: 's', events: ['context_archived'] },
    ]);

    await svc.fireEvent({
      event: 'context_published',
      runId: 'r-1',
      timestamp: '2026-01-01T00:00:00Z',
    });

    expect(deliveryRepo.create).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
