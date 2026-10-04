import { MessageEvent } from '@nestjs/common';
import { firstValueFrom, Observable, Subject, toArray } from 'rxjs';
import { AcdpStreamEvent } from '../contracts/acdp';
import { RunsController } from '../runs/runs.controller';
import { DrainState } from '../shutdown-drain';
import {
  createSseStream,
  shutdownMessage,
  SSE_SHUTDOWN_RETRY_MS,
  SseStreamMetrics,
} from './sse-drain';
import { EventsController } from './events.controller';

function metricsMock() {
  let active = 0;
  const metrics = {
    activeSseConnections: {
      inc: jest.fn(() => void active++),
      dec: jest.fn(() => void active--),
    },
    sseStreamsTerminatedTotal: { inc: jest.fn() },
  } satisfies SseStreamMetrics;
  return { metrics, active: () => active };
}

function hubEvent(type = 'context_published'): AcdpStreamEvent {
  return {
    type,
    ts: '2026-10-04T00:00:00.000Z',
    agentId: 'did:web:a.example',
    registryAuthority: 'r.example',
    derivedFrom: [],
  };
}

const SHUTDOWN: MessageEvent = {
  type: 'shutdown',
  data: { reason: 'server_shutdown' },
  retry: SSE_SHUTDOWN_RETRY_MS,
};

describe('DrainState', () => {
  it('starts serving, begins once, and replays drained$ to late subscribers', async () => {
    const drain = new DrainState();
    expect(drain.isDraining()).toBe(false);

    const early = jest.fn();
    drain.drained$.subscribe(early);
    drain.begin();
    drain.begin(); // idempotent

    expect(drain.isDraining()).toBe(true);
    expect(early).toHaveBeenCalledTimes(1);
    // A subscriber that arrives AFTER begin() still hears it.
    await expect(firstValueFrom(drain.drained$)).resolves.toBeUndefined();
  });
});

