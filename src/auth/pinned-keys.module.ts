import { Global, Module } from '@nestjs/common';

import { PinnedKeysService } from './pinned-keys.service';

/**
 * Global provider for the pinned-key directory.
 *
 * `PinnedKeysService` is consumed across module boundaries — by
 * `CapabilityService` (AgentsModule providers in AppModule) and by
 * `TokenIssuer` (AuthModule.forRoot()). A class-level `@Global()` decorator
 * does NOT make a provider global (it's a module-level decorator), so the
 * service must live in a genuinely `@Global()` module that exports it.
 * Registering it here unconditionally means capability declarations work even
 * when `TOKEN_ISSUANCE_ENABLED=false` (the agent still proves DID ownership
 * before declaring caps).
 */
@Global()
@Module({
  providers: [PinnedKeysService],
  exports: [PinnedKeysService],
})
export class PinnedKeysModule {}
