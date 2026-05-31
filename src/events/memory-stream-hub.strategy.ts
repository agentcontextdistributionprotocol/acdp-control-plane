import { Observable, Subject } from 'rxjs';
import { AcdpStreamEvent } from '../contracts/acdp';
import { StreamHubStrategy } from './stream-hub.interface';

/**
 * In-memory StreamHub strategy using RxJS Subjects. Suitable for
 * single-instance deployments. Per-run subjects are GC'd after a grace period
 * with no subscribers.
 */
export class MemoryStreamHubStrategy implements StreamHubStrategy {
  private readonly runSubjects = new Map<string, Subject<AcdpStreamEvent>>();
  private readonly runSubscriberCounts = new Map<string, number>();
  private readonly runCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** One global feed per tenant — a subscriber only sees its own tenant's events. */
  private readonly globalSubjects = new Map<string, Subject<AcdpStreamEvent>>();

  publishToRun(runId: string, event: AcdpStreamEvent, tenantId: string): void {
    this.getRunSubject(this.runKey(tenantId, runId)).next(event);
  }

  publishGlobal(event: AcdpStreamEvent, tenantId: string): void {
    this.getGlobalSubject(tenantId).next(event);
  }

  streamRun(runId: string, tenantId: string): Observable<AcdpStreamEvent> {
    const key = this.runKey(tenantId, runId);
    const existingTimer = this.runCleanupTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.runCleanupTimers.delete(key);
    }

    const subject = this.getRunSubject(key);
    this.runSubscriberCounts.set(key, (this.runSubscriberCounts.get(key) ?? 0) + 1);

    return new Observable<AcdpStreamEvent>((subscriber) => {
      const subscription = subject.subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
        const count = (this.runSubscriberCounts.get(key) ?? 1) - 1;
        this.runSubscriberCounts.set(key, count);
        if (count <= 0) this.scheduleCleanup(key);
      };
    });
  }

  streamGlobal(tenantId: string): Observable<AcdpStreamEvent> {
    return this.getGlobalSubject(tenantId).asObservable();
  }

  destroy(): void {
    for (const [, timer] of this.runCleanupTimers) clearTimeout(timer);
    for (const [, subject] of this.runSubjects) subject.complete();
    this.runSubjects.clear();
    this.runSubscriberCounts.clear();
    this.runCleanupTimers.clear();
    for (const [, subject] of this.globalSubjects) subject.complete();
    this.globalSubjects.clear();
  }

  /** Run subjects are keyed by tenant so two tenants can't share a runId feed. */
  private runKey(tenantId: string, runId: string): string {
    return `${tenantId}:${runId}`;
  }

  private getRunSubject(key: string): Subject<AcdpStreamEvent> {
    let subject = this.runSubjects.get(key);
    if (!subject) {
      subject = new Subject<AcdpStreamEvent>();
      this.runSubjects.set(key, subject);
    }
    return subject;
  }

  private getGlobalSubject(tenantId: string): Subject<AcdpStreamEvent> {
    let subject = this.globalSubjects.get(tenantId);
    if (!subject) {
      subject = new Subject<AcdpStreamEvent>();
      this.globalSubjects.set(tenantId, subject);
    }
    return subject;
  }

  private scheduleCleanup(key: string): void {
    const existing = this.runCleanupTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.runCleanupTimers.delete(key);
      const count = this.runSubscriberCounts.get(key) ?? 0;
      if (count <= 0) {
        const subject = this.runSubjects.get(key);
        if (subject) {
          subject.complete();
          this.runSubjects.delete(key);
          this.runSubscriberCounts.delete(key);
        }
      }
    }, 60_000);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();

    this.runCleanupTimers.set(key, timer);
  }
}
