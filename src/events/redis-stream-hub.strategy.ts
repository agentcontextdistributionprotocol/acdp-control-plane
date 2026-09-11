import { Logger } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { AcdpStreamEvent } from '../contracts/acdp';
import { StreamHubStrategy } from './stream-hub.interface';
import type { Redis as RedisClient } from 'ioredis';

interface RedisEnvelope {
  scope: 'run' | 'global';
  runId?: string;
  /** Partitions both run and global feeds by tenant. */
  tenantId: string;
  event: AcdpStreamEvent;
}

/**
 * Redis pub/sub StreamHub strategy for horizontal scaling. Publishes to a
 * shared channel and re-emits inbound messages on local Subjects so that any
 * subscriber on any instance receives the event.
 *
 * Requires `ioredis` as an optional peer dependency.
 */
export class RedisStreamHubStrategy implements StreamHubStrategy {
  private readonly logger = new Logger(RedisStreamHubStrategy.name);
  private readonly localSubject = new Subject<RedisEnvelope>();
  // Typed against ioredis's real types rather than a hand-written duck type.
  // `import type` is erased at runtime, so this adds no runtime coupling — and
  // it caught a latent lie: the old duck type declared subscribe's callback as
  // `(err: Error | null)`, but ioredis's `Callback<T>` also admits `undefined`.
  // The untyped `require('ioredis')` had been hiding that mismatch.
  private publisher: RedisClient | null = null;
  private subscriber: RedisClient | null = null;
  private readonly channel = 'acdp:stream-hub';

  constructor(redisUrl: string) {
    void this.connect(redisUrl);
  }

  private async connect(redisUrl: string): Promise<void> {
    try {
      // Normalized to the same dynamic-import form `quota.module.ts` uses.
      // ioredis 6 still sets BOTH `module.exports = Redis` and `.default`, so
      // `require('ioredis')` also worked — this is consistency, not a bug fix.
      const { default: Redis } = await import('ioredis');
      this.publisher = new Redis(redisUrl);
      this.subscriber = new Redis(redisUrl);

      // Without an 'error' listener ioredis falls back to printing
      // "[ioredis] Unhandled error event: ..." on raw stderr — bypassing the
      // pino/Nest logger entirely, so a connection failure is invisible to
      // structured log aggregation while SSE fan-out silently stops. (Verified:
      // it does NOT crash the process on either ioredis 5 or 6 — the client
      // guards the EventEmitter default internally.) ioredis 6 makes this more
      // reachable: it sends `HELLO 3` on connect, so a RESP3 handshake failure
      // is a new way to land here.
      // Log on the TRANSITION only. ioredis 6 retries indefinitely with
      // exponential backoff, so logging every attempt floods aggregation at
      // ERROR severity for the whole duration of an outage (measured: 14 lines
      // in 4s against a dead port). One line per healthy->failed transition,
      // one per recovery, is the signal; the retry storm is noise.
      const failed = new Set<string>();
      const onError =
        (which: string) =>
        (...args: unknown[]): void => {
          if (failed.has(which)) return;
          failed.add(which);
          const err = args[0];
          this.logger.error(
            `Redis ${which} error: ${err instanceof Error ? err.message : String(err)}`,
          );
        };
      const onReady = (which: string) => (): void => {
        if (failed.delete(which)) {
          this.logger.log(`Redis ${which} reconnected`);
        }
      };
      this.publisher!.on('error', onError('publisher'));
      this.subscriber!.on('error', onError('subscriber'));
      this.publisher!.on('ready', onReady('publisher'));
      this.subscriber!.on('ready', onReady('subscriber'));

      // `err` admits undefined in ioredis's Callback<T> — the old duck type
      // declared `Error | null` only, which the untyped require() concealed.
      void this.subscriber!.subscribe(this.channel, (err?: Error | null) => {
        if (err) {
          this.logger.error(`Failed to subscribe to Redis channel: ${err.message}`);
        } else {
          this.logger.log('Connected to Redis stream hub');
        }
      });

      this.subscriber!.on('message', (_channel: unknown, message: unknown) => {
        try {
          const parsed = JSON.parse(message as string) as RedisEnvelope;
          this.localSubject.next(parsed);
        } catch (err) {
          this.logger.warn(
            `Failed to parse Redis message: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    } catch (err) {
      this.logger.error(
        `Failed to connect to Redis: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  publishToRun(runId: string, event: AcdpStreamEvent, tenantId: string): void {
    this.publish({ scope: 'run', runId, tenantId, event });
  }

  publishGlobal(event: AcdpStreamEvent, tenantId: string): void {
    this.publish({ scope: 'global', tenantId, event });
  }

  streamRun(runId: string, tenantId: string): Observable<AcdpStreamEvent> {
    return this.localSubject.asObservable().pipe(
      filter(
        (msg) =>
          msg.scope === 'run' && msg.runId === runId && msg.tenantId === tenantId,
      ),
      map((msg) => msg.event),
    );
  }

  streamGlobal(tenantId: string): Observable<AcdpStreamEvent> {
    return this.localSubject.asObservable().pipe(
      filter((msg) => msg.scope === 'global' && msg.tenantId === tenantId),
      map((msg) => msg.event),
    );
  }

  destroy(): void {
    this.localSubject.complete();
    if (this.publisher) void this.publisher.quit().catch(() => {});
    if (this.subscriber) void this.subscriber.quit().catch(() => {});
  }

  private publish(envelope: RedisEnvelope): void {
    if (this.publisher) {
      this.publisher.publish(this.channel, JSON.stringify(envelope)).catch((err: Error) => {
        this.logger.warn(`Failed to publish to Redis: ${err.message}`);
      });
    }
    // Do NOT also emit locally: the subscriber connection receives every
    // message published to the channel — including this instance's own — and
    // re-emits it on `localSubject` (see the `message` handler). Emitting here
    // too would deliver every event to same-instance SSE subscribers twice.
  }
}
