import { OpaPolicyDecider, interpretOpa } from './opa-policy.decider';
import { PolicyRequest } from './policy-decider';

function req(): PolicyRequest {
  return {
    subjectDid: 'did:web:alice',
    action: 'context.retrieve',
    resourceId: 'acdp://r/1',
    resourceVisibility: 'public',
    resourceAudience: [],
    scopes: [],
    tenantId: 'tenant-a',
  };
}

/** Wrap global fetch so we can mock it per-test. */
function withMockFetch(impl: typeof fetch): () => void {
  const orig = global.fetch;
  global.fetch = impl as typeof fetch;
  return () => {
    global.fetch = orig;
  };
}

describe('interpretOpa (pure)', () => {
  it('allow=true → allow', () => {
    expect(interpretOpa({ result: { allow: true } })).toEqual({ kind: 'allow' });
  });

  it('allow=false → deny with code + reason', () => {
    expect(
      interpretOpa({
        result: { allow: false, deny_code: 'audience', deny_reason: 'not in list' },
      }),
    ).toEqual({ kind: 'deny', code: 'audience', reason: 'not in list' });
  });

  it('allow=false without deny_code → falls back to "visibility"', () => {
    expect(interpretOpa({ result: { allow: false } })).toEqual({
      kind: 'deny',
      code: 'visibility',
      reason: 'opa denied',
    });
  });

  it('unknown deny_code → coerced to "visibility" (no untyped codes leak through)', () => {
    expect(
      interpretOpa({ result: { allow: false, deny_code: 'mystery' as any } }),
    ).toMatchObject({ kind: 'deny', code: 'visibility' });
  });

  it('indeterminate=true → indeterminate', () => {
    expect(
      interpretOpa({ result: { indeterminate: true, note: 'no rule' } }),
    ).toEqual({ kind: 'indeterminate', note: 'no rule' });
  });

  it('missing result → indeterminate', () => {
    expect(interpretOpa({})).toMatchObject({ kind: 'indeterminate' });
  });

  it('result with neither allow nor indeterminate → indeterminate', () => {
    expect(interpretOpa({ result: { deny_reason: 'wat' } })).toMatchObject({
      kind: 'indeterminate',
    });
  });
});

describe('OpaPolicyDecider', () => {
  it('translates PolicyRequest to snake_case input', async () => {
    let observedBody: Record<string, unknown> | null = null;
    const restore = withMockFetch(async (_url, init) => {
      observedBody = JSON.parse((init?.body as string) ?? '{}');
      return new Response(JSON.stringify({ result: { allow: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    try {
      const d = new OpaPolicyDecider({ baseUrl: 'http://opa:8181', packagePath: 'acdp/policy/v1' });
      await d.decide(req());
      const input = (observedBody as any).input;
      expect(input.subject_did).toBe('did:web:alice');
      expect(input.action).toBe('context.retrieve');
      expect(input.resource_visibility).toBe('public');
      expect(input.tenant_id).toBe('tenant-a');
      // Provenance defaults when the request carries none.
      expect(input.issuer).toBe('');
      expect(input.federated).toBe(false);
    } finally {
      restore();
    }
  });

  it('forwards issuer and federated in the OPA input (#225)', async () => {
    let observedBody: Record<string, unknown> | null = null;
    const restore = withMockFetch(async (_url, init) => {
      observedBody = JSON.parse((init?.body as string) ?? '{}');
      return new Response(JSON.stringify({ result: { allow: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    try {
      const d = new OpaPolicyDecider({ baseUrl: 'http://opa:8181', packagePath: 'acdp/policy/v1' });
      await d.decide({ ...req(), issuer: 'registry-a.peer', federated: true });
      const input = (observedBody as any).input;
      expect(input.issuer).toBe('registry-a.peer');
      expect(input.federated).toBe(true);
    } finally {
      restore();
    }
  });

  it('returns allow on a 200 + {allow: true}', async () => {
    const restore = withMockFetch(async () =>
      new Response(JSON.stringify({ result: { allow: true } }), { status: 200 }),
    );
    try {
      const d = new OpaPolicyDecider({ baseUrl: 'http://opa', packagePath: 'acdp/policy/v1' });
      expect(await d.decide(req())).toEqual({ kind: 'allow' });
    } finally {
      restore();
    }
  });

  it('returns deny when OPA returns {allow:false, deny_code, deny_reason}', async () => {
    const restore = withMockFetch(async () =>
      new Response(
        JSON.stringify({
          result: { allow: false, deny_code: 'audience', deny_reason: 'no' },
        }),
        { status: 200 },
      ),
    );
    try {
      const d = new OpaPolicyDecider({ baseUrl: 'http://opa', packagePath: 'acdp/policy/v1' });
      const out = await d.decide(req());
      expect(out).toMatchObject({ kind: 'deny', code: 'audience' });
    } finally {
      restore();
    }
  });

  it('transport error → indeterminate by default', async () => {
    const restore = withMockFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    try {
      const d = new OpaPolicyDecider({ baseUrl: 'http://opa', packagePath: 'acdp/policy/v1' });
      const out = await d.decide(req());
      expect(out).toMatchObject({ kind: 'indeterminate' });
    } finally {
      restore();
    }
  });

  it('transport error → allow when failOpen=true', async () => {
    const restore = withMockFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    try {
      const d = new OpaPolicyDecider({
        baseUrl: 'http://opa',
        packagePath: 'acdp/policy/v1',
        failOpen: true,
      });
      expect(await d.decide(req())).toEqual({ kind: 'allow' });
    } finally {
      restore();
    }
  });

  it('5xx → indeterminate', async () => {
    const restore = withMockFetch(async () => new Response('boom', { status: 500 }));
    try {
      const d = new OpaPolicyDecider({ baseUrl: 'http://opa', packagePath: 'acdp/policy/v1' });
      expect(await d.decide(req())).toMatchObject({ kind: 'indeterminate' });
    } finally {
      restore();
    }
  });

  it('malformed JSON → indeterminate', async () => {
    const restore = withMockFetch(async () => new Response('not json', { status: 200 }));
    try {
      const d = new OpaPolicyDecider({ baseUrl: 'http://opa', packagePath: 'acdp/policy/v1' });
      expect(await d.decide(req())).toMatchObject({ kind: 'indeterminate' });
    } finally {
      restore();
    }
  });

  it('builds the right URL from baseUrl + packagePath + default rule "decision"', async () => {
    let observedUrl = '';
    const restore = withMockFetch(async (url) => {
      observedUrl = String(url);
      return new Response(JSON.stringify({ result: { allow: true } }), { status: 200 });
    });
    try {
      const d = new OpaPolicyDecider({
        baseUrl: 'http://opa:8181/',
        packagePath: 'acdp/policy/v1',
      });
      await d.decide(req());
      expect(observedUrl).toBe('http://opa:8181/v1/data/acdp.policy.v1/decision');
    } finally {
      restore();
    }
  });
});
