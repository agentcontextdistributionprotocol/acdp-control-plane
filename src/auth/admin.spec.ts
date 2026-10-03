import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { assertAdmin } from './admin';

describe('assertAdmin (#182)', () => {
  it('passes when actorIsAdmin === true', () => {
    expect(() => assertAdmin({ actorIsAdmin: true }, 'x is admin-only')).not.toThrow();
  });

  it.each([
    ['false', { actorIsAdmin: false }],
    ['undefined', {}],
    ['a truthy non-boolean', { actorIsAdmin: 'yes' as unknown as boolean }],
  ])('throws 403 ADMIN_REQUIRED with the exact message when actorIsAdmin is %s', (_, req) => {
    let caught: unknown;
    try {
      assertAdmin(req, 'routing stats are admin-only');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppException);
    const ex = caught as AppException;
    expect(ex.getStatus()).toBe(403);
    expect(ex.errorCode).toBe(ErrorCode.ADMIN_REQUIRED);
    expect(ex.message).toBe('routing stats are admin-only');
  });
});
