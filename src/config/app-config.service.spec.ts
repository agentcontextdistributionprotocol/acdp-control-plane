import { Logger } from '@nestjs/common';
import { AppConfigService } from './app-config.service';

describe('AppConfigService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function freshConfig(): AppConfigService {
    // Fields are initialized at construction time from process.env, so a new
    // instance picks up the test's env.
    return new AppConfigService();
  }

  it('falls back to default values when env vars are unset', () => {
    delete process.env.PORT;
    delete process.env.DATABASE_URL;
    delete process.env.AUTH_API_KEYS;
    delete process.env.WEBHOOK_SECRET;
    delete process.env.STREAM_HUB_STRATEGY;
    delete process.env.NODE_ENV;

    const cfg = freshConfig();
    expect(cfg.port).toBe(3001);
    expect(cfg.databaseUrl).toContain('acdp_control_plane');
    expect(cfg.authApiKeys).toEqual([]);
    expect(cfg.webhookSecret).toBe('');
    expect(cfg.streamHubStrategy).toBe('memory');
    expect(cfg.isDevelopment).toBe(true);
  });

  it('parses AUTH_API_KEYS as a comma-separated, trimmed list', () => {
    process.env.AUTH_API_KEYS = '  alpha, beta ,gamma,,';
    const cfg = freshConfig();
    expect(cfg.authApiKeys).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('parses boolean env vars (1/true/yes/on are truthy, others false)', () => {
    process.env.OTEL_ENABLED = 'true';
    expect(freshConfig().otelEnabled).toBe(true);
    process.env.OTEL_ENABLED = 'yes';
    expect(freshConfig().otelEnabled).toBe(true);
    process.env.OTEL_ENABLED = '1';
    expect(freshConfig().otelEnabled).toBe(true);
    process.env.OTEL_ENABLED = 'no';
    expect(freshConfig().otelEnabled).toBe(false);
    process.env.OTEL_ENABLED = 'false';
    expect(freshConfig().otelEnabled).toBe(false);
  });

  it('parses numeric env vars, falling back to default on non-numeric input', () => {
    process.env.PORT = '8080';
    expect(freshConfig().port).toBe(8080);
    process.env.PORT = 'not-a-number';
    expect(freshConfig().port).toBe(3001);
  });

  describe('production validation (onModuleInit)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('throws when AUTH_API_KEYS is empty in production', () => {
      delete process.env.AUTH_API_KEYS;
      const cfg = freshConfig();
      expect(() => cfg.onModuleInit()).toThrow(/AUTH_API_KEYS/);
    });

    it('throws when WEBHOOK_SECRET is empty in production', () => {
      process.env.AUTH_API_KEYS = 'k';
      delete process.env.WEBHOOK_SECRET;
      const cfg = freshConfig();
      expect(() => cfg.onModuleInit()).toThrow(/WEBHOOK_SECRET/);
    });

    it('throws when DB_POOL_MAX is < 2 in production', () => {
      process.env.AUTH_API_KEYS = 'k';
      process.env.WEBHOOK_SECRET = 'shh';
      process.env.DB_POOL_MAX = '1';
      const cfg = freshConfig();
      expect(() => cfg.onModuleInit()).toThrow(/DB_POOL_MAX/);
    });

    it('throws when data retention TTL < 1 day in production', () => {
      process.env.AUTH_API_KEYS = 'k';
      process.env.WEBHOOK_SECRET = 'shh';
      process.env.DATA_RETENTION_ENABLED = 'true';
      process.env.DATA_RETENTION_TTL_DAYS = '0';
      const cfg = freshConfig();
      expect(() => cfg.onModuleInit()).toThrow(/DATA_RETENTION_TTL_DAYS/);
    });

    it('passes validation when everything is set', () => {
      process.env.AUTH_API_KEYS = 'k1,k2';
      process.env.WEBHOOK_SECRET = 'shh';
      process.env.STREAM_HUB_STRATEGY = 'redis';
      process.env.REDIS_URL = 'redis://localhost:6379';
      const cfg = freshConfig();
      expect(() => cfg.onModuleInit()).not.toThrow();
    });

    it('skips validation in development', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.AUTH_API_KEYS;
      const cfg = freshConfig();
      expect(() => cfg.onModuleInit()).not.toThrow();
    });
  });

  describe('witness quorum self-cosignature guard (B8)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      process.env.AUTH_API_KEYS = 'k';
      process.env.WEBHOOK_SECRET = 'shh';
    });

    it('throws when WITNESS_ID appears in WITNESS_QUORUM_TRUSTED, naming both variables', () => {
      process.env.LOG_WITNESS_ENABLED = 'true';
      process.env.WITNESS_QUORUM_ENABLED = 'true';
      process.env.WITNESS_ID = 'did:web:cp.example';
      process.env.WITNESS_QUORUM_TRUSTED = 'did:web:cp.example';
      const cfg = freshConfig();
      expect(() => cfg.onModuleInit()).toThrow(/WITNESS_QUORUM_TRUSTED/);
      expect(() => cfg.onModuleInit()).toThrow(/WITNESS_ID/);
    });

    it('starts normally when WITNESS_ID is absent from WITNESS_QUORUM_TRUSTED', () => {
      process.env.LOG_WITNESS_ENABLED = 'true';
      process.env.WITNESS_QUORUM_ENABLED = 'true';
      process.env.WITNESS_ID = 'did:web:cp.example';
      process.env.WITNESS_QUORUM_TRUSTED = 'did:web:other-witness.example';
      const cfg = freshConfig();
      expect(() => cfg.onModuleInit()).not.toThrow();
    });

    it('starts normally consume-only (quorum on, cosigning off, WITNESS_ID unset) regardless of an empty entry in WITNESS_QUORUM_TRUSTED', () => {
      process.env.LOG_WITNESS_ENABLED = 'true';
      process.env.WITNESS_QUORUM_ENABLED = 'true';
      process.env.WITNESS_COSIGNING_ENABLED = 'false';
      delete process.env.WITNESS_ID;
      // A trailing comma (readStringList filters the resulting blank entry)
      // must not trip the guard — WITNESS_ID is unset, so the empty-check
      // short-circuits before the .includes() membership check ever runs.
      process.env.WITNESS_QUORUM_TRUSTED = 'did:web:other-witness.example,,';
      const cfg = freshConfig();
      expect(() => cfg.onModuleInit()).not.toThrow();
    });
  });

  describe('witness cosigning / retention interaction warning (B1)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      process.env.AUTH_API_KEYS = 'k';
      process.env.WEBHOOK_SECRET = 'shh';
      process.env.LOG_WITNESS_ENABLED = 'true';
      process.env.WITNESS_COSIGNING_ENABLED = 'true';
      process.env.WITNESS_ID = 'did:web:cp.example';
      process.env.WITNESS_SIGNING_PRIVATE_KEY_PEM = '-----BEGIN PRIVATE KEY-----';
    });

    it('warns (does not throw) naming both variables when retention is off', () => {
      process.env.DATA_RETENTION_ENABLED = 'false';
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const cfg = freshConfig();
      expect(() => cfg.onModuleInit()).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/WITNESS_COSIGNING_ENABLED.*DATA_RETENTION_ENABLED/),
      );
      warnSpy.mockRestore();
    });

    it('does not warn when retention is enabled', () => {
      process.env.DATA_RETENTION_ENABLED = 'true';
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const cfg = freshConfig();
      cfg.onModuleInit();
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringMatching(/WITNESS_COSIGNING_ENABLED.*DATA_RETENTION_ENABLED/),
      );
      warnSpy.mockRestore();
    });
  });

  describe('witness quorum freshness-split config (§8.1)', () => {
    it('defaults WITNESS_QUORUM_MAX_AGE_SECONDS to 300', () => {
      delete process.env.WITNESS_QUORUM_MAX_AGE_SECONDS;
      expect(freshConfig().witnessQuorumMaxAgeSeconds).toBe(300);
    });

    it('parses a configured WITNESS_QUORUM_MAX_AGE_SECONDS', () => {
      process.env.WITNESS_QUORUM_MAX_AGE_SECONDS = '60';
      expect(freshConfig().witnessQuorumMaxAgeSeconds).toBe(60);
    });

    it('treats an empty string as an explicit "disable the split" (null)', () => {
      process.env.WITNESS_QUORUM_MAX_AGE_SECONDS = '';
      expect(freshConfig().witnessQuorumMaxAgeSeconds).toBeNull();
    });

    it('treats literal "0" as an explicit "disable the split" (null), not zero staleness', () => {
      process.env.WITNESS_QUORUM_MAX_AGE_SECONDS = '0';
      expect(freshConfig().witnessQuorumMaxAgeSeconds).toBeNull();
    });

    it('defaults WITNESS_QUORUM_MAX_CLOCK_SKEW_SECONDS to 120', () => {
      delete process.env.WITNESS_QUORUM_MAX_CLOCK_SKEW_SECONDS;
      expect(freshConfig().witnessQuorumMaxClockSkewSeconds).toBe(120);
    });

    it('defaults WITNESS_COSIGNATURE_KEEP_PER_HEAD to 10', () => {
      delete process.env.WITNESS_COSIGNATURE_KEEP_PER_HEAD;
      expect(freshConfig().witnessCosignatureKeepPerHead).toBe(10);
    });
  });

  describe('multi-tenant fail-fast (all environments)', () => {
    beforeEach(() => {
      // Run in development to prove the check is NOT gated behind prod.
      process.env.NODE_ENV = 'development';
      delete process.env.TENANT_AGENTS;
      delete process.env.TENANT_API_KEYS;
      delete process.env.AUTH_REQUIRE_TENANT;
    });

    it('throws when TENANT_AGENTS is set but AUTH_REQUIRE_TENANT is false', () => {
      process.env.TENANT_AGENTS = 'tenant-a:did:web:agents.example:alice';
      const cfg = freshConfig();
      expect(() => cfg.onModuleInit()).toThrow(/AUTH_REQUIRE_TENANT=true/);
    });

    it('throws when a tenant-bound TENANT_API_KEYS entry exists without strict mode', () => {
      process.env.TENANT_API_KEYS = 'tenant-a:key-a';
      const cfg = freshConfig();
      expect(() => cfg.onModuleInit()).toThrow(/AUTH_REQUIRE_TENANT=true/);
    });

    it('allows bare (default-bound) API keys without strict mode', () => {
      process.env.TENANT_API_KEYS = 'bare-key-1,default:bare-key-2';
      const cfg = freshConfig();
      expect(() => cfg.onModuleInit()).not.toThrow();
    });

    it('passes when tenant bindings are present AND strict mode is on', () => {
      process.env.TENANT_AGENTS = 'tenant-a:did:web:agents.example:alice';
      process.env.AUTH_REQUIRE_TENANT = 'true';
      const cfg = freshConfig();
      expect(() => cfg.onModuleInit()).not.toThrow();
    });
  });
});
