import { RunsService } from './runs.service';

describe('RunsService', () => {
  let runRepo: any;
  let config: any;
  let contextEventRepo: any;
  let bandit: any;
  let svc: RunsService;
  let originalFetch: typeof fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    runRepo = {
      list: jest.fn(),
      findByIdOrThrow: jest.fn(),
      markComplete: jest.fn(),
    };
    config = { playgroundUrl: '' };
    contextEventRepo = { listByRun: jest.fn().mockResolvedValue([]) };
    bandit = { recordReward: jest.fn() };
    svc = new RunsService(runRepo, config, contextEventRepo as any, bandit as any);

    originalFetch = global.fetch;
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    (global as any).fetch = originalFetch;
  });

  it('list passes options through to the repo and wraps the result with pagination metadata', async () => {
    runRepo.list.mockResolvedValue({ data: [{ runId: 'r-1' }], total: 1 });
    const out = await svc.list({ limit: 25, offset: 0, status: 'running' });
    expect(runRepo.list).toHaveBeenCalledWith({
      limit: 25,
      offset: 0,
      status: 'running',
    });
    expect(out).toEqual({
      data: [{ runId: 'r-1' }],
      total: 1,
      limit: 25,
      offset: 0,
    });
  });

  it('getOrThrow delegates to the repo', async () => {
    runRepo.findByIdOrThrow.mockResolvedValue({ runId: 'r-1' });
    const run = await svc.getOrThrow('r-1');
    expect(run).toEqual({ runId: 'r-1' });
    expect(runRepo.findByIdOrThrow).toHaveBeenCalledWith('r-1', 'default');
  });

  it('records a bandit reward per participating agent on completion', async () => {
    runRepo.markComplete.mockResolvedValue({ runId: 'r-1', scenarioId: 'scenario-x' });
    contextEventRepo.listByRun.mockResolvedValue([
      { agentId: 'did:web:a' },
      { agentId: 'did:web:b' },
      { agentId: 'did:web:a' },
    ]);
    await svc.markComplete('r-1', 'completed', undefined, 'default');
    await new Promise((r) => setImmediate(r)); // fire-and-forget reward

    expect(bandit.recordReward).toHaveBeenCalledWith('scenario-x', 'did:web:a', 1);
    expect(bandit.recordReward).toHaveBeenCalledWith('scenario-x', 'did:web:b', 1);
    expect(bandit.recordReward).toHaveBeenCalledTimes(2); // deduped agents
  });

  it('records reward 0 for a failed run and skips reward for cancelled', async () => {
    runRepo.markComplete.mockResolvedValue({ runId: 'r-1', scenarioId: 'scenario-x' });
    contextEventRepo.listByRun.mockResolvedValue([{ agentId: 'did:web:a' }]);

    await svc.markComplete('r-1', 'failed', undefined, 'default');
    await new Promise((r) => setImmediate(r));
    expect(bandit.recordReward).toHaveBeenCalledWith('scenario-x', 'did:web:a', 0);

    bandit.recordReward.mockClear();
    await svc.markComplete('r-1', 'cancelled', undefined, 'default');
    await new Promise((r) => setImmediate(r));
    expect(bandit.recordReward).not.toHaveBeenCalled();
  });

  it('markComplete does not call playground when PLAYGROUND_URL is empty', async () => {
    runRepo.markComplete.mockResolvedValue({ runId: 'r-1', status: 'completed' });
    const out = await svc.markComplete('r-1', 'completed', { ok: true });
    expect(out).toEqual({ runId: 'r-1', status: 'completed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('markComplete fires playground notification when PLAYGROUND_URL is set', async () => {
    config.playgroundUrl = 'http://playground.local';
    runRepo.markComplete.mockResolvedValue({ runId: 'r-1' });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await svc.markComplete('r-1', 'completed', { ok: true });
    // notify is fire-and-forget — give it a tick
    await new Promise((r) => setImmediate(r));

    expect(fetchMock).toHaveBeenCalledWith(
      'http://playground.local/runs/r-1/complete',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('swallows playground notification failures', async () => {
    config.playgroundUrl = 'http://playground.local';
    runRepo.markComplete.mockResolvedValue({ runId: 'r-1' });
    fetchMock.mockRejectedValue(new Error('connection refused'));

    // The notification failure is swallowed: markComplete still returns the
    // persisted run rather than propagating the fetch rejection.
    await expect(svc.markComplete('r-1', 'completed')).resolves.toEqual({
      runId: 'r-1',
    });
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalled();
  });
});
