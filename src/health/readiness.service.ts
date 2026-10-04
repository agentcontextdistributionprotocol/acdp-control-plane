import { Injectable, Logger } from '@nestjs/common';
import type { QueryConfig } from 'pg';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../db/database.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';

/**
 * One dependency's probe outcome. `reason` is a closed enum, never the driver's
 * error text: the verdict reaches an unauthenticated endpoint's body, and a pg
 * error message carries the host, port and user (`connect ECONNREFUSED
 * 10.0.0.5:5432`). The text goes only to the transition log line.
 */
export interface DependencyCheck {
  status: 'up' | 'down';
  /** `error`: the query/connect failed. `timeout`: the probe deadline fired first. */
  reason?: 'error' | 'timeout';
  latencyMs: number;
}

export interface ReadinessVerdict {
  ready: boolean;
  /** `Date.now()` when this verdict was decided. */
  checkedAt: number;
  checks: { database: DependencyCheck };
}

const DEPENDENCY = 'database';

interface InFlightProbe {
  seq: number;
  verdict: Promise<ReadinessVerdict>;
}

/**
 * The one readiness authority for dependency health (issue #210). Drain-agnostic
 * by design: lifecycle ("are we shutting down?") is `DrainState`'s, and the
 * health controller composes the two, drain first.
 *
 * The database check is `SELECT 1` on the SHARED app pool — readiness should
 * answer "can this replica serve DB-backed requests now?", checkout included —
 * bounded twice: pg's `query_timeout` (frees a slot pinned by a dead
 * established socket) and an outer deadline of the same length (covers the
 * checkout wait and a new connect, which `query_timeout` does not).
 *
 * Cost is bounded independently of probe rate, which is what lets the health
 * controller skip throttling:
 *   - **cache**: a verdict younger than `READINESS_CACHE_MS` is returned as is;
 *   - **single-flight**: at most ONE probe query exists at a time. The in-flight
 *     probe is retained until the underlying `pool.query` SETTLES, not until its
 *     deadline: once the deadline has answered `timeout`, later evaluations —
 *     within or after the TTL — reuse that failure instead of issuing a second
 *     query, so probes never hold more than one pool client. The stuck query is
 *     released by its own `query_timeout` or by the pool's
 *     `connectionTimeoutMillis`, which is why `DB_POOL_CONNECTION_TIMEOUT` must
 *     be > 0 (validated at boot, D10).
 *
 * `evaluate()` never rejects.
 */
@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);
  private last: ReadinessVerdict | undefined;
  /** Sequence number of the probe that produced `last`. */
  private lastSeq = 0;
  /** Monotonic probe counter. */
  private seq = 0;
  private inFlight: InFlightProbe | undefined;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfigService,
    private readonly instrumentation: InstrumentationService,
  ) {}

  /** The last verdict, without awaiting anything (undefined before the first probe). */
  snapshot(): ReadinessVerdict | undefined {
    return this.last;
  }

  /**
   * A cached verdict younger than `READINESS_CACHE_MS`; else the in-flight probe
   * (whose verdict may already be a `timeout`); else a fresh probe.
   */
  evaluate(): Promise<ReadinessVerdict> {
    const cached = this.last;
    if (cached && Date.now() - cached.checkedAt < this.config.readinessCacheMs) {
      return Promise.resolve(cached);
    }
    if (this.inFlight) return this.inFlight.verdict;
    return this.probe();
  }

  private probe(): Promise<ReadinessVerdict> {
    const seq = ++this.seq;
    const timeoutMs = this.config.readinessDbTimeoutMs;
    const startedAt = Date.now();
    let decided = false;
    let resolveVerdict!: (v: ReadinessVerdict) => void;
    const verdict = new Promise<ReadinessVerdict>((resolve) => {
      resolveVerdict = resolve;
    });

    // The first of {deadline, query settle} decides the verdict; the other is
    // then a no-op (or, for a LATE success, an early recovery — see below).
    const decide = (check: DependencyCheck, error?: string): boolean => {
      if (decided) return false;
      decided = true;
      clearTimeout(timer);
      this.instrumentation.readinessChecksTotal.inc({
        dependency: DEPENDENCY,
        result: check.status === 'up' ? 'ok' : (check.reason ?? 'error'),
      });
      resolveVerdict(this.record(seq, check, error));
      return true;
    };

    // Resolves a sentinel, never rejects: this is a request path (CI rule 1).
    const timer = setTimeout(
      () => decide({ status: 'down', reason: 'timeout', latencyMs: Date.now() - startedAt }),
      timeoutMs,
    );
    timer.unref?.();

    // pg honours a per-query `query_timeout` (`pg/lib/client.js`, read off the
    // query config before the connection-level default) but @types/pg's
    // QueryConfig omits it, hence the widened type.
    const probeQuery: QueryConfig & { query_timeout: number } = {
      text: 'SELECT 1',
      query_timeout: timeoutMs,
    };

    this.inFlight = { seq, verdict };
    // `Promise.resolve().then` so a synchronous throw from the driver becomes
    // a rejection like any other.
    void Promise.resolve()
      .then(() => this.database.pool.query(probeQuery))
      .then(
        () => {
          const check: DependencyCheck = { status: 'up', latencyMs: Date.now() - startedAt };
          // A query that answers after its deadline proves the DB is back: let
          // it refresh the cache (recovery seen early). It was already counted
          // as `timeout`, so it moves only the gauge, never the counter.
          if (!decide(check)) this.record(seq, check);
        },
        (err: unknown) => {
          decide(
            { status: 'down', reason: 'error', latencyMs: Date.now() - startedAt },
            err instanceof Error ? err.message : String(err),
          );
          // A late FAILURE after a timeout verdict changes nothing: it is the
          // same "down", and its error text would only re-label the reason.
        },
      )
      .finally(() => {
        if (this.inFlight?.seq === seq) this.inFlight = undefined;
      })
      // Never an unhandled rejection from the detached chain (e.g. a throwing logger).
      .catch(() => undefined);

    return verdict;
  }

  /**
   * Store a verdict unless a NEWER probe's verdict is already cached (a
   * monotonic sequence check; with single-flight a newer verdict cannot exist
   * while this probe is pending, so this is defensive). Moves the gauge and
   * logs a transition — once per `ready` flip — either way it is stored.
   */
  private record(seq: number, check: DependencyCheck, error?: string): ReadinessVerdict {
    const v: ReadinessVerdict = {
      ready: check.status === 'up',
      checkedAt: Date.now(),
      checks: { database: check },
    };
    if (seq < this.lastSeq) return v;
    // Before any probe, assume ready: migrations proved connectivity at boot,
    // so a first `up` verdict is not a transition and logs nothing.
    const wasReady = this.last?.ready ?? true;
    this.last = v;
    this.lastSeq = seq;
    this.instrumentation.dependencyUp.set({ dependency: DEPENDENCY }, v.ready ? 1 : 0);
    if (v.ready !== wasReady) {
      const fields = {
        msg: 'readiness changed',
        dependency: DEPENDENCY,
        ready: v.ready,
        reason: check.reason,
        latencyMs: check.latencyMs,
        ...(error !== undefined ? { error } : {}),
      };
      if (v.ready) this.logger.log(fields);
      else this.logger.warn(fields);
    }
    return v;
  }
}
