import { MessageEvent } from '@nestjs/common';
import { Observable, Subscription } from 'rxjs';
import { AcdpStreamEvent, SseShutdownEventData } from '../contracts/acdp';
import type { DrainState } from '../shutdown-drain';

/**
 * The fallback `retry:` hint (ms) carried by the terminal `event: shutdown`
 * (issue #192): how long an EventSource waits before reconnecting — by then, to
 * a live replica. Both SSE controllers pass the `STREAM_SSE_SHUTDOWN_RETRY_MS`
 * knob (`AppConfigService.sseShutdownRetryMs`, same 1000 ms default) as
 * `retryMs`; this constant only applies when a caller omits it.
 */
export const SSE_SHUTDOWN_RETRY_MS = 1000;

/** `type` of the terminal SSE event, and the `reason` it carries. */
export const SSE_SHUTDOWN_EVENT = 'shutdown';
export const SSE_SHUTDOWN_REASON: SseShutdownEventData['reason'] = 'server_shutdown';

/** The metrics the helper drives — structurally satisfied by InstrumentationService. */
export interface SseStreamMetrics {
  activeSseConnections: { inc(): void; dec(): void };
  sseStreamsTerminatedTotal: { inc(labels: { reason: 'shutdown' }): void };
}

export interface SseStreamOptions {
  /** The hub feed. A FACTORY, so a stream opened during the drain never
   *  subscribes to it at all (see {@link createSseStream}). */
  source: () => Observable<AcdpStreamEvent>;
  /** `noteSseTermination` feeds the shutdown summary log's `sseStreamsTerminated`. */
  drain: Pick<DrainState, 'isDraining' | 'drained$'> & Partial<Pick<DrainState, 'noteSseTermination'>>;
  heartbeatMs: number;
  metrics?: SseStreamMetrics;
  /** Defaults to {@link SSE_SHUTDOWN_RETRY_MS}. */
  retryMs?: number;
}

/** The terminal event every SSE stream ends with on a graceful shutdown. */
export function shutdownMessage(retryMs: number = SSE_SHUTDOWN_RETRY_MS): MessageEvent {
  const data: SseShutdownEventData = { reason: SSE_SHUTDOWN_REASON };
  return { type: SSE_SHUTDOWN_EVENT, data, retry: retryMs };
}

/**
 * Build one SSE response stream — shared by `/events/stream` and
 * `/runs/:runId/events/stream` so the two cannot diverge (issue #192).
 *
 * The stream relays the hub feed plus a heartbeat and, when the drain begins,
 * emits `{ type: 'shutdown', data: { reason: 'server_shutdown' }, retry }` and
 * completes. Nest writes each message through `concatMap` → `writeMessage` and
 * ends the response only after the completion follows it, so the event is
 * flushed before the chunked terminator — and the socket, now idle, is then
 * reaped by the shutdown handler instead of lingering for keepAliveTimeout.
 *
 * Ordering is load-bearing (plan Round 2 #1):
 *   - ALREADY draining at subscribe time → emit the terminal event and complete
 *     WITHOUT touching the hub. After the hub's teardown, Redis's `localSubject`
 *     is already completed and the memory strategy would lazily create a fresh,
 *     never-completed Subject that holds the close open until the deadline.
 *   - live → subscribe to `drained$` BEFORE the hub, so a drain that lands while
 *     subscribing is never missed and always wins over a hub completion.
 * The hub's own completion (`strategy.destroy()`) stays as the backstop and ends
 * the stream plainly, as before.
 */
export function createSseStream(opts: SseStreamOptions): Observable<MessageEvent> {
  const { drain, metrics } = opts;
  const retryMs = opts.retryMs ?? SSE_SHUTDOWN_RETRY_MS;

  return new Observable<MessageEvent>((subscriber) => {
    const teardown = new Subscription();
    metrics?.activeSseConnections.inc();
    teardown.add(() => metrics?.activeSseConnections.dec());

    const terminate = (): void => {
      if (subscriber.closed) return;
      metrics?.sseStreamsTerminatedTotal.inc({ reason: 'shutdown' });
      drain.noteSseTermination?.();
      subscriber.next(shutdownMessage(retryMs));
      subscriber.complete();
    };

    if (drain.isDraining()) {
      terminate();
      return teardown;
    }

    teardown.add(drain.drained$.subscribe(() => terminate()));
    // drained$ replays: a drain that began between the check above and that
    // subscription has already terminated the stream — do not open the hub.
    if (subscriber.closed) return teardown;

    teardown.add(
      opts.source().subscribe({
        next: (event) => subscriber.next({ type: event.type, data: event } as MessageEvent),
        error: (err) => subscriber.error(err),
        complete: () => subscriber.complete(),
      }),
    );

    const heartbeat = setInterval(() => {
      subscriber.next({
        type: 'heartbeat',
        data: { ts: new Date().toISOString() },
      } as MessageEvent);
    }, opts.heartbeatMs);
    if (typeof heartbeat === 'object' && 'unref' in heartbeat) heartbeat.unref();
    teardown.add(() => clearInterval(heartbeat));

    return teardown;
  });
}
