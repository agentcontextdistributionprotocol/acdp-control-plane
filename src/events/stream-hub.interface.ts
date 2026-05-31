import { Observable } from 'rxjs';
import { AcdpStreamEvent } from '../contracts/acdp';

export const STREAM_HUB_STRATEGY = 'STREAM_HUB_STRATEGY';

export interface StreamHubStrategy {
  /** Publish to the per-run feed, scoped to `tenantId`. */
  publishToRun(runId: string, event: AcdpStreamEvent, tenantId: string): void;
  /** Broadcast to the global feed for `tenantId`. */
  publishGlobal(event: AcdpStreamEvent, tenantId: string): void;
  /** Subscribe to a run's feed within `tenantId` only. */
  streamRun(runId: string, tenantId: string): Observable<AcdpStreamEvent>;
  /** Subscribe to the global feed for `tenantId` only. */
  streamGlobal(tenantId: string): Observable<AcdpStreamEvent>;
  destroy?(): void;
}
