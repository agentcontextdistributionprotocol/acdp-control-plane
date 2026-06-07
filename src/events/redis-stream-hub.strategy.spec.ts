import { AcdpStreamEvent } from '../contracts/acdp';

/**
 * Fake ioredis: publisher + subscriber are distinct instances that share a
 * process-global channel registry, so a `publish` on one instance fans out to
 * the `message` handler of every instance subscribed to that channel — exactly
 * how real Redis pub/sub delivers an instance its own published messages.
 */
const channelHandlers = new Map<string, Array<(ch: string, msg: string) => void>>();

class FakeRedis {
  private subscribedChannel: string | null = null;
  private handler: ((ch: string, msg: string) => void) | null = null;

  subscribe(channel: string, cb?: (err: Error | null) => void): void {
    this.subscribedChannel = channel;
    if (this.handler) this.register();
    if (cb) cb(null);
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    if (event !== 'message') return;
    this.handler = cb as (ch: string, msg: string) => void;
    if (this.subscribedChannel) this.register();
  }

  private register(): void {
    if (!this.subscribedChannel || !this.handler) return;
    const list = channelHandlers.get(this.subscribedChannel) ?? [];
    list.push(this.handler);
    channelHandlers.set(this.subscribedChannel, list);
    this.handler = null; // avoid double-registering on later subscribe/on calls
  }

  async publish(channel: string, message: string): Promise<number> {
    const list = channelHandlers.get(channel) ?? [];
    for (const h of list) h(channel, message);
    return list.length;
  }

  async quit(): Promise<string> {
    return 'OK';
  }
}

jest.mock('ioredis', () => FakeRedis);

// Imported AFTER the mock so the in-method `require('ioredis')` picks up the fake.
import { RedisStreamHubStrategy } from './redis-stream-hub.strategy';

function event(overrides: Partial<AcdpStreamEvent> = {}): AcdpStreamEvent {
  return {
    type: 'context_published',
    ts: '2026-01-01T00:00:00Z',
    runId: 'r1',
    ctxId: 'acdp://reg/c1',
    agentId: 'did:web:a.example',
    contextType: 'task',
    registryAuthority: 'reg.example',
    derivedFrom: [],
    ...overrides,
  };
}

describe('RedisStreamHubStrategy', () => {
  let hub: RedisStreamHubStrategy;

  beforeEach(async () => {
    channelHandlers.clear();
    hub = new RedisStreamHubStrategy('redis://localhost:6379');
    // connect() is fire-and-forget in the constructor; let it run.
    await new Promise((r) => setImmediate(r));
  });

  afterEach(() => {
    hub.destroy();
  });

  it('delivers a published run event to same-instance subscribers EXACTLY ONCE (no double-emit)', async () => {
    const received: AcdpStreamEvent[] = [];
    const sub = hub.streamRun('r1', 'tenant-a').subscribe((e) => received.push(e));

    hub.publishToRun('r1', event({ ts: 't1' }), 'tenant-a');

    await new Promise((r) => setImmediate(r));
    sub.unsubscribe();

    // Regression guard: the round-trip through the subscriber connection is the
    // single delivery path. A direct local emit in publish() would duplicate it.
    expect(received.map((e) => e.ts)).toEqual(['t1']);
  });

  it('delivers a global event exactly once and is tenant-scoped', async () => {
    const received: AcdpStreamEvent[] = [];
    const sub = hub.streamGlobal('tenant-a').subscribe((e) => received.push(e));

    hub.publishGlobal(event({ ts: 'a-evt' }), 'tenant-a');
    hub.publishGlobal(event({ ts: 'b-evt' }), 'tenant-b');

    await new Promise((r) => setImmediate(r));
    sub.unsubscribe();

    expect(received.map((e) => e.ts)).toEqual(['a-evt']);
  });
});
