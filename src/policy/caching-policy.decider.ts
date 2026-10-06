/**
 * Caching wrapper for any `PolicyDecider`.
 *
 * Policies rarely change between consecutive reads — the same
 * `(subject, resource, action)` typically resolves identically for
 * the cache window. Wrapping the static-rules or OPA decider in a
 * short-TTL LRU cache cuts the hot-path cost to a Map lookup.
 *
 * Cache invariants:
 *   - Only `allow` and `deny` results are cached. `indeterminate`
 *     usually flags a coverage gap operators want to see every time;
 *     caching it would mask the alarm.
 *   - Cache key excludes `scopes` order (sorted) so two callers with
 *     scopes `["a","b"]` and `["b","a"]` share the same entry.
 *   - Default TTL is 5s — short enough that revocations / capability
 *     changes propagate quickly, long enough to dedupe bursty reads.
 *   - LRU eviction at `maxEntries` (default 10000) bounds memory.
 */
import { Logger } from '@nestjs/common';
import {
  PolicyDecider,
  PolicyDecision,
  PolicyRequest,
} from './policy-decider';

interface CacheEntry {
  decision: PolicyDecision;
  expiresAt: number;
}

export interface CachingPolicyOptions {
  ttlMs?: number;
  maxEntries?: number;
}

export class CachingPolicyDecider implements PolicyDecider {
  private readonly logger = new Logger(CachingPolicyDecider.name);
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  // Insertion order = LRU-ish. Map preserves insertion order on iteration.
  private readonly cache: Map<string, CacheEntry> = new Map();
  // Per-decision counters for /metrics.
  hits = 0;
  misses = 0;

  constructor(
    private readonly inner: PolicyDecider,
    opts: CachingPolicyOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 5_000;
    this.maxEntries = opts.maxEntries ?? 10_000;
  }

  async decide(req: PolicyRequest): Promise<PolicyDecision> {
    const key = cacheKey(req);
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) {
      this.hits++;
      // Move to the back to keep LRU recency on hit.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.decision;
    }
    this.misses++;
    const decision = await this.inner.decide(req);
    if (decision.kind === 'allow' || decision.kind === 'deny') {
      this.cache.set(key, { decision, expiresAt: now + this.ttlMs });
      while (this.cache.size > this.maxEntries) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
    return decision;
  }

  /** Drop a cached decision (e.g. after a policy update). */
  invalidate(req: PolicyRequest): void {
    this.cache.delete(cacheKey(req));
  }

  /** Drop everything. */
  invalidateAll(): void {
    this.cache.clear();
  }

  /** Live entry count — for metrics / tests. */
  size(): number {
    return this.cache.size;
  }
}

function cacheKey(req: PolicyRequest): string {
  // Stable, semicolon-delimited; sort scopes + audience so equivalent
  // inputs share a key.
  const scopes = [...req.scopes].sort().join(',');
  const audience = req.resourceAudience ? [...req.resourceAudience].sort().join(',') : '';
  return [
    req.subjectDid,
    req.action,
    req.resourceId,
    req.resourceVisibility ?? '',
    audience,
    scopes,
    req.tenantId ?? '',
    // A cached `allow` for a local token must never be served to a federated
    // token with the same DID/tenant/action (an OPA rule may distinguish them).
    req.issuer ?? '',
    req.federated ? '1' : '0',
  ].join(';');
}
