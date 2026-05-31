import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

function readBoolean(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function readNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function readStringList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

@Injectable()
export class AppConfigService implements OnModuleInit {
  private readonly logger = new Logger(AppConfigService.name);

  readonly nodeEnv = process.env.NODE_ENV ?? 'development';
  readonly isDevelopment = this.nodeEnv === 'development';

  readonly clientVersion: string = (() => {
    try {
       
      return require('../../package.json').version as string;
    } catch {
      return '0.0.0';
    }
  })();

  readonly port = readNumber('PORT', 3001);
  readonly host = process.env.HOST ?? '0.0.0.0';
  readonly corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:3000';
  readonly databaseUrl =
    process.env.DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/acdp_control_plane';

  // Auth — comma-separated API keys. Empty = auth disabled (dev only).
  readonly authApiKeys = readStringList('AUTH_API_KEYS');
  // Subset of `AUTH_API_KEYS` that's allowed to perform admin operations
  // (revoke any JTI, future: tenant ops, key rotation reload, etc.). Empty
  // (default) = no admins, so only the JWT-self path can authorize sensitive
  // operations. Documented in `src/auth/revoke.controller.ts`.
  readonly authAdminApiKeys = readStringList('AUTH_ADMIN_API_KEYS');
  // Multi-tenant API-key mapping. Wire format: `tenantId:key,tenantId:key,bareKey`
  // — bare keys (no `:` prefix) bind to the `default` tenant. Documented on
  // `src/tenant/tenant-context.ts`. Empty (default) = single-tenant deployment.
  readonly tenantApiKeysRaw = process.env.TENANT_API_KEYS ?? '';
  // Per-tenant quota config. Wire format documented in
  // `src/quota/quota-config.ts`. Empty (default) = no rate limits.
  readonly tenantQuotasRaw = process.env.TENANT_QUOTAS ?? '';
  /**
   * Agent → tenant mapping. Used by TokenIssuer to stamp the `tenant`
   * claim on minted JWTs so downstream guards can bind authorization
   * to the issuer's authoritative tenant assignment (rather than a
   * client-supplied X-Tenant-Id header).
   *
   * Wire format: comma-separated `tenant_id:agent_did` entries, e.g.
   *
   *   TENANT_AGENTS=tenant-a:did:web:agents.example:alice,tenant-b:did:web:agents.example:bob
   *
   * Agents not listed fall back to `default`. Documented in
   * `src/tenant/tenant-agents.ts`.
   */
  readonly tenantAgentsRaw = process.env.TENANT_AGENTS ?? '';

  // Policy backend selection. `static` (default) uses the in-process
  // rules engine; `opa` delegates to a sidecar via HTTP. Documented
  // in `src/policy/opa-policy.decider.ts`.
  readonly policyBackend: 'static' | 'opa' = (() => {
    const raw = (process.env.POLICY_BACKEND ?? 'static').toLowerCase();
    if (raw === 'static' || raw === 'opa') return raw;
    throw new Error(`POLICY_BACKEND must be 'static' or 'opa' (got '${raw}')`);
  })();
  readonly opaBaseUrl = process.env.OPA_URL ?? 'http://localhost:8181';
  readonly opaPackagePath = process.env.OPA_PACKAGE_PATH ?? 'acdp/policy/v1';
  readonly opaTimeoutMs = readNumber('OPA_TIMEOUT_MS', 1500);
  readonly opaFailOpen = readBoolean('OPA_FAIL_OPEN', false);

  // ── Token issuance (Phase-5: V2 Seam IdP foundation) ───────────────────
  //
  // When `tokenIssuanceEnabled` is true the control plane mounts
  // `POST /auth/challenge` + `POST /auth/token` and issues HS256 JWTs
  // signed with `jwtSecret`. The JWT shape matches the registry's
  // BearerClaims so the two issuers stay interoperable.
  //
  // `CONTROL_PLANE_PINNED_KEYS` populates the agent → public-key
  // directory used to verify challenge signatures (loaded by
  // PinnedKeysService at boot).
  readonly tokenIssuanceEnabled = readBoolean('TOKEN_ISSUANCE_ENABLED', false);
  readonly jwtSecret = process.env.JWT_SECRET ?? '';
  readonly jwtAuthority = process.env.JWT_AUTHORITY ?? 'control-plane.local';
  readonly jwtTtlSeconds = readNumber('JWT_TTL_SECONDS', 3600);
  readonly challengeTtlSeconds = readNumber('CHALLENGE_TTL_SECONDS', 300);

  // JWT signing algorithm. `HS256` (default, backward-compatible) uses
  // the symmetric `JWT_SECRET`. `EdDSA` uses an asymmetric Ed25519 keypair
  // loaded from `JWT_PRIVATE_KEY_PEM`; the public key is published at
  // `/.well-known/jwks.json` and embedded in issued tokens via the
  // `kid` header so federated peers can fetch + verify without out-of-
  // band secret distribution. See `src/auth/jwt-signing.ts`.
  readonly jwtSigningAlg: 'HS256' | 'EdDSA' = (() => {
    const raw = process.env.JWT_SIGNING_ALG ?? 'HS256';
    if (raw === 'HS256' || raw === 'EdDSA') return raw;
    throw new Error(`JWT_SIGNING_ALG must be 'HS256' or 'EdDSA' (got '${raw}')`);
  })();
  readonly jwtPrivateKeyPem = process.env.JWT_PRIVATE_KEY_PEM ?? '';
  /** Optional override for the kid claim. When unset, derived from the key fingerprint. */
  readonly jwtKid = process.env.JWT_KID ?? '';
  /**
   * Federation: tokens from these peer issuers are accepted by
   * `CrossIssuerValidator.verify`. Wire format documented in
   * `src/auth/trusted-issuers.ts`. Empty (default) = no federation.
   */
  readonly trustedIssuersRaw = process.env.TRUSTED_ISSUERS ?? '';

  // Auth-store backend selection — drives the #8 persistent stores,
  // the #12 issuance ledger, and any future auth tables. `memory` is
  // correct for single-process dev/test; multi-instance deployments
  // MUST set `postgres` so the challenge nonces and revocation list
  // are shared across replicas. Validated against the allowed set.
  readonly authPersistence: 'memory' | 'postgres' = (() => {
    const raw = (process.env.AUTH_PERSISTENCE ?? 'memory').toLowerCase();
    if (raw === 'memory' || raw === 'postgres') return raw;
    throw new Error(
      `AUTH_PERSISTENCE must be 'memory' or 'postgres' (got '${raw}')`,
    );
  })();
  readonly authSweepIntervalSeconds = readNumber('AUTH_SWEEP_INTERVAL_SECONDS', 300);

  // HMAC secret used to verify incoming registry webhooks. Empty = skip (dev).
  readonly webhookSecret = process.env.WEBHOOK_SECRET ?? '';

  // Outbound webhook delivery retry sweep. The scheduler retries pending
  // deliveries across all tenants on this interval; <= 0 disables it.
  readonly webhookRetryIntervalMs = readNumber('WEBHOOK_RETRY_INTERVAL_MS', 300000);

  // When true, ingest accepts ONLY enrolled registry authorities (CP-3.1).
  // Default false keeps single-tenant / pre-enrollment deployments working.
  readonly ingestRequireEnrollment = readBoolean('INGEST_REQUIRE_ENROLLMENT', false);

  // Bandit router exploration fraction (Thompson sampling). 0..1.
  readonly banditExplorationFraction = readNumber('BANDIT_EXPLORATION_FRACTION', 0.05);

  // Playground URL — for run-completion notifications back to the playground.
  readonly playgroundUrl = process.env.PLAYGROUND_URL ?? '';

  // SSE / stream hub
  readonly streamHubStrategy = process.env.STREAM_HUB_STRATEGY ?? 'memory';
  readonly redisUrl = process.env.REDIS_URL ?? '';
  readonly streamSseHeartbeatMs = readNumber('STREAM_SSE_HEARTBEAT_MS', 15000);

  // DB pool
  readonly dbPoolMax = readNumber('DB_POOL_MAX', 20);
  readonly dbPoolIdleTimeout = readNumber('DB_POOL_IDLE_TIMEOUT', 30000);
  readonly dbPoolConnectionTimeout = readNumber('DB_POOL_CONNECTION_TIMEOUT', 5000);

  // Throttler — global default applied per (actorId|ip). A tighter
  // override applies to /auth/challenge + /auth/token; see
  // `src/auth/auth.controller.ts` for the literal override.
  readonly throttleTtlMs = readNumber('THROTTLE_TTL_MS', 60000);
  readonly throttleLimit = readNumber('THROTTLE_LIMIT', 200);

  // Data retention
  readonly dataRetentionEnabled = readBoolean('DATA_RETENTION_ENABLED', false);
  readonly dataRetentionTtlDays = readNumber('DATA_RETENTION_TTL_DAYS', 30);
  readonly dataRetentionIntervalHours = readNumber('DATA_RETENTION_INTERVAL_HOURS', 24);

  // OTel / logging
  readonly logLevel = process.env.LOG_LEVEL ?? 'info';
  readonly otelEnabled = readBoolean('OTEL_ENABLED', false);
  readonly otelServiceName = process.env.OTEL_SERVICE_NAME ?? 'acdp-control-plane';
  readonly otelExporterOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';

  // OpenAPI / Swagger
  // Defaults to enabled in development; opt-in in production via SWAGGER_ENABLED=true.
  readonly swaggerEnabled = readBoolean('SWAGGER_ENABLED', this.nodeEnv === 'development');
  readonly swaggerPath = process.env.SWAGGER_PATH ?? 'docs';

  onModuleInit(): void {
    this.validate();
  }

  private validate(): void {
    if (this.isDevelopment) return;

    if (this.authApiKeys.length === 0) {
      throw new Error(
        'AUTH_API_KEYS must be set in production. Empty value disables authentication.',
      );
    }

    if (!this.webhookSecret) {
      this.logger.warn(
        'WEBHOOK_SECRET is not set — webhook HMAC verification is disabled. Required in production.',
      );
    }

    if (this.streamHubStrategy === 'memory') {
      this.logger.warn(
        'STREAM_HUB_STRATEGY=memory in production — SSE events will not sync across instances. ' +
          'Set STREAM_HUB_STRATEGY=redis for multi-instance deployments.',
      );
    }

    if (this.otelEnabled && !this.otelExporterOtlpEndpoint) {
      this.logger.warn(
        'OTEL_ENABLED is true but OTEL_EXPORTER_OTLP_ENDPOINT is not set — traces will be discarded',
      );
    }

    if (this.dataRetentionEnabled && this.dataRetentionTtlDays < 1) {
      throw new Error('DATA_RETENTION_TTL_DAYS must be >= 1 when retention is enabled');
    }

    if (this.dbPoolMax < 2) {
      throw new Error('DB_POOL_MAX must be >= 2 to avoid connection pool starvation');
    }

    if (this.tokenIssuanceEnabled) {
      if (this.jwtSigningAlg === 'HS256') {
        // Minimum 32 bytes for HS256 per RFC 7518 §3.2.
        const secretBytes = Buffer.byteLength(this.jwtSecret, 'utf-8');
        if (secretBytes < 32) {
          throw new Error(
            `JWT_SECRET must be at least 32 bytes when TOKEN_ISSUANCE_ENABLED=true ` +
              `(got ${secretBytes})`,
          );
        }
      } else {
        // EdDSA: the PEM is required; jwt-signing.ts will validate the key type.
        if (!this.jwtPrivateKeyPem.trim()) {
          throw new Error(
            'JWT_PRIVATE_KEY_PEM is required when JWT_SIGNING_ALG=EdDSA',
          );
        }
      }
      if (this.jwtTtlSeconds < 60) {
        throw new Error('JWT_TTL_SECONDS must be >= 60');
      }
      if (this.challengeTtlSeconds < 30) {
        throw new Error('CHALLENGE_TTL_SECONDS must be >= 30');
      }
      if (this.authPersistence === 'memory') {
        this.logger.warn(
          'AUTH_PERSISTENCE=memory in production — challenge nonces and the ' +
            'revocation list are NOT shared across instances. Set ' +
            'AUTH_PERSISTENCE=postgres for multi-instance deployments.',
        );
      }
    }
  }
}
