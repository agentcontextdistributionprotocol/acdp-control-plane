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

    it('throws when DB_POOL_MAX is < 2 in production', () => {
      process.env.AUTH_API_KEYS = 'k';
      process.env.DB_POOL_MAX = '1';
      const cfg = freshConfig();
      expect(() => cfg.onModuleInit()).toThrow(/DB_POOL_MAX/);
    });

    it('throws when data retention TTL < 1 day in production', () => {
      process.env.AUTH_API_KEYS = 'k';
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
