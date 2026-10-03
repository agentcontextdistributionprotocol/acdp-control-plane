 
import { ArgumentsHost, ExecutionContext, HttpException } from '@nestjs/common';
import { ErrorCode } from '../errors/error-codes';
import { GlobalExceptionFilter } from '../errors/exception.filter';
import { Reflector } from '@nestjs/core';
import { POLICY_ACTION_KEY } from './check-policy.decorator';
import {
  PolicyDecider,
  PolicyDecision,
  PolicyDecisions,
} from './policy-decider';
import { PolicyGuard } from './policy.guard';

function ctx(req: any, _action?: string): ExecutionContext {
  const handler = function fakeHandler() {};
  class FakeClass {}
  return {
    getHandler: jest.fn().mockReturnValue(handler),
    getClass: jest.fn().mockReturnValue(FakeClass),
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: jest.fn(),
      getNext: jest.fn(),
    }),
    getArgs: jest.fn(),
    getArgByIndex: jest.fn(),
    switchToRpc: jest.fn(),
    switchToWs: jest.fn(),
    getType: jest.fn(),
  } as unknown as ExecutionContext;
}

function newReflector(action: string | undefined): Reflector {
  const r: any = new Reflector();
  // Pre-stub the metadata lookup so we don't have to wire @SetMetadata.
  jest
    .spyOn(r, 'getAllAndOverride')
    .mockImplementation((...args: unknown[]) =>
      args[0] === POLICY_ACTION_KEY ? action : undefined,
    );
  return r as Reflector;
}

class StubDecider implements PolicyDecider {
  constructor(private readonly result: PolicyDecision) {}
  async decide(): Promise<PolicyDecision> {
    return this.result;
  }
}

describe('PolicyGuard', () => {
  it('passes through handlers without @CheckPolicy()', async () => {
    const g = new PolicyGuard(newReflector(undefined), new StubDecider(PolicyDecisions.deny('audience', 'no')));
    expect(await g.canActivate(ctx({ actorId: 'x' }))).toBe(true);
  });

  it('allow → returns true', async () => {
    const g = new PolicyGuard(newReflector('context.retrieve'), new StubDecider(PolicyDecisions.allow()));
    expect(await g.canActivate(ctx({ actorId: 'did:web:alice' }))).toBe(true);
  });

  async function denial(g: PolicyGuard): Promise<HttpException> {
    try {
      await g.canActivate(ctx({ actorId: 'did:web:alice' }));
    } catch (e) {
      return e as HttpException;
    }
    throw new Error('expected the guard to deny');
  }

  it('deny → 403 POLICY_DENIED, legacy top-level code/reason kept (#182)', async () => {
    const g = new PolicyGuard(
      newReflector('context.retrieve'),
      new StubDecider(PolicyDecisions.deny('audience', 'not in audience')),
    );
    const err = await denial(g);
    // The status, not the class, is the contract (no production code checks it).
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toEqual({
      statusCode: 403,
      errorCode: ErrorCode.POLICY_DENIED,
      message: 'policy denied',
      code: 'audience',
      reason: 'not in audience',
      metadata: { code: 'audience', reason: 'not in audience' },
    });
  });

  it('deny body through GlobalExceptionFilter → error.details carries the legacy code/reason', async () => {
    const g = new PolicyGuard(
      newReflector('context.retrieve'),
      new StubDecider(PolicyDecisions.deny('audience', 'not in audience')),
    );
    const err = await denial(g);
    const res = {
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    new GlobalExceptionFilter().catch(err, {
      switchToHttp: () => ({ getResponse: () => res }),
    } as unknown as ArgumentsHost);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0]).toMatchObject({
      errorCode: ErrorCode.POLICY_DENIED,
      code: 'audience',
      reason: 'not in audience',
      error: {
        code: ErrorCode.POLICY_DENIED,
        message: 'policy denied',
        details: { code: 'audience', reason: 'not in audience' },
      },
    });
  });

  it('indeterminate → also 403 POLICY_DENIED, distinguished by legacy code', async () => {
    const g = new PolicyGuard(
      newReflector('context.retrieve'),
      new StubDecider(PolicyDecisions.indeterminate('no rule')),
    );
    const err = await denial(g);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({
      errorCode: ErrorCode.POLICY_DENIED,
      message: 'policy indeterminate',
      code: 'indeterminate',
      reason: 'no rule',
      metadata: { code: 'indeterminate', reason: 'no rule' },
    });
  });

  it('no decider registered → open-by-default with a warn log', async () => {
    const g = new PolicyGuard(newReflector('context.retrieve'));
    expect(await g.canActivate(ctx({ actorId: 'x' }))).toBe(true);
  });

  it('builds PolicyRequest from actorId / tenantId / params', async () => {
    let observed: any = null;
    const sink: PolicyDecider = {
      async decide(req): Promise<PolicyDecision> {
        observed = req;
        return PolicyDecisions.allow();
      },
    };
    const g = new PolicyGuard(newReflector('capability.declare'), sink);
    await g.canActivate(
      ctx({
        actorId: 'did:web:alice',
        tenantId: 'tenant-A',
        params: { runId: 'r-123' },
      }),
    );
    expect(observed.subjectDid).toBe('did:web:alice');
    expect(observed.tenantId).toBe('tenant-A');
    expect(observed.action).toBe('capability.declare');
    expect(observed.resourceId).toBe('r-123');
  });

  it('joins array params (ctxId from path-to-regexp v6 wildcard)', async () => {
    let observed: any = null;
    const sink: PolicyDecider = {
      async decide(req): Promise<PolicyDecision> {
        observed = req;
        return PolicyDecisions.allow();
      },
    };
    const g = new PolicyGuard(newReflector('context.retrieve'), sink);
    await g.canActivate(
      ctx({
        actorId: 'did:web:alice',
        params: { ctxId: ['acdp:', 'r.local', 'abc'] },
      }),
    );
    expect(observed.resourceId).toBe('acdp:/r.local/abc');
  });
});
