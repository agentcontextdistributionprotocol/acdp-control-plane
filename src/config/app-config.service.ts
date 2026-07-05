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
  // Strict tenant mode (mirror of the registry's `auth.require_tenant`):
  // when true, every authenticated request MUST resolve to an explicit,
  // non-`default` tenant or it is rejected (default-deny). A JWT must
  // carry a `tenant` claim; an API key must be bound to a tenant in
  // `TENANT_API_KEYS`. A spoofable `X-Tenant-Id` header alone never
  // satisfies this. Default false = the legacy silent-`default` fallback.
  readonly requireTenant = readBoolean('AUTH_REQUIRE_TENANT', false);
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
  // Audience bound into issued tokens (`aud`) and required on local
  // verification. Defaults to our own authority so a CP-issued token is
  // bound to this CP. Mirrors the registry's `aud = <authority>` contract
  // so federated peers can enforce audience on both sides.
  readonly jwtAudience = process.env.JWT_AUDIENCE ?? this.jwtAuthority;
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
  /**
   * Federation: peer `/auth/revocations` feeds this control plane polls so a
   * token revoked at a trusted issuer is rejected here before its natural
   * expiry (reciprocal of the registry's revocation poller). Wire format
   * documented in `src/auth/revocation-feeds.ts`. Empty (default) = the CP
   * serves its own feed but does not consume any peer's.
   */
  readonly revocationFeedsRaw = process.env.REVOCATION_FEEDS ?? '';

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

  // SSRF posture for OUTBOUND webhook delivery. Subscriber URLs are gated by
  // the same SsrfPolicy as the federation proxy (https-only, no IP literals,
  // resolved IPs must not be private/loopback/IMDS, redirects refused). These
  // relax the policy for local development/testing only — default-secure.
  readonly webhookSsrfAllowHttp = readBoolean('WEBHOOK_SSRF_ALLOW_HTTP', false);
  readonly webhookSsrfAllowLoopback = readBoolean(
    'WEBHOOK_SSRF_ALLOW_LOOPBACK',
    false,
  );

  // When true, ingest accepts ONLY enrolled registry authorities (CP-3.1).
  // Default false keeps single-tenant / pre-enrollment deployments working.
  readonly ingestRequireEnrollment = readBoolean('INGEST_REQUIRE_ENROLLMENT', false);

  // Strict ingest tenancy. When true, an UNENROLLED authority may not assert a
  // non-default tenant via the X-Tenant-Id header — only a server-side
  // enrollment (authoritative) can bind an event to a non-default tenant.
  // Defaults false for V0 compatibility (header-based attribution stays the
  // documented fallback); mirrors the registry's `require_tenant` opt-in.
  // Recommended `true` for multi-tenant deployments that don't enroll a
  // per-registry secret, where a shared/empty secret would otherwise let a
  // caller pick an arbitrary tenant.
  readonly ingestStrictTenant = readBoolean('INGEST_STRICT_TENANT', false);

  // Hard cap on the raw ingest body (bytes) and on JSON nesting depth — a
  // deeply-nested or oversized payload is rejected BEFORE it is fully parsed,
  // bounding the JSON-parse DoS surface on the @Public() ingest route.
  readonly ingestMaxBodyBytes = readNumber('INGEST_MAX_BODY_BYTES', 1_048_576);
  readonly ingestMaxJsonDepth = readNumber('INGEST_MAX_JSON_DEPTH', 64);

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

  // Receipt audit mode (ACDP 0.2.0, RFC-ACDP-0010). When enabled, a
  // background sweep cross-checks registry receipts on ingested publish
  // events — structural checks always; full signature verification when the
  // installed `acdp` SDK carries the receipt API (feature-detected). See
  // `src/audit/receipt-audit.service.ts`.
  readonly receiptAuditEnabled = readBoolean('RECEIPT_AUDIT_ENABLED', false);
  readonly receiptAuditIntervalSeconds = readNumber('RECEIPT_AUDIT_INTERVAL_SECONDS', 300);
  readonly receiptAuditBatchSize = readNumber('RECEIPT_AUDIT_BATCH_SIZE', 50);
  readonly receiptAuditLookbackHours = readNumber('RECEIPT_AUDIT_LOOKBACK_HOURS', 24);

  // Transparency-log checkpoint witness (ACDP 0.3.0 Tier 3, RFC-ACDP-0012).
  // When enabled, a background sweep polls GET /log/checkpoint on every
  // enrolled registry advertising `acdp-registry-transparency-log`, verifies
  // the checkpoint signature and the §9.2 consistency proof against the
  // last-witnessed head, and alerts on any dishonesty signal (root rewrite,
  // split view, tree-size regression, log reset). See
  // `src/audit/checkpoint-witness.service.ts`.
  readonly logWitnessEnabled = readBoolean('LOG_WITNESS_ENABLED', false);
  readonly logWitnessIntervalSeconds = readNumber('LOG_WITNESS_INTERVAL_SECONDS', 300);
  // Per-registry opt-out: authorities listed here are never witnessed.
  readonly logWitnessExcludeAuthorities = readStringList('LOG_WITNESS_EXCLUDE_AUTHORITIES');

  // Receipt ↔ log inclusion cross-check (RFC-ACDP-0012 §9.1): for stored
  // publish events with receipts from log-advertising registries, fetch
  // GET /log/proof?ctx_id=… and verify inclusion against a verified
  // checkpoint. Knobs mirror RECEIPT_AUDIT_*.
  readonly logInclusionAuditEnabled = readBoolean('LOG_INCLUSION_AUDIT_ENABLED', false);
  readonly logInclusionAuditIntervalSeconds = readNumber(
    'LOG_INCLUSION_AUDIT_INTERVAL_SECONDS',
    300,
  );
  readonly logInclusionAuditBatchSize = readNumber('LOG_INCLUSION_AUDIT_BATCH_SIZE', 50);
  readonly logInclusionAuditLookbackHours = readNumber(
    'LOG_INCLUSION_AUDIT_LOOKBACK_HOURS',
    24,
  );

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

  /**
   * True when the operator configured any non-`default` tenant binding —
   * either an agent→tenant mapping (`TENANT_AGENTS`) or a tenant-bound API
   * key (`TENANT_API_KEYS` entry with a `tenantId:` prefix other than
   * `default`). Bare API keys (no prefix) bind to `default` and don't count
   * as a multi-tenant intent. Parsing is intentionally lightweight so this
   * service keeps depending only on `process.env`.
   */
  private hasTenantBindings(): boolean {
    if (this.tenantAgentsRaw.trim().length > 0) return true;
    return this.tenantApiKeysRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .some((entry) => {
        const idx = entry.indexOf(':');
        if (idx <= 0) return false; // bare key → default tenant
        return entry.slice(0, idx) !== 'default';
      });
  }

  private validate(): void {
    // Multi-tenant fail-fast (parity with the registry's main.rs startup
    // bail, commit c988ea4): if the operator configured tenant bindings
    // (the intent is multi-tenancy) but left AUTH_REQUIRE_TENANT=false, a
    // request that resolves to no tenant runs with the tenant filter
    // disabled and can surface cross-tenant rows. Force strict enforcement
    // at startup rather than fail open — in EVERY environment, not just prod.
    if (this.hasTenantBindings() && !this.requireTenant) {
      throw new Error(
        'Tenant bindings are configured (TENANT_AGENTS or a tenant-bound ' +
          'TENANT_API_KEYS entry) but AUTH_REQUIRE_TENANT=false. A request ' +
          'that resolves to no tenant would run unscoped and leak cross-tenant ' +
          'data. Set AUTH_REQUIRE_TENANT=true to enable strict enforcement.',
      );
    }

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

    if (this.receiptAuditEnabled) {
      if (this.receiptAuditIntervalSeconds < 5) {
        throw new Error(
          'RECEIPT_AUDIT_INTERVAL_SECONDS must be >= 5 when receipt audit is enabled',
        );
      }
      if (this.receiptAuditBatchSize < 1) {
        throw new Error('RECEIPT_AUDIT_BATCH_SIZE must be >= 1 when receipt audit is enabled');
      }
    }

    if (this.logWitnessEnabled && this.logWitnessIntervalSeconds < 5) {
      throw new Error(
        'LOG_WITNESS_INTERVAL_SECONDS must be >= 5 when the checkpoint witness is enabled',
      );
    }

    if (this.logInclusionAuditEnabled) {
      if (this.logInclusionAuditIntervalSeconds < 5) {
        throw new Error(
          'LOG_INCLUSION_AUDIT_INTERVAL_SECONDS must be >= 5 when the inclusion audit is enabled',
        );
      }
      if (this.logInclusionAuditBatchSize < 1) {
        throw new Error(
          'LOG_INCLUSION_AUDIT_BATCH_SIZE must be >= 1 when the inclusion audit is enabled',
        );
      }
    }

    if (this.dbPoolMax < 2) {
      throw new Error('DB_POOL_MAX must be >= 2 to avoid connection pool starvation');
    }

    if (this.revocationFeedsRaw.trim() && !this.tokenIssuanceEnabled) {
      this.logger.warn(
        'REVOCATION_FEEDS is configured but TOKEN_ISSUANCE_ENABLED=false — ' +
          'the cross-issuer revocation poller only runs when issuance is enabled.',
      );
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
