import { DynamicModule, Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { AuthGuard } from './auth.guard';
import { AuthController } from './auth.controller';
import { AuthSweeperService } from './auth-sweeper.service';
import {
  CHALLENGE_REPOSITORY,
  ChallengeRepository,
} from './challenge-repository';
import { ChallengeStore } from './challenge-store.service';
import { ConfigModule } from '../config/config.module';
import { CrossIssuerValidator } from './cross-issuer-validator.service';
import { DatabaseService } from '../db/database.service';
import { DidWebResolverService } from './did-web/did-web-resolver.service';
import { InMemoryChallengeRepository } from './in-memory-challenge.repository';
import { InMemoryRevocationRepository } from './in-memory-revocation.repository';
import { IntrospectController } from './introspect.controller';
import { IssuanceLedgerService } from './issuance-ledger.service';
import { JwksController } from './jwks.controller';
// PinnedKeysService is registered globally by AppModule (it's @Global()).
// Don't add it to AuthModule's providers — would shadow the global one.
import { PostgresChallengeRepository } from './postgres-challenge.repository';
import { PostgresRevocationRepository } from './postgres-revocation.repository';
import {
  REVOCATION_REPOSITORY,
  RevocationRepository,
} from './revocation-repository';
import { RevocationFeedController } from './revocation-feed.controller';
import { RevocationPollerService } from './revocation-poller.service';
import { RevokeController } from './revoke.controller';
import { SigningMaterialService } from './signing-material.service';
import { TokenIssuer } from './token-issuer.service';
import {
  parseTrustedIssuers,
  TrustedIssuerRegistry,
} from './trusted-issuers';

/**
 * Auth module — bearer-token guard (always on) + optional Phase-5 IdP.
 *
 * When `TOKEN_ISSUANCE_ENABLED=true` the IdP pieces are registered:
 *   - `ChallengeStore` (delegates to repo)
 *   - `TokenIssuer` (challenge → JWT, plus revocation check on verify,
 *     plus #12 issuance-ledger audit hooks)
 *   - `PinnedKeysService` (static directory; V2 plugs in did:web)
 *   - `RevokeController` (RFC 7009-style revocation endpoint)
 *   - `AuthSweeperService` (background eviction of expired rows)
 *   - `IssuanceLedgerService` (#12 append-only audit chain)
 *
 * Persistence backend (`memory` vs `postgres`) is chosen by
 * `AUTH_PERSISTENCE`. Multi-instance deployments MUST use `postgres`.
 */
@Module({
  imports: [ConfigModule],
  controllers: [],
  providers: [AuthGuard],
  exports: [AuthGuard],
})
export class AuthModule {
  static forRoot(): DynamicModule {
    const issuanceEnabled = readBool(process.env.TOKEN_ISSUANCE_ENABLED);

    if (!issuanceEnabled) {
      return {
        module: AuthModule,
        imports: [ConfigModule],
        controllers: [],
        providers: [AuthGuard],
        exports: [AuthGuard],
      };
    }

    const challengeRepoProvider = {
      provide: CHALLENGE_REPOSITORY,
      useFactory: (
        config: AppConfigService,
        db: DatabaseService,
      ): ChallengeRepository =>
        config.authPersistence === 'postgres'
          ? new PostgresChallengeRepository(db)
          : new InMemoryChallengeRepository(),
      inject: [AppConfigService, DatabaseService],
    };

    const revocationRepoProvider = {
      provide: REVOCATION_REPOSITORY,
      useFactory: (
        config: AppConfigService,
        db: DatabaseService,
      ): RevocationRepository =>
        config.authPersistence === 'postgres'
          ? new PostgresRevocationRepository(db)
          : new InMemoryRevocationRepository(),
      inject: [AppConfigService, DatabaseService],
    };

    // The trusted-issuer registry is built once at module init from
    // TRUSTED_ISSUERS. Registry is always present (empty when no
    // peers configured) so CrossIssuerValidator's dispatch can fall
    // through cleanly to the "iss matches self" path.
    const trustedRegistryProvider = {
      provide: TrustedIssuerRegistry,
      useFactory: (config: AppConfigService) =>
        new TrustedIssuerRegistry(parseTrustedIssuers(config.trustedIssuersRaw)),
      inject: [AppConfigService],
    };

    return {
      module: AuthModule,
      imports: [ConfigModule],
      controllers: [
        AuthController,
        RevokeController,
        IntrospectController,
        JwksController,
        RevocationFeedController,
      ],
      providers: [
        AuthGuard,
        challengeRepoProvider,
        revocationRepoProvider,
        trustedRegistryProvider,
        ChallengeStore,
        // PinnedKeysService: provided globally by AppModule (@Global()).
        DidWebResolverService,
        SigningMaterialService,
        TokenIssuer,
        IssuanceLedgerService,
        AuthSweeperService,
        CrossIssuerValidator,
        RevocationPollerService,
      ],
      exports: [
        AuthGuard,
        SigningMaterialService,
        TokenIssuer,
        IssuanceLedgerService,
        CrossIssuerValidator,
        TrustedIssuerRegistry,
        CHALLENGE_REPOSITORY,
        REVOCATION_REPOSITORY,
      ],
    };
  }
}

function readBool(raw: string | undefined): boolean {
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}
