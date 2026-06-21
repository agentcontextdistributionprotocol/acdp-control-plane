/**
 * Regression-fence test: confirms that the controllers we audited as
 * needing @CheckPolicy still carry it. A silent removal of the
 * decorator (e.g. during a refactor) would let unauthenticated /
 * cross-tenant traffic past the guard.
 */
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { CapabilityController } from '../agents/capability.controller';
import { ContextsController } from '../contexts/contexts.controller';
import { RunsController } from '../runs/runs.controller';
import { POLICY_ACTION_KEY } from './check-policy.decorator';

function actionOf(target: object): unknown {
  return Reflect.getMetadata(POLICY_ACTION_KEY, target);
}

function isPublic(target: object): boolean {
  return Reflect.getMetadata(IS_PUBLIC_KEY, target) === true;
}

describe('PolicyGuard controller coverage', () => {
  it('CapabilityController.declare → capability.declare', () => {
    expect(actionOf(CapabilityController.prototype.declare)).toBe(
      'capability.declare',
    );
  });

  it('ContextsController.getContext → context.retrieve', () => {
    expect(actionOf(ContextsController.prototype.getContext)).toBe(
      'context.retrieve',
    );
  });

  it('RunsController.listRuns → run.read', () => {
    expect(actionOf(RunsController.prototype.listRuns)).toBe('run.read');
  });

  it('RunsController.getRun → run.read', () => {
    expect(actionOf(RunsController.prototype.getRun)).toBe('run.read');
  });

  it('RunsController.getLineage → run.read', () => {
    expect(actionOf(RunsController.prototype.getLineage)).toBe('run.read');
  });

  it('RunsController.getRunEvents → run.read', () => {
    expect(actionOf(RunsController.prototype.getRunEvents)).toBe('run.read');
  });

  // The run-notify routes are authenticated by the playground's HMAC-SHA256
  // signature (the same scheme as /ingest/acdp), NOT the api-key AuthGuard /
  // PolicyGuard. They are therefore intentionally @Public() and must NOT carry
  // a @CheckPolicy action — the HMAC check inside the handler is the fence.
  it('RunsController.markStarted is @Public (HMAC-authenticated, no policy action)', () => {
    expect(isPublic(RunsController.prototype.markStarted)).toBe(true);
    expect(actionOf(RunsController.prototype.markStarted)).toBeUndefined();
  });

  it('RunsController.markComplete is @Public (HMAC-authenticated, no policy action)', () => {
    expect(isPublic(RunsController.prototype.markComplete)).toBe(true);
    expect(actionOf(RunsController.prototype.markComplete)).toBeUndefined();
  });
});
