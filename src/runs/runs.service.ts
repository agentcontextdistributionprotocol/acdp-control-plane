import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { Run } from '../db/schema';
import { BanditRouter } from '../routing/bandit-router.service';
import { ContextEventRepository } from '../storage/context-event.repository';
import { ListRunsOptions, RunRepository } from '../storage/run.repository';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';

@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    private readonly runRepo: RunRepository,
    private readonly config: AppConfigService,
    private readonly contextEventRepo: ContextEventRepository,
    private readonly bandit: BanditRouter,
  ) {}

  async list(opts: ListRunsOptions): Promise<{
    data: Run[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const { data, total } = await this.runRepo.list(opts);
    return { data, total, limit: opts.limit, offset: opts.offset };
  }

  async getOrThrow(runId: string, tenantId: string = DEFAULT_TENANT_ID): Promise<Run> {
    return this.runRepo.findByIdOrThrow(runId, tenantId);
  }

  /** True if `runId` belongs to a tenant other than `tenantId`. */
  async existsForOtherTenant(
    runId: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<boolean> {
    return this.runRepo.existsForOtherTenant(runId, tenantId);
  }

  async markComplete(
    runId: string,
    status: 'completed' | 'failed' | 'cancelled',
    result?: Record<string, unknown>,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<Run> {
    const run = await this.runRepo.markComplete(runId, status, result, tenantId);

    // Feed the bandit router's reward channel (FEAT-CP-06): every agent
    // that produced a context in this run gets a Bernoulli reward keyed by
    // the run's scenario (taskClass). completed → 1.0, failed → 0.0;
    // cancelled is not a quality signal, so we skip it. Best-effort —
    // never let routing bookkeeping break run completion.
    if (status === 'completed' || status === 'failed') {
      void this.recordRouterReward(run, status === 'completed' ? 1 : 0, tenantId);
    }

    // Optionally notify the playground that the run is complete.
    if (this.config.playgroundUrl) {
      void this.notifyPlayground(runId, status, result);
    }

    return run;
  }

  private async recordRouterReward(
    run: Run,
    reward: number,
    tenantId: string,
  ): Promise<void> {
    try {
      const events = await this.contextEventRepo.listByRun(run.runId, tenantId);
      const agentDids = new Set(events.map((e) => e.agentId).filter(Boolean));
      for (const agentDid of agentDids) {
        this.bandit.recordReward(run.scenarioId, agentDid, reward);
      }
    } catch (err) {
      this.logger.warn(
        `bandit reward for run ${run.runId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async notifyPlayground(
    runId: string,
    status: string,
    result?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const url = `${this.config.playgroundUrl.replace(/\/$/, '')}/runs/${runId}/complete`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, result }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        this.logger.warn(
          `playground notify ${runId} returned ${response.status}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `playground notify ${runId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
