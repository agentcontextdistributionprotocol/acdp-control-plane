import { of } from 'rxjs';
import { AcdpStreamEvent } from '../contracts/acdp';
import { StreamHubService } from './stream-hub.service';
import { StreamHubStrategy } from './stream-hub.interface';

function makeStrategy(extra: Partial<StreamHubStrategy> = {}) {
  return {
    publishToRun: jest.fn(),
    publishGlobal: jest.fn(),
    streamRun: jest.fn().mockReturnValue(of()),
    streamGlobal: jest.fn().mockReturnValue(of()),
    ...extra,
  } as unknown as StreamHubStrategy & {
    publishToRun: jest.Mock;
    publishGlobal: jest.Mock;
    streamRun: jest.Mock;
    streamGlobal: jest.Mock;
  };
}

const EVT = { type: 'context_published' } as unknown as AcdpStreamEvent;

describe('StreamHubService', () => {
  it('delegates publishToRun to the strategy with run, event, tenant', () => {
    const strategy = makeStrategy();
    new StreamHubService(strategy).publishToRun('run-1', EVT, 'tenant-a');
    expect(strategy.publishToRun).toHaveBeenCalledWith('run-1', EVT, 'tenant-a');
  });

  it('delegates publishGlobal to the strategy with event, tenant', () => {
    const strategy = makeStrategy();
    new StreamHubService(strategy).publishGlobal(EVT, 'tenant-a');
    expect(strategy.publishGlobal).toHaveBeenCalledWith(EVT, 'tenant-a');
  });

  it('delegates streamRun and returns the strategy observable', () => {
    const stream = of(EVT);
    const strategy = makeStrategy({ streamRun: jest.fn().mockReturnValue(stream) as never });
    const out = new StreamHubService(strategy).streamRun('run-1', 'tenant-a');
    expect(strategy.streamRun).toHaveBeenCalledWith('run-1', 'tenant-a');
    expect(out).toBe(stream);
  });

  it('delegates streamGlobal and returns the strategy observable', () => {
    const stream = of(EVT);
    const strategy = makeStrategy({ streamGlobal: jest.fn().mockReturnValue(stream) as never });
    const out = new StreamHubService(strategy).streamGlobal('tenant-a');
    expect(strategy.streamGlobal).toHaveBeenCalledWith('tenant-a');
    expect(out).toBe(stream);
  });

  describe('onModuleDestroy', () => {
    it('calls strategy.destroy() when the strategy exposes one', () => {
      const destroy = jest.fn();
      const strategy = makeStrategy({ destroy } as never);
      new StreamHubService(strategy).onModuleDestroy();
      expect(destroy).toHaveBeenCalled();
    });

    it('is a no-op when the strategy has no destroy() (e.g. memory strategy)', () => {
      const strategy = makeStrategy();
      expect(() => new StreamHubService(strategy).onModuleDestroy()).not.toThrow();
    });
  });
});
