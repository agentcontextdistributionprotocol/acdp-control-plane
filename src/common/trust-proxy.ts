import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { TrustProxySetting } from '../config/app-config.service';

/**
 * Apply the parsed `TRUST_PROXY` (`AppConfigService.trustProxy`) to the
 * Express instance. The ONLY place `trust proxy` is set — `bootstrap()` and
 * the integration harness both call it, so tests boot like production.
 *
 * Off (`undefined`) never touches the setting, leaving Express's default
 * (`false`: `req.ip` is the socket peer) byte-for-byte unchanged.
 *
 * Every `req.ip` reader — ThrottleByUserGuard's tracker, the issuance
 * ledger's `signerIp` — sees the result, because Express's `req.ip` is a lazy
 * getter over the compiled `trust proxy fn`; no consumer parses
 * `X-Forwarded-For` itself.
 */
export function applyTrustProxy(
  app: Pick<NestExpressApplication, 'set'>,
  setting: TrustProxySetting,
  logger: Pick<Logger, 'log'> = new Logger('TrustProxy'),
): void {
  if (setting === undefined) return;
  app.set('trust proxy', setting);
  logger.log({ msg: 'trust proxy enabled', trustProxy: setting });
}
