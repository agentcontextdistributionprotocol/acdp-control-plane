import { HttpStatus } from '@nestjs/common';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';

/**
 * Gate an admin-only route. `AuthGuard` sets `actorIsAdmin` from
 * `AUTH_ADMIN_API_KEYS`; anything but a literal `true` is refused with
 * `403 ADMIN_REQUIRED` (#182), so a client can tell "needs an admin key"
 * apart from a tenancy or policy 403. Use this for every new admin route
 * rather than a hand-rolled `ForbiddenException`. `message` is the full,
 * client-visible text (kept byte-identical to the pre-#182 messages).
 */
export function assertAdmin(
  req: { actorIsAdmin?: boolean },
  message: string,
): void {
  if (req.actorIsAdmin !== true) {
    throw new AppException(
      ErrorCode.ADMIN_REQUIRED,
      message,
      HttpStatus.FORBIDDEN,
    );
  }
}
