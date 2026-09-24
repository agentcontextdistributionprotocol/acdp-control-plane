import { createTestApp, TestAppContext } from '../helpers/test-app';
import { FINANCE_PACK } from '../../src/domain-packs/finance.pack';

const SECRET = 'integration-test-secret';

function financeEvent(contextType: string, ctxIdSuffix: string) {
  return {
    type: 'context_published',
    ctx_id: `acdp://registry-finance.example/${ctxIdSuffix}`,
    lineage_id: `lineage-${ctxIdSuffix}`,
    agent_id: 'did:web:finance-agent.example',
    context_type: contextType,
    visibility: 'restricted',
    version: 1,
    derived_from: [],
    registry_authority: 'registry-finance.example',
    created_at: new Date().toISOString(),
  };
}

describe('Domain packs (integration, DOMAIN_PACKS=finance)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp({ webhookSecret: SECRET, domainPacks: 'finance' });
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('GET /domain-packs lists the active pack with its context types', async () => {
    const body = (await ctx.client.requestJson('GET', '/domain-packs')) as {
      packs: Array<{
        id: string;
        version: string;
        label: string;
        contextTypes: Array<{ contextType: string; defaultVisibility: string }>;
      }>;
    };
    expect(body.packs).toHaveLength(1);
    expect(body.packs[0]!.id).toBe('finance');
    expect(body.packs[0]!.version).toBe(FINANCE_PACK.version);
    const types = body.packs[0]!.contextTypes.map((c) => c.contextType).sort();
    expect(types).toEqual(['analyst_note', 'earnings_report']);
  });

  it('accepts ingest events whose context_type is declared by the pack', async () => {
    const res = await ctx.client.ingest(
      financeEvent('earnings_report', 'er-1'),
      { secret: SECRET },
    );
    expect(res.status).toBe(204);
  });

  it('rejects ingest events with a context_type not declared by any active pack', async () => {
    const res = await ctx.client.ingest(financeEvent('task', 'wrong-1'), {
      secret: SECRET,
    });
    expect(res.status).toBe(400);
    const body = res.body as { message?: string };
    expect(String(body.message ?? '')).toMatch(/not declared by any active domain pack/);
  });

  it('lets through events that omit context_type entirely (gate only fires when set)', async () => {
    const event = financeEvent('earnings_report', 'noct-1');
    delete (event as Record<string, unknown>).context_type;
    const res = await ctx.client.ingest(event, { secret: SECRET });
    expect(res.status).toBe(204);
  });

  it('RFC-ACDP-0014: accepts key-revocation even though the active pack does not declare it (Phase 10)', async () => {
    const before = (await ctx.client.listEvents()) as { data: unknown[] };
    const res = await ctx.client.ingest(financeEvent('key-revocation', 'rev-1'), {
      secret: SECRET,
    });
    expect(res.status).toBe(204);
    const after = (await ctx.client.listEvents()) as { data: unknown[] };
    expect(after.data.length).toBe(before.data.length + 1);
  });

  it('RFC-ACDP-0014: accepts the interim spelling acdp:key-revocation (Phase 10)', async () => {
    const before = (await ctx.client.listEvents()) as { data: unknown[] };
    const res = await ctx.client.ingest(financeEvent('acdp:key-revocation', 'rev-2'), {
      secret: SECRET,
    });
    expect(res.status).toBe(204);
    const after = (await ctx.client.listEvents()) as { data: unknown[] };
    expect(after.data.length).toBe(before.data.length + 1);
  });
});

describe('Domain packs (integration, DOMAIN_PACKS unset)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp({ webhookSecret: SECRET });
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('GET /domain-packs returns an empty list', async () => {
    const body = (await ctx.client.requestJson('GET', '/domain-packs')) as {
      packs: unknown[];
    };
    expect(body.packs).toEqual([]);
  });

  it('does not gate context_type when no packs are configured (backward compat)', async () => {
    // 'task' would be rejected when finance is active; with no packs it
    // must pass through.
    const res = await ctx.client.ingest(financeEvent('task', 'compat-1'), {
      secret: SECRET,
    });
    expect(res.status).toBe(204);
  });
});
