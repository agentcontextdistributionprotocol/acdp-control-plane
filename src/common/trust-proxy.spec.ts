import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { parseTrustProxy } from '../config/app-config.service';
import { applyTrustProxy } from './trust-proxy';

describe('applyTrustProxy', () => {
  const logger = { log: jest.fn() };
  beforeEach(() => logger.log.mockReset());

  it('off (undefined) never calls app.set — Express default untouched', () => {
    const app = { set: jest.fn() };
    applyTrustProxy(app as never, undefined, logger);
    expect(app.set).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it.each([[1], [['loopback', '10.0.0.0/8']]])('sets trust proxy once to %j and logs it structured', (setting) => {
    const app = { set: jest.fn() };
    applyTrustProxy(app as never, setting as number | string[], logger);
    expect(app.set).toHaveBeenCalledTimes(1);
    expect(app.set).toHaveBeenCalledWith('trust proxy', setting);
    expect(logger.log).toHaveBeenCalledWith({ msg: 'trust proxy enabled', trustProxy: setting });
  });

  it('every shape parseTrustProxy accepts compiles in real Express (no late TypeError)', () => {
    const accepted = [
      '1',
      '10',
      'loopback, linklocal, uniquelocal',
      '10.0.0.0/8, 192.0.2.7, 203.0.113.0/24',
      'fc00::/7, ::1, fd00::/8, 2001:db8::1/128, ::fffe:0:0/96, 64:ff9b::/96, 0.0.0.0, ::',
    ];
    for (const raw of accepted) {
      const setting = parseTrustProxy(raw);
      expect(setting).toBeDefined();
      const app = express();
      expect(() => applyTrustProxy(app as never, setting, logger)).not.toThrow();
      expect(typeof app.get('trust proxy fn')).toBe('function');
    }
  });

  it('bootstrap.ts sets trust proxy only via applyTrustProxy', () => {
    const src = readFileSync(join(__dirname, '..', 'bootstrap.ts'), 'utf8');
    expect(src).toContain('applyTrustProxy(app, config.trustProxy)');
    expect(src).not.toMatch(/\.set\(\s*['"]trust proxy/);
  });
});
