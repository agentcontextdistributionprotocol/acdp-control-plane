/**
 * Periodic sweeper for both the challenge and revocation stores.
 *
 * For Postgres-backed deployments this trims the working set so
 * `auth_challenges` and `revoked_tokens` don't grow unboundedly. For
 * in-memory deployments the per-call lazy eviction is usually
 * sufficient, but running the sweeper keeps the size counters
 * accurate for the `/health` and Prometheus paths.
 *
 * Interval is configurable via `AUTH_SWEEP_INTERVAL_SECONDS` (default
 * 300s). Runs on a `setInterval` driven by the Nest lifecycle so
 * `onModuleDestroy` cleanly stops it.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import {
  CHALLENGE_REPOSITORY,
  ChallengeRepository,
} from './challenge-repository';
import {
  REVOCATION_REPOSITORY,
  RevocationRepository,
} from './revocation-repository';

@Injectable()
export class AuthSweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthSweeperService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfigService,
    @Inject(CHALLENGE_REPOSITORY)
    private readonly challenges: ChallengeRepository,
    @Inject(REVOCATION_REPOSITORY)
    private readonly revocations: RevocationRepository,
  ) {}

  onModuleInit(): void {
    const ms = this.config.authSweepIntervalSeconds * 1000;
    if (ms <= 0) {
      this.logger.warn('auth sweeper disabled (AUTH_SWEEP_INTERVAL_SECONDS<=0)');
      return;
    }
    this.timer = setInterval(() => {
      void this.sweepOnce();
    }, ms);
    // Don't keep the process alive just to sweep.
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.log({ msg: 'auth sweeper started', intervalMs: ms });
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One sweep — exposed for tests so they can avoid setInterval. */
  async sweepOnce(): Promise<{ challenges: number; revocations: number }> {
    const [challenges, revocations] = await Promise.all([
      this.safeEvict('challenges', () => this.challenges.evictExpired()),
      this.safeEvict('revocations', () => this.revocations.evictExpired()),
    ]);
    if (challenges > 0 || revocations > 0) {
      this.logger.debug({ msg: 'swept auth state', challenges, revocations });
    }
    return { challenges, revocations };
  }

  private async safeEvict(label: string, fn: () => Promise<number>): Promise<number> {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn({ msg: 'auth sweep failed', label, error: msg });
      return 0;
    }
  }
}
