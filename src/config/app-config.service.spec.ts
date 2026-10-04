import { Logger } from '@nestjs/common';
import { AppConfigService, parseTrustProxy, TRUST_PROXY_MAX_HOPS } from './app-config.service';

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

  describe('THROTTLE_IPV6_SUBNET_PREFIX (issue #187)', () => {
    it('defaults to 64', () => {
      delete process.env.THROTTLE_IPV6_SUBNET_PREFIX;
      expect(freshConfig().throttleIpv6SubnetPrefix).toBe(64);
    });

    it('accepts the bounds 1 and 128 and a typical 56', () => {
      process.env.NODE_ENV = 'development';
      for (const v of ['1', '56', '128']) {
        process.env.THROTTLE_IPV6_SUBNET_PREFIX = v;
        const cfg = freshConfig();
        expect(cfg.throttleIpv6SubnetPrefix).toBe(Number(v));
        expect(() => cfg.onModuleInit()).not.toThrow();
      }
    });

    it.each(['development', 'production'])(
      'fails startup on a set but non-numeric value in %s (no silent fallback to 64)',
      (env) => {
        process.env.NODE_ENV = env;
        process.env.AUTH_API_KEYS = 'k';
        process.env.WEBHOOK_SECRET = 'shh';
        for (const v of ['sixty-four', '/48', '64/', 'Infinity', 'NaN', '0x', '0x40', '1e2', '', '  ']) {
          process.env.THROTTLE_IPV6_SUBNET_PREFIX = v;
          expect(() => freshConfig().onModuleInit()).toThrow(/THROTTLE_IPV6_SUBNET_PREFIX/);
        }
      },
    );

    it('names the offending raw value in the startup error', () => {
      process.env.NODE_ENV = 'development';
      process.env.THROTTLE_IPV6_SUBNET_PREFIX = '/48';
      expect(() => freshConfig().onModuleInit()).toThrow('(got "/48")');
    });

    it('accepts a decimal integer with surrounding whitespace', () => {
      process.env.NODE_ENV = 'development';
      process.env.THROTTLE_IPV6_SUBNET_PREFIX = ' 56 ';
      const cfg = freshConfig();
      expect(cfg.throttleIpv6SubnetPrefix).toBe(56);
      expect(() => cfg.onModuleInit()).not.toThrow();
    });

    it('unset still defaults to 64 and passes validation', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.THROTTLE_IPV6_SUBNET_PREFIX;
      const cfg = freshConfig();
      expect(cfg.throttleIpv6SubnetPrefix).toBe(64);
      expect(() => cfg.onModuleInit()).not.toThrow();
    });

    it.each(['development', 'production'])(
      'fails startup on 0, 129, -1 or 64.5 in %s (not dev-only)',
      (env) => {
        process.env.NODE_ENV = env;
        process.env.AUTH_API_KEYS = 'k';
        process.env.WEBHOOK_SECRET = 'shh';
        for (const v of ['0', '129', '-1', '64.5']) {
          process.env.THROTTLE_IPV6_SUBNET_PREFIX = v;
          expect(() => freshConfig().onModuleInit()).toThrow(/THROTTLE_IPV6_SUBNET_PREFIX/);
        }
      },
    );
  });

  describe('graceful-drain knobs (issue #192)', () => {
    const KNOBS = [
      // name, field, default, valid samples, invalid samples
      {
        name: 'SHUTDOWN_TIMEOUT_MS',
        field: 'shutdownTimeoutMs',
        def: 10000,
        ok: ['1000', '3000', ' 25000 ', '600000'],
        bad: ['abc', '', '  ', '999', '0', '-1', '1500.5', '1e4', '0x3e8', '10s', 'Infinity', '2147483648'],
      },
      {
        name: 'SHUTDOWN_RETRY_AFTER_SECONDS',
        field: 'shutdownDrainRetryAfterSeconds',
        def: 1,
        ok: ['1', '5', '300'],
        bad: ['abc', '', '0', '301', '-1', '1.5', '1e1'],
      },
      {
        name: 'STREAM_SSE_SHUTDOWN_RETRY_MS',
        field: 'sseShutdownRetryMs',
        def: 1000,
        ok: ['0', '500', '60000'],
        bad: ['abc', '', '60001', '-1', '2.5', '1e3'],
      },
      {
        // #192 Phase 3: the opt-in pre-close drain delay.
        name: 'SHUTDOWN_DRAIN_DELAY_MS',
        field: 'shutdownDrainDelayMs',
        def: 0,
        ok: ['0', '1500', ' 5000 ', '15000', '2147483647'],
        bad: ['abc', '', ' ', '-1', '1.5', '1e3', '0x10', '5s', 'Infinity', '2147483648'],
      },
    ] as const;

    for (const k of KNOBS) {
      describe(k.name, () => {
        it(`defaults to ${k.def} and passes validation when unset`, () => {
          process.env.NODE_ENV = 'development';
          delete process.env[k.name];
          const cfg = freshConfig();
          expect(cfg[k.field]).toBe(k.def);
          expect(() => cfg.onModuleInit()).not.toThrow();
        });

        it('accepts in-range decimal integers', () => {
          process.env.NODE_ENV = 'development';
          for (const v of k.ok) {
            process.env[k.name] = v;
            const cfg = freshConfig();
            expect(cfg[k.field]).toBe(Number(v));
            expect(() => cfg.onModuleInit()).not.toThrow();
          }
        });

        it.each(['development', 'production'])(
          'fails startup on garbage or out-of-range values in %s (no silent default)',
          (env) => {
            process.env.NODE_ENV = env;
            process.env.AUTH_API_KEYS = 'k';
            process.env.WEBHOOK_SECRET = 'shh';
            for (const v of k.bad) {
              process.env[k.name] = v;
              expect({ v, threw: throws(() => freshConfig().onModuleInit(), k.name) }).toEqual({
                v,
                threw: true,
              });
            }
          },
        );
      });
    }

    it('names the offending raw value', () => {
      process.env.NODE_ENV = 'development';
      process.env.SHUTDOWN_TIMEOUT_MS = 'abc';
      expect(() => freshConfig().onModuleInit()).toThrow(
        'SHUTDOWN_TIMEOUT_MS must be an integer in [1000, 2147483647] (got "abc")',
      );
    });

    describe('SHUTDOWN_DRAIN_DELAY_MS + SHUTDOWN_TIMEOUT_MS budget warning', () => {
      const WARN = 'SHUTDOWN_DRAIN_DELAY_MS + SHUTDOWN_TIMEOUT_MS exceeds 25000 ms';

      it.each(['development', 'production'])(
        'warns (does not fail) in %s when delay + timeout > 25000, with structured fields',
        (env) => {
          process.env.NODE_ENV = env;
          process.env.AUTH_API_KEYS = 'k';
          process.env.WEBHOOK_SECRET = 'shh';
          process.env.SHUTDOWN_DRAIN_DELAY_MS = '15001';
          process.env.SHUTDOWN_TIMEOUT_MS = '10000';
          const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
          try {
            expect(() => freshConfig().onModuleInit()).not.toThrow();
            expect(warnSpy).toHaveBeenCalledWith(
              expect.objectContaining({
                msg: expect.stringContaining(WARN),
                shutdownDrainDelayMs: 15001,
                shutdownTimeoutMs: 10000,
                worstCaseShutdownMs: 25001,
              }),
            );
          } finally {
            warnSpy.mockRestore();
          }
        },
      );

      it.each([
        ['unset delay, default timeout', undefined, undefined],
        ['exactly 25000', '15000', '10000'],
      ])('does not warn for %s', (_label, delay, timeout) => {
        process.env.NODE_ENV = 'development';
        if (delay === undefined) delete process.env.SHUTDOWN_DRAIN_DELAY_MS;
        else process.env.SHUTDOWN_DRAIN_DELAY_MS = delay;
        if (timeout === undefined) delete process.env.SHUTDOWN_TIMEOUT_MS;
        else process.env.SHUTDOWN_TIMEOUT_MS = timeout;
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        try {
          freshConfig().onModuleInit();
          expect(warnSpy).not.toHaveBeenCalledWith(
            expect.objectContaining({ msg: expect.stringContaining(WARN) }),
          );
        } finally {
          warnSpy.mockRestore();
        }
      });
    });

    function throws(fn: () => void, name: string): boolean {
      try {
        fn();
        return false;
      } catch (err) {
        return err instanceof Error && err.message.startsWith(name);
      }
    }
  });

  describe('readiness knobs + DB_POOL_CONNECTION_TIMEOUT (issue #210)', () => {
    function throwsNamed(fn: () => void, name: string): boolean {
      try {
        fn();
        return false;
      } catch (err) {
        return err instanceof Error && err.message.startsWith(name);
      }
    }

    it('defaults: READINESS_DB_TIMEOUT_MS 1000, READINESS_CACHE_MS 1000; passes validation', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.READINESS_DB_TIMEOUT_MS;
      delete process.env.READINESS_CACHE_MS;
      delete process.env.DB_POOL_CONNECTION_TIMEOUT;
      const cfg = freshConfig();
      expect(cfg.readinessDbTimeoutMs).toBe(1000);
      expect(cfg.readinessCacheMs).toBe(1000);
      expect(cfg.dbPoolConnectionTimeout).toBe(5000);
      expect(() => cfg.onModuleInit()).not.toThrow();
    });

    it('accepts in-range strict integers', () => {
      process.env.NODE_ENV = 'development';
      for (const [t, c] of [
        ['50', '0'],
        [' 300 ', '200'],
        ['4999', '60000'],
      ]) {
        process.env.READINESS_DB_TIMEOUT_MS = t;
        process.env.READINESS_CACHE_MS = c;
        const cfg = freshConfig();
        expect([cfg.readinessDbTimeoutMs, cfg.readinessCacheMs]).toEqual([Number(t), Number(c)]);
        expect(() => cfg.onModuleInit()).not.toThrow();
      }
    });

    // Every environment: the dev harness must reject these too, which proves the
    // checks sit BEFORE validate()'s `isDevelopment` early return.
    it.each(['development', 'production'])('fails startup on bad values in %s', (env) => {
      process.env.NODE_ENV = env;
      process.env.AUTH_API_KEYS = 'k';
      process.env.WEBHOOK_SECRET = 'shh';
      const cases: Array<[string, string]> = [
        ['READINESS_DB_TIMEOUT_MS', 'abc'],
        ['READINESS_DB_TIMEOUT_MS', '0'],
        ['READINESS_DB_TIMEOUT_MS', '49'],
        ['READINESS_DB_TIMEOUT_MS', '30001'],
        ['READINESS_DB_TIMEOUT_MS', '40000'],
        ['READINESS_DB_TIMEOUT_MS', '1.5'],
        ['READINESS_DB_TIMEOUT_MS', ''],
        ['READINESS_CACHE_MS', '-1'],
        ['READINESS_CACHE_MS', 'x'],
        ['READINESS_CACHE_MS', '60001'],
        ['READINESS_CACHE_MS', '1e3'],
        ['DB_POOL_CONNECTION_TIMEOUT', '0'],
        ['DB_POOL_CONNECTION_TIMEOUT', '-1'],
        ['DB_POOL_CONNECTION_TIMEOUT', '1.5'],
        // Strict parse (#210 reconcile): these used to fall back to 5000 silently.
        ['DB_POOL_CONNECTION_TIMEOUT', '5s'],
        ['DB_POOL_CONNECTION_TIMEOUT', ''],
        ['DB_POOL_CONNECTION_TIMEOUT', '1e3'],
        ['DB_POOL_CONNECTION_TIMEOUT', '0x10'],
        ['DB_POOL_CONNECTION_TIMEOUT', 'abc'],
        ['DB_POOL_CONNECTION_TIMEOUT', '2147483648'],
      ];
      for (const [name, v] of cases) {
        process.env = { ...process.env };
        delete process.env.READINESS_DB_TIMEOUT_MS;
        delete process.env.READINESS_CACHE_MS;
        delete process.env.DB_POOL_CONNECTION_TIMEOUT;
        process.env[name] = v;
        expect({ name, v, threw: throwsNamed(() => freshConfig().onModuleInit(), name) }).toEqual({
          name,
          v,
          threw: true,
        });
      }
    });

    it('the DB_POOL_CONNECTION_TIMEOUT error names the variable, the value and why 0 is refused', () => {
      process.env.NODE_ENV = 'development';
      process.env.DB_POOL_CONNECTION_TIMEOUT = '0';
      expect(() => freshConfig().onModuleInit()).toThrow(
        /DB_POOL_CONNECTION_TIMEOUT must be an integer in \[1, 2147483647\] \(got "0"\); 0 disables pg-pool's checkout and connect timeouts/,
      );
    });

    it('DB_POOL_CONNECTION_TIMEOUT is strict: a non-integer is refused, not defaulted', () => {
      process.env.NODE_ENV = 'development';
      process.env.DB_POOL_CONNECTION_TIMEOUT = '5s';
      const cfg = freshConfig();
      expect(cfg.dbPoolConnectionTimeout).toBeNaN();
      expect(() => cfg.onModuleInit()).toThrow(
        /^DB_POOL_CONNECTION_TIMEOUT must be an integer in \[1, 2147483647\] \(got "5s"\)/,
      );
      process.env.DB_POOL_CONNECTION_TIMEOUT = ' 3000 ';
      const ok = freshConfig();
      expect(ok.dbPoolConnectionTimeout).toBe(3000);
      expect(() => ok.onModuleInit()).not.toThrow();
    });

    it('warns (does not fail) when the readiness timeout >= DB_POOL_CONNECTION_TIMEOUT', () => {
      process.env.NODE_ENV = 'development';
      process.env.READINESS_DB_TIMEOUT_MS = '2000';
      process.env.DB_POOL_CONNECTION_TIMEOUT = '2000';
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      try {
        expect(() => freshConfig().onModuleInit()).not.toThrow();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            msg: expect.stringContaining('READINESS_DB_TIMEOUT_MS >= DB_POOL_CONNECTION_TIMEOUT'),
            readinessDbTimeoutMs: 2000,
            dbPoolConnectionTimeout: 2000,
          }),
        );
        warnSpy.mockClear();
        process.env.READINESS_DB_TIMEOUT_MS = '1999';
        freshConfig().onModuleInit();
        expect(warnSpy).not.toHaveBeenCalledWith(
          expect.objectContaining({
            msg: expect.stringContaining('READINESS_DB_TIMEOUT_MS >= DB_POOL_CONNECTION_TIMEOUT'),
          }),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('TRUST_PROXY', () => {
    it('is off (undefined) when unset, empty, 0, 00 or false', () => {
      delete process.env.TRUST_PROXY;
      expect(freshConfig().trustProxy).toBeUndefined();
      for (const v of ['', '   ', '0', '00', 'false', 'FALSE', ' False ']) {
        expect(parseTrustProxy(v)).toBeUndefined();
      }
    });

    it('parses a hop count as a NUMBER (Express treats the string "1" as an IP)', () => {
      expect(parseTrustProxy('1')).toBe(1);
      expect(parseTrustProxy(' 2 ')).toBe(2);
      expect(parseTrustProxy(String(TRUST_PROXY_MAX_HOPS))).toBe(TRUST_PROXY_MAX_HOPS);
    });

    it('parses names, IPs and CIDRs into a trimmed, lowercased, de-duplicated list', () => {
      expect(parseTrustProxy('Loopback, 10.0.0.0/8')).toEqual(['loopback', '10.0.0.0/8']);
      expect(parseTrustProxy('linklocal,uniquelocal')).toEqual(['linklocal', 'uniquelocal']);
      expect(parseTrustProxy('::1, fd00::/8, FC00::/7')).toEqual(['::1', 'fd00::/8', 'fc00::/7']);
      expect(parseTrustProxy('203.0.113.7')).toEqual(['203.0.113.7']);
      expect(parseTrustProxy('2001:db8::1/128, 192.0.2.0/24')).toEqual([
        '2001:db8::1/128',
        '192.0.2.0/24',
      ]);
      expect(parseTrustProxy('loopback,LOOPBACK, 10.0.0.1,10.0.0.1')).toEqual([
        'loopback',
        '10.0.0.1',
      ]);
    });

    it.each(['true', 'TRUE', ' True ', 'yes', 'on'])(
      'rejects %j — trusting every hop makes X-Forwarded-For client-chosen',
      (v) => {
        expect(() => parseTrustProxy(v)).toThrow(/X-Forwarded-For.*throttle-bucket evasion/);
      },
    );

    it.each([
      ['11', /hop count/],
      ['999', /hop count/],
      ['-1', /not an IP address/],
      ['1.5', /not an IP address/],
      ['no', /not an IP address/],
      ['off', /not an IP address/],
      ['garbage', /not an IP address/],
      ['1.2.3', /not an IP address/],
      ['10.0.0.0/33', /prefix must be in \[8, 32\]/],
      ['10.0.0.0/0', /prefix must be in/],
      ['0.0.0.0/1,128.0.0.0/1', /prefix must be in/],
      ['10.0.0.0/7', /prefix must be in/],
      ['::/0', /prefix must be in \[7, 128\]/],
      ['::/1', /prefix must be in/],
      ['8000::/1', /prefix must be in/],
      ['fe80::/129', /prefix must be in/],
      ['10.0.0.0/255.0.0.0', /netmask/],
      ['10.0.0.0/', /prefix must be an integer/],
      ['fe80::1%eth0', /zone ids/],
      ['::ffff:10.0.0.1', /dotted-quad/],
      ['::ffff:a00:1', /IPv4-mapped/],
      ['0:0:0:0:0:ffff:a00:1', /IPv4-mapped/],
      ['::1.2.3.4', /dotted-quad/],
      ['::1.2.3.4/96', /dotted-quad/],
      ['64:ff9b::1.2.3.4', /dotted-quad/],
      ['::ffff:0:0/96', /IPv4-mapped/],
      ['::/80', /IPv4-mapped/],
      ['::/7', /IPv4-mapped/],
      ['::ffff:a00:0/104', /IPv4-mapped/],
      ['::FFFF:0:0/95', /IPv4-mapped/],
      ['loopback,,10.0.0.1', /empty entry/],
      ['10.0.0.1,', /empty entry/],
    ])('rejects %j', (v, msg) => {
      expect(() => parseTrustProxy(v)).toThrow(msg);
    });

    it('accepts IPv6 CIDRs adjacent to, but not overlapping, IPv4-mapped space', () => {
      expect(parseTrustProxy('::fffe:0:0/96')).toEqual(['::fffe:0:0/96']);
      expect(parseTrustProxy('64:ff9b::/96')).toEqual(['64:ff9b::/96']);
      expect(parseTrustProxy('::1/128')).toEqual(['::1/128']);
    });

    it.each(['development', 'production'])(
      'fails at CONSTRUCTION in %s (before migrations), not only in onModuleInit',
      (env) => {
        process.env.NODE_ENV = env;
        process.env.TRUST_PROXY = 'true';
        expect(() => freshConfig()).toThrow(/TRUST_PROXY=true is rejected/);
      },
    );

    it('exposes the parsed value on the service', () => {
      process.env.TRUST_PROXY = '1';
      expect(freshConfig().trustProxy).toBe(1);
      process.env.TRUST_PROXY = 'loopback';
      expect(freshConfig().trustProxy).toEqual(['loopback']);
    });
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

  describe('key-revocation config (RFC-ACDP-0014 §6/§7)', () => {
    it('defaults KEY_REVOCATION_CHECK_ENABLED to false and the scope to same_registry', () => {
      delete process.env.KEY_REVOCATION_CHECK_ENABLED;
      delete process.env.KEY_REVOCATION_ATTESTED_SCOPE;
      const cfg = freshConfig();
      expect(cfg.keyRevocationCheckEnabled).toBe(false);
      expect(cfg.keyRevocationAttestedScope).toBe('same_registry');
      expect(cfg.keyRevocationIgnoreFingerprints).toEqual([]);
      expect(cfg.keyRevocationLookbackHours).toBe(720);
      expect(cfg.keyRevocationLineageCursorTtlHours).toBe(1);
    });

    it('parses KEY_REVOCATION_LINEAGE_CURSOR_TTL_HOURS, allowing 0 (always re-walk)', () => {
      process.env.KEY_REVOCATION_LINEAGE_CURSOR_TTL_HOURS = '6';
      expect(freshConfig().keyRevocationLineageCursorTtlHours).toBe(6);
      process.env.KEY_REVOCATION_LINEAGE_CURSOR_TTL_HOURS = '0';
      expect(freshConfig().keyRevocationLineageCursorTtlHours).toBe(0);
    });

    it('parses KEY_REVOCATION_IGNORE_FINGERPRINTS as a comma-separated, trimmed list', () => {
      process.env.KEY_REVOCATION_IGNORE_FINGERPRINTS = '  sha256:aaa, sha256:bbb ,,';
      expect(freshConfig().keyRevocationIgnoreFingerprints).toEqual(['sha256:aaa', 'sha256:bbb']);
    });

    describe('production validation', () => {
      beforeEach(() => {
        process.env.NODE_ENV = 'production';
        process.env.AUTH_API_KEYS = 'k';
        process.env.WEBHOOK_SECRET = 'shh';
      });

      it('throws when enabled without RECEIPT_AUDIT_ENABLED, naming both variables', () => {
        process.env.KEY_REVOCATION_CHECK_ENABLED = 'true';
        process.env.RECEIPT_AUDIT_ENABLED = 'false';
        const cfg = freshConfig();
        expect(() => cfg.onModuleInit()).toThrow(/KEY_REVOCATION_CHECK_ENABLED/);
        expect(() => cfg.onModuleInit()).toThrow(/RECEIPT_AUDIT_ENABLED/);
      });

      it('throws on an invalid KEY_REVOCATION_ATTESTED_SCOPE, naming all three valid values', () => {
        process.env.KEY_REVOCATION_CHECK_ENABLED = 'true';
        process.env.RECEIPT_AUDIT_ENABLED = 'true';
        process.env.KEY_REVOCATION_ATTESTED_SCOPE = 'bogus';
        const cfg = freshConfig();
        expect(() => cfg.onModuleInit()).toThrow(/same_registry/);
        expect(() => cfg.onModuleInit()).toThrow(/global/);
        expect(() => cfg.onModuleInit()).toThrow(/off/);
      });

      it('throws when KEY_REVOCATION_LOOKBACK_HOURS < 1', () => {
        process.env.KEY_REVOCATION_CHECK_ENABLED = 'true';
        process.env.RECEIPT_AUDIT_ENABLED = 'true';
        process.env.KEY_REVOCATION_LOOKBACK_HOURS = '0';
        const cfg = freshConfig();
        expect(() => cfg.onModuleInit()).toThrow(/KEY_REVOCATION_LOOKBACK_HOURS/);
      });

      it('throws on a NEGATIVE KEY_REVOCATION_LINEAGE_CURSOR_TTL_HOURS but accepts 0', () => {
        process.env.KEY_REVOCATION_CHECK_ENABLED = 'true';
        process.env.RECEIPT_AUDIT_ENABLED = 'true';
        process.env.KEY_REVOCATION_LINEAGE_CURSOR_TTL_HOURS = '-1';
        expect(() => freshConfig().onModuleInit()).toThrow(
          /KEY_REVOCATION_LINEAGE_CURSOR_TTL_HOURS/,
        );
        // 0 is a legitimate opt-out ("never let a cursor suppress a walk").
        process.env.KEY_REVOCATION_LINEAGE_CURSOR_TTL_HOURS = '0';
        expect(() => freshConfig().onModuleInit()).not.toThrow();
      });

      it('passes validation when enabled with valid prerequisites', () => {
        process.env.KEY_REVOCATION_CHECK_ENABLED = 'true';
        process.env.RECEIPT_AUDIT_ENABLED = 'true';
        process.env.KEY_REVOCATION_ATTESTED_SCOPE = 'global';
        process.env.KEY_REVOCATION_LOOKBACK_HOURS = '48';
        process.env.KEY_REVOCATION_LINEAGE_CURSOR_TTL_HOURS = '12';
        const cfg = freshConfig();
        expect(() => cfg.onModuleInit()).not.toThrow();
      });

      it('does not validate scope/lookback when the check is disabled', () => {
        process.env.KEY_REVOCATION_CHECK_ENABLED = 'false';
        process.env.KEY_REVOCATION_ATTESTED_SCOPE = 'bogus';
        process.env.KEY_REVOCATION_LOOKBACK_HOURS = '0';
        const cfg = freshConfig();
        expect(() => cfg.onModuleInit()).not.toThrow();
      });
    });

    it('skips validation in development regardless of misconfiguration', () => {
      process.env.NODE_ENV = 'development';
      process.env.KEY_REVOCATION_CHECK_ENABLED = 'true';
      process.env.RECEIPT_AUDIT_ENABLED = 'false';
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
