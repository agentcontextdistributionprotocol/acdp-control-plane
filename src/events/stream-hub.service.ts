import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AcdpStreamEvent } from '../contracts/acdp';
import { ShutdownFailures } from '../shutdown-failures';
import { STREAM_HUB_STRATEGY, StreamHubStrategy } from './stream-hub.interface';

@Injectable()
export class StreamHubService implements OnModuleDestroy {
  constructor(
    @Inject(STREAM_HUB_STRATEGY) private readonly strategy: StreamHubStrategy,
    @Optional() private readonly shutdownFailures?: ShutdownFailures,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (!('destroy' in this.strategy) || typeof this.strategy.destroy !== 'function') return;
    // Tracked so a throwing strategy teardown fails the exit code (#155). The
    // Redis strategy's own quit() errors are swallowed inside destroy() by
    // design (a dead transport must not block shutdown), so only a synchronous
    // throw reaches here.
    const destroy = () => this.strategy.destroy?.();
    if (this.shutdownFailures) {
      await this.shutdownFailures.track('stream hub', destroy);
    } else {
      destroy();
    }
  }

  publishToRun(runId: string, event: AcdpStreamEvent, tenantId: string): void {
    this.strategy.publishToRun(runId, event, tenantId);
  }

  publishGlobal(event: AcdpStreamEvent, tenantId: string): void {
    this.strategy.publishGlobal(event, tenantId);
  }

  streamRun(runId: string, tenantId: string): Observable<AcdpStreamEvent> {
    return this.strategy.streamRun(runId, tenantId);
  }

  streamGlobal(tenantId: string): Observable<AcdpStreamEvent> {
    return this.strategy.streamGlobal(tenantId);
  }
}