describe('createSseStream (issue #192)', () => {
  afterEach(() => jest.useRealTimers());

  it('relays hub events, then ends with the shutdown event and completes when the drain begins', () => {
    const drain = new DrainState();
    const hub = new Subject<AcdpStreamEvent>();
    const seen: MessageEvent[] = [];
    let completed = false;

    createSseStream({ source: () => hub, drain, heartbeatMs: 60_000 }).subscribe({
      next: (m) => seen.push(m),
      complete: () => (completed = true),
    });
    hub.next(hubEvent());
    drain.begin();
    // Anything the hub emits after the terminal event must not leak through.
    hub.next(hubEvent('late'));

    expect(seen).toEqual([
      { type: 'context_published', data: hubEvent() },
      SHUTDOWN,
    ]);
    expect(completed).toBe(true);
    expect(hub.observed).toBe(false); // hub subscription released
  });

  it('a subscribe AFTER the drain began gets the shutdown event immediately, without touching the hub', async () => {
    const drain = new DrainState();
    drain.begin();
    const source = jest.fn(() => new Subject<AcdpStreamEvent>());

    const all = await firstValueFrom(
      createSseStream({ source, drain, heartbeatMs: 60_000 }).pipe(toArray()),
    );

    expect(all).toEqual([SHUTDOWN]);
    // Round 2 #1: the memory strategy would lazily create a fresh, never-completed
    // Subject here and hold the close open until the deadline.
    expect(source).not.toHaveBeenCalled();
  });

  it('an already-COMPLETED hub source (Redis after teardown) still yields the shutdown event when draining', async () => {
    const drain = new DrainState();
    const completedHub = new Subject<AcdpStreamEvent>();
    completedHub.complete();
    drain.begin();

    const all = await firstValueFrom(
      createSseStream({ source: () => completedHub, drain, heartbeatMs: 60_000 }).pipe(
        toArray(),
      ),
    );

    // The completed source is never subscribed (the drain short-circuits first), so
    // the stream carries exactly the shutdown event.
    expect(all).toEqual([SHUTDOWN]);
  });

  it('subscribes to drained$ BEFORE the hub, so the drain wins a same-tick race', () => {
    const order: string[] = [];
    const drain = new DrainState();
    const realDrained = drain.drained$;
    const drainStub = {
      isDraining: () => false,
      get drained$() {
        order.push('drained$');
        return realDrained;
      },
    };
    const source = () => {
      order.push('hub');
      return new Subject<AcdpStreamEvent>();
    };

    createSseStream({ source, drain: drainStub, heartbeatMs: 60_000 }).subscribe();

    expect(order).toEqual(['drained$', 'hub']);
  });

  it('does not open the hub if the drain lands between the check and the drained$ subscription', () => {
    const drain = new DrainState();
    const lateDrain = {
      isDraining: () => false, // stale read…
      get drained$() {
        drain.begin(); // …the drain begins right here
        return drain.drained$;
      },
    };
    const source = jest.fn(() => new Subject<AcdpStreamEvent>());
    const seen: MessageEvent[] = [];

    createSseStream({ source, drain: lateDrain, heartbeatMs: 60_000 }).subscribe((m) =>
      seen.push(m),
    );

    expect(seen).toEqual([SHUTDOWN]);
    expect(source).not.toHaveBeenCalled();
  });

  it('keeps the hub completion as the backstop: a plain completion, no shutdown event', () => {
    const drain = new DrainState();
    const hub = new Subject<AcdpStreamEvent>();
    const seen: MessageEvent[] = [];
    let completed = false;

    createSseStream({ source: () => hub, drain, heartbeatMs: 60_000 }).subscribe({
      next: (m) => seen.push(m),
      complete: () => (completed = true),
    });
    hub.complete();

    expect(completed).toBe(true);
    expect(seen).toEqual([]);
  });

  it('emits heartbeats and clears the heartbeat timer on termination', () => {
    jest.useFakeTimers();
    const drain = new DrainState();
    const seen: MessageEvent[] = [];

    createSseStream({
      source: () => new Subject<AcdpStreamEvent>(),
      drain,
      heartbeatMs: 1000,
    }).subscribe((m) => seen.push(m));

    jest.advanceTimersByTime(2000);
    expect(seen.filter((m) => m.type === 'heartbeat')).toHaveLength(2);
    expect(jest.getTimerCount()).toBe(1);

    drain.begin();

    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    expect(seen.filter((m) => m.type === 'heartbeat')).toHaveLength(2);
    expect(seen[seen.length - 1]).toEqual(SHUTDOWN);
  });

  it('clears the heartbeat when the client disconnects', () => {
    jest.useFakeTimers();
    const hub = new Subject<AcdpStreamEvent>();
    const sub = createSseStream({
      source: () => hub,
      drain: new DrainState(),
      heartbeatMs: 1000,
    }).subscribe();

    sub.unsubscribe();

    expect(jest.getTimerCount()).toBe(0);
    expect(hub.observed).toBe(false);
  });

  it('drives the active_sse_connections gauge and counts shutdown terminations', () => {
    const { metrics, active } = metricsMock();
    const drain = new DrainState();
    const make = () =>
      createSseStream({
        source: () => new Subject<AcdpStreamEvent>(),
        drain,
        heartbeatMs: 60_000,
        metrics,
      });

    const a = make().subscribe();
    make().subscribe();
    expect(active()).toBe(2);

    a.unsubscribe(); // a client disconnect is not a shutdown termination
    expect(active()).toBe(1);
    expect(metrics.sseStreamsTerminatedTotal.inc).not.toHaveBeenCalled();

    drain.begin();
    expect(active()).toBe(0);
    expect(metrics.sseStreamsTerminatedTotal.inc).toHaveBeenCalledTimes(1);
    expect(metrics.sseStreamsTerminatedTotal.inc).toHaveBeenCalledWith({ reason: 'shutdown' });

    // Subscribe-after-drain: inc, terminate, dec — net zero, counted once.
    make().subscribe();
    expect(active()).toBe(0);
    expect(metrics.activeSseConnections.inc).toHaveBeenCalledTimes(3);
    expect(metrics.activeSseConnections.dec).toHaveBeenCalledTimes(3);
    expect(metrics.sseStreamsTerminatedTotal.inc).toHaveBeenCalledTimes(2);
  });

  it('propagates a hub error unchanged (and releases the heartbeat)', () => {
    jest.useFakeTimers();
    const hub = new Subject<AcdpStreamEvent>();
    const onError = jest.fn();

    createSseStream({ source: () => hub, drain: new DrainState(), heartbeatMs: 1000 }).subscribe({
      error: onError,
    });
    const boom = new Error('hub failed');
    hub.error(boom);

    expect(onError).toHaveBeenCalledWith(boom);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('shutdownMessage carries the retry hint', () => {
    expect(shutdownMessage(2500)).toEqual({ ...SHUTDOWN, retry: 2500 });
  });
});

describe('SSE controllers use the drain-aware stream (issue #192)', () => {
  const config = { streamSseHeartbeatMs: 60_000 };
  const req = { tenantId: 'default' } as never;

  it('the run stream skips its run/tenant DB lookup when draining', async () => {
    const drain = new DrainState();
    drain.begin();
    const runsService = {
      existsForOtherTenant: jest.fn(async () => {
        throw new Error('pool ended'); // what a post-pool.end() lookup does
      }),
    };
    const streamHub = { streamRun: jest.fn() };
    const controller = new RunsController(
      runsService as never,
      {} as never,
      {} as never,
      {} as never,
      streamHub as never,
      config as never,
      drain,
      metricsMock().metrics as never,
    );

    const stream: Observable<MessageEvent> = await controller.streamRunEvents('r1', req);
    const all = await firstValueFrom(stream.pipe(toArray()));

    expect(all).toEqual([SHUTDOWN]);
    expect(runsService.existsForOtherTenant).not.toHaveBeenCalled();
    expect(streamHub.streamRun).not.toHaveBeenCalled();
  });

  it('the run stream still does the tenant check when serving', async () => {
    const drain = new DrainState();
    const hub = new Subject<AcdpStreamEvent>();
    const runsService = { existsForOtherTenant: jest.fn(async () => false) };
    const streamHub = { streamRun: jest.fn(() => hub) };
    const controller = new RunsController(
      runsService as never,
      {} as never,
      {} as never,
      {} as never,
      streamHub as never,
      config as never,
      drain,
      metricsMock().metrics as never,
    );

    const stream = await controller.streamRunEvents('r1', req);
    const seen: MessageEvent[] = [];
    stream.subscribe((m) => seen.push(m));
    drain.begin();

    expect(runsService.existsForOtherTenant).toHaveBeenCalledWith('r1', 'default');
    expect(streamHub.streamRun).toHaveBeenCalledWith('r1', 'default');
    expect(seen).toEqual([SHUTDOWN]);
  });

  it('the global stream terminates on drain', () => {
    const drain = new DrainState();
    const hub = new Subject<AcdpStreamEvent>();
    const controller = new EventsController(
      {} as never,
      { streamGlobal: jest.fn(() => hub) } as never,
      config as never,
      drain,
      metricsMock().metrics as never,
    );
    const seen: MessageEvent[] = [];
    let completed = false;

    controller.streamGlobal(req).subscribe({
      next: (m) => seen.push(m),
      complete: () => (completed = true),
    });
    drain.begin();

    expect(seen).toEqual([SHUTDOWN]);
    expect(completed).toBe(true);
  });
});
