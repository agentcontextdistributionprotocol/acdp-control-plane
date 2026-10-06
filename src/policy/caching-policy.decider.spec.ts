import { CachingPolicyDecider } from './caching-policy.decider';
import {
  PolicyDecider,
  PolicyDecision,
  PolicyDecisions,
  PolicyRequest,
} from './policy-decider';

function req(over: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    subjectDid: 'did:web:alice',
    action: 'context.retrieve',
    resourceId: 'acdp://r/1',
    scopes: [],
    ...over,
  };
}

class CountingDecider implements PolicyDecider {
  calls = 0;
  constructor(private readonly result: PolicyDecision) {}
  async decide(): Promise<PolicyDecision> {
    this.calls++;
    return this.result;
  }
}

describe('CachingPolicyDecider', () => {
  it('caches allow decisions across calls with the same key', async () => {
    const inner = new CountingDecider(PolicyDecisions.allow());
    const c = new CachingPolicyDecider(inner);
    await c.decide(req());
    await c.decide(req());
    expect(inner.calls).toBe(1);
    expect(c.hits).toBe(1);
    expect(c.misses).toBe(1);
  });

  it('keys on issuer and on the federated flag (a local allow is never served to a federated token)', async () => {
    const inner = new CountingDecider(PolicyDecisions.allow());
    const c = new CachingPolicyDecider(inner);
    await c.decide(req({ issuer: 'cp.local', federated: false }));
    await c.decide(req({ issuer: 'cp.local', federated: false })); // hit
    expect(inner.calls).toBe(1);
    await c.decide(req({ issuer: 'peer', federated: false })); // issuer differs only
    expect(inner.calls).toBe(2);
    await c.decide(req({ issuer: 'cp.local', federated: true })); // federated differs only
    expect(inner.calls).toBe(3);
    await c.decide(req({ issuer: 'peer', federated: false })); // hit again
    expect(inner.calls).toBe(3);
  });

  it('caches deny decisions too', async () => {
    const inner = new CountingDecider(PolicyDecisions.deny('audience', 'r'));
    const c = new CachingPolicyDecider(inner);
    await c.decide(req());
    await c.decide(req());
    expect(inner.calls).toBe(1);
  });

  it('does NOT cache indeterminate decisions (coverage-gap signal)', async () => {
    const inner = new CountingDecider(PolicyDecisions.indeterminate('no rule'));
    const c = new CachingPolicyDecider(inner);
    await c.decide(req());
    await c.decide(req());
    expect(inner.calls).toBe(2);
  });

  it('different keys miss separately', async () => {
    const inner = new CountingDecider(PolicyDecisions.allow());
    const c = new CachingPolicyDecider(inner);
    await c.decide(req({ resourceId: 'A' }));
    await c.decide(req({ resourceId: 'B' }));
    expect(inner.calls).toBe(2);
    expect(c.size()).toBe(2);
  });

  it('scope-order doesn\'t make cache miss', async () => {
    const inner = new CountingDecider(PolicyDecisions.allow());
    const c = new CachingPolicyDecider(inner);
    await c.decide(req({ scopes: ['a', 'b'] }));
    await c.decide(req({ scopes: ['b', 'a'] }));
    expect(inner.calls).toBe(1);
  });

  it('audience-order doesn\'t make cache miss', async () => {
    const inner = new CountingDecider(PolicyDecisions.allow());
    const c = new CachingPolicyDecider(inner);
    await c.decide(req({ resourceAudience: ['did:web:x', 'did:web:y'] }));
    await c.decide(req({ resourceAudience: ['did:web:y', 'did:web:x'] }));
    expect(inner.calls).toBe(1);
  });

  it('expired entries trigger a re-fetch', async () => {
    const inner = new CountingDecider(PolicyDecisions.allow());
    const c = new CachingPolicyDecider(inner, { ttlMs: 1 });
    await c.decide(req());
    await new Promise((r) => setTimeout(r, 10));
    await c.decide(req());
    expect(inner.calls).toBe(2);
  });

  it('invalidate(req) drops a single entry', async () => {
    const inner = new CountingDecider(PolicyDecisions.allow());
    const c = new CachingPolicyDecider(inner);
    await c.decide(req());
    c.invalidate(req());
    await c.decide(req());
    expect(inner.calls).toBe(2);
  });

  it('invalidateAll() drops everything', async () => {
    const inner = new CountingDecider(PolicyDecisions.allow());
    const c = new CachingPolicyDecider(inner);
    await c.decide(req({ resourceId: 'A' }));
    await c.decide(req({ resourceId: 'B' }));
    c.invalidateAll();
    await c.decide(req({ resourceId: 'A' }));
    await c.decide(req({ resourceId: 'B' }));
    expect(inner.calls).toBe(4);
  });

  it('LRU eviction at maxEntries bound', async () => {
    const inner = new CountingDecider(PolicyDecisions.allow());
    const c = new CachingPolicyDecider(inner, { maxEntries: 2 });
    await c.decide(req({ resourceId: 'A' }));
    await c.decide(req({ resourceId: 'B' }));
    await c.decide(req({ resourceId: 'C' })); // evicts A
    expect(c.size()).toBe(2);
    await c.decide(req({ resourceId: 'A' })); // miss again
    expect(inner.calls).toBe(4);
  });
});
