/**
 * Global policy module — registers a `PolicyDecider` keyed by the
 * `POLICY_DECIDER` injection symbol. Wraps the static-rules impl in
 * the LRU caching wrapper so hot-path consumers (PolicyGuard on
 * every request) hit cache instead of recomputing.
 *
 * V1 ships with the static-rules backend; future packs / OPA backends
 * swap by providing a different `POLICY_DECIDER` provider.
 */
import { Global, Logger, Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ConfigModule } from '../config/config.module';
import { CachingPolicyDecider } from './caching-policy.decider';
import { OpaPolicyDecider } from './opa-policy.decider';
import { POLICY_DECIDER, PolicyDecider } from './policy-decider';
import { PolicyGuard } from './policy.guard';
import { StaticRulesPolicyDecider } from './static-rules-policy.decider';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: POLICY_DECIDER,
      useFactory: (config: AppConfigService): PolicyDecider => {
        const logger = new Logger('PolicyModule');
        let inner: PolicyDecider;
        if (config.policyBackend === 'opa') {
          logger.log({
            msg: 'Policy backend: OPA',
            opaBaseUrl: config.opaBaseUrl,
            opaPackagePath: config.opaPackagePath,
          });
          inner = new OpaPolicyDecider({
            baseUrl: config.opaBaseUrl,
            packagePath: config.opaPackagePath,
            timeoutMs: config.opaTimeoutMs,
            failOpen: config.opaFailOpen,
          });
        } else {
          logger.log('Policy backend: static-rules');
          inner = new StaticRulesPolicyDecider({});
        }
        // Cache wraps either backend so the hot path stays cheap.
        // OPA's HTTP latency is the bigger cost; caching is more
        // impactful when the OPA backend is active.
        return new CachingPolicyDecider(inner, { ttlMs: 5_000, maxEntries: 10_000 });
      },
      inject: [AppConfigService],
    },
    PolicyGuard,
  ],
  exports: [POLICY_DECIDER, PolicyGuard],
})
export class PolicyModule {}
