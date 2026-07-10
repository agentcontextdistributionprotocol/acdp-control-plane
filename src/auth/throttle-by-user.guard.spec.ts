import { ExecutionContext } from '@nestjs/common';
import { ThrottleByUserGuard } from './throttle-by-user.guard';

/**
 * The guard's contract is its tracker resolution: rate limits key on the
 * authenticated principal (req.actorId pinned by AuthGuard), falling back
 * to the client IP for @Public() routes, and never returning an unkeyed
 * tracker. Exercised via a test subclass — the methods are protected.
 */
class TestableGuard extends ThrottleByUserGuard {
  trackerOf(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }
  requestResponseOf(context: ExecutionContext) {
    return this.getRequestResponse(context);
  }
}

function makeGuard(): TestableGuard {
  // ThrottlerGuard's own dependencies are unused by the overridden methods.
  return new TestableGuard({} as any, {} as any, {} as any);
}

describe('ThrottleByUserGuard', () => {
  it('keys the rate limit on actorId when the request is authenticated', async () => {
    const guard = makeGuard();
    await expect(
      guard.trackerOf({ actorId: 'did:web:cp.test:agents:alice', ip: '10.0.0.9' }),
    ).resolves.toBe('did:web:cp.test:agents:alice');
  });

  it('falls back to the client IP for unauthenticated (@Public) requests', async () => {
    const guard = makeGuard();
    await expect(guard.trackerOf({ ip: '10.0.0.9' })).resolves.toBe('10.0.0.9');
  });

  it('never returns an empty tracker — anonymous bucket when actorId and ip are absent', async () => {
    const guard = makeGuard();
    await expect(guard.trackerOf({})).resolves.toBe('anonymous');
  });

  it('stringifies a non-string actorId rather than leaking an object tracker', async () => {
    const guard = makeGuard();
    await expect(guard.trackerOf({ actorId: 42 })).resolves.toBe('42');
  });

  it('resolves req/res from the HTTP execution context', () => {
    const guard = makeGuard();
    const req = { id: 'req' };
    const res = { id: 'res' };
    const context = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;

    expect(guard.requestResponseOf(context)).toEqual({ req, res });
  });
});
