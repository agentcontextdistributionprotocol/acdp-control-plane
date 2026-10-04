import { AcdpStreamEvent } from '../contracts/acdp';

/**
 * Fake ioredis: publisher + subscriber are distinct instances that share a
 * process-global channel registry, so a `publish` on one instance fans out to
 * the `message` handler of every instance subscribed to that channel — exactly
 * how real Redis pub/sub delivers an instance its own published messages.
 */
const channelHandlers = new Map<string, Array<(ch: string, msg: string) => void>>();

class FakeRedis {
  /** Every constructed client, so a test can drive ioredis's `status`. */
  static instances: FakeRedis[] = [];
  /** ioredis connection state; `ready` once connected. */
  status = 'ready';
  quits = 0;
  disconnects = 0;
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
    this.quits++;
    return 'OK';
  }

  disconnect(): void {
    this.disconnects++;
    this.status = 'end';
  }

  constructor() {
    FakeRedis.instances.push(this);
  }
}

jest.mock('ioredis', () => FakeRedis);

// Imported AFTER the mock so the in-method `await import('ioredis')` picks up
// the fake. The mock returns the FakeRedis class itself, which has no `.default`
// — the strategy destructures one, and it still resolves because TypeScript's
// esModuleInterop helper synthesizes `.default` for a CommonJS module. Verified
// by the "Connected to Redis stream hub" log, not assumed: had it not resolved,
// `new undefined()` would have thrown into connect()'s catch and these tests
// would still have passed while exercising nothing.
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
    FakeRedis.instances = [];
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
  // ── issue #210 Phase 3: report-only transport health ──────────────────
  describe('health()', () => {
    it('is "up" only when BOTH the publisher and the subscriber are ready', () => {
      expect(FakeRedis.instances).toHaveLength(2);
      expect(hub.health()).toEqual({ status: 'up' });
      for (const which of [0, 1]) {
        for (const state of ['connecting', 'reconnecting', 'wait', 'close', 'end']) {
          FakeRedis.instances[which].status = state;
          expect({ which, state, health: hub.health() }).toEqual({
            which,
            state,
            health: { status: 'down' },
          });
        }
        FakeRedis.instances[which].status = 'ready';
      }
      expect(hub.health()).toEqual({ status: 'up' });
    });

    it('is "down" before the clients exist (connect() still pending at boot)', () => {
      const fresh = new RedisStreamHubStrategy('redis://localhost:6379');
      // The constructor's connect() has not run its dynamic import yet.
      expect(fresh.health()).toEqual({ status: 'down' });
      fresh.destroy();
    });
  });

  describe('destroy()', () => {
    it('QUITs a ready client but disconnect()s one that is not (no reconnect loop left behind)', () => {
      const [pub, sub] = FakeRedis.instances;
      sub.status = 'reconnecting';
      hub.destroy();
      expect(pub.quits).toBe(1);
      expect(pub.disconnects).toBe(0);
      expect(sub.quits).toBe(0);
      expect(sub.disconnects).toBe(1);
    });
  });
});
