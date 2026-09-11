/**
 * Route-shape coverage for the `/agents` controller.
 *
 * These endpoints depend on Express 5 / path-to-regexp 8 wildcard semantics and
 * had no integration coverage: `federation-proxy` exercises `*ctxId` and
 * `capabilities` exercises `by-agent/*did`, but nothing exercised `/agents/*did`
 * itself. The declared `express` version is being aligned to the 5.2.1 that
 * `@nestjs/platform-express` has in fact been running all along (issue #137), so
 * the point of this spec is to pin the behaviour that alignment must not change.
 *
 * The branch that actually matters is the array join at
 * `src/agents/agents.controller.ts:26`. Under Express 5 a `*name` wildcard param
 * arrives as an ARRAY, always — so a DID with no `/` in it yields a
 * single-element array and never exercises `.join('/')`. Only a DID containing a
 * slash proves the reconstruction works, which is why the multi-segment case
 * below is the load-bearing one rather than a nice-to-have.
 */
import { createTestApp, TestAppContext } from '../helpers/test-app';

const SECRET = 'integration-test-secret';

function publishEvent(agentId: string, ctxSuffix: string) {
  return {
    type: 'context_published',
    ctx_id: `acdp://registry-a.example/${ctxSuffix}`,
    lineage_id: `lineage-${ctxSuffix}`,
    agent_id: agentId,
    context_type: 'task',
    visibility: 'public',
    version: 1,
    derived_from: [],
    registry_authority: 'registry-a.example',
    scenario_id: 'agents-route-shape',
    created_at: new Date().toISOString(),
  };
}

describe('Agents route shapes (integration)', () => {
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

  it('GET /agents lists agents and is not shadowed by the @Get(\'*did\') wildcard', async () => {
    await ctx.client.ingest(publishEvent('did:web:agent-1.example', 'ctx-1'), {
      runId: 'run-agents-list',
      secret: SECRET,
    });

    const res = await ctx.client.requestRaw('GET', '/agents');
    // The bare route must win over `*did`. A wildcard that swallowed this would
    // surface as a 404 ("agent  not found") rather than a list.
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; total: number };
    expect(body.total).toBe(1);
  });

  it('GET /agents/*did reaches the handler for a colon-bearing DID and reconstructs it', async () => {
    const did = 'did:web:agent-1.example';
    await ctx.client.ingest(publishEvent(did, 'ctx-2'), {
      runId: 'run-agents-single',
      secret: SECRET,
    });

    // Single-element wildcard array. Colons are ordinary path characters, so the
    // whole DID must arrive as one segment.
    const res = await ctx.client.requestRaw('GET', `/agents/${did}`);
    expect(res.status).toBe(200);
    const agent = res.body as { agentDid: string };
    expect(agent.agentDid).toBe(did);
  });

  it('GET /agents/*did rejoins a multi-segment DID across slashes', async () => {
    // agent_id is an OPAQUE string everywhere in the control plane, so a DID
    // carrying a path is legitimate traffic. This is the case that exercises
    // `Array.isArray(didParts) ? didParts.join('/')` — the single-segment tests
    // above pass even if the join is broken.
    const did = 'did:web:agent-1.example:8443/path/segments';
    await ctx.client.ingest(publishEvent(did, 'ctx-3'), {
      runId: 'run-agents-multi',
      secret: SECRET,
    });

    // Deliberately NOT percent-encoded: encoding the slashes would collapse this
    // to one segment and silently retarget the test at the case above.
    const res = await ctx.client.requestRaw('GET', `/agents/${did}`);
    expect(res.status).toBe(200);
    const agent = res.body as { agentDid: string };
    // Exact round-trip: every slash survives, none are added or dropped.
    expect(agent.agentDid).toBe(did);
  });

  it('GET /agents/*did 404s from the HANDLER, not from a missing route', async () => {
    const res = await ctx.client.requestRaw('GET', '/agents/did:web:never-seen.example');
    expect(res.status).toBe(404);
    // Asserting the status alone proves nothing here: Nest's no-route fallback is
    // ALSO a 404, so this case survived a mutation that disabled `@Get('*did')`
    // entirely. Only the handler at src/agents/agents.controller.ts:28 produces
    // this message, so matching it is what distinguishes "route matched and the
    // agent is unknown" from "the wildcard stopped matching".
    expect((res.body as { message: string }).message).toBe(
      'agent did:web:never-seen.example not found',
    );
  });
});
