import { describe, expect, it } from 'vitest';
import { ConfigError, isAllowedUid, parseConfig } from './config.js';

const PROD_MIN = {
  ENVIRONMENT: 'prod',
  STATIC_IP: '203.0.113.7',
  ALLOWED_UIDS: 'u1',
};

describe('parseConfig', () => {
  it('is pure — the same env yields an equal config', () => {
    const env = { PORT: '9000', ALLOWED_UIDS: 'a,b' };
    expect(parseConfig(env)).toEqual(parseConfig(env));
  });

  it('defaults to the safest environment', () => {
    expect(parseConfig({}).environment).toBe('dry-run');
  });

  it('defaults ALLOWED_UIDS to empty, which denies everyone', () => {
    const config = parseConfig({});
    expect(config.allowedUids).toEqual([]);
    expect(isAllowedUid(config, 'u1')).toBe(false);
    expect(isAllowedUid(config, '')).toBe(false);
  });

  it('parses and trims a uid allowlist', () => {
    const config = parseConfig({ ALLOWED_UIDS: ' u1 , ,u2,' });
    expect(config.allowedUids).toEqual(['u1', 'u2']);
    expect(isAllowedUid(config, 'u2')).toBe(true);
    expect(isAllowedUid(config, 'u3')).toBe(false);
  });

  it('rejects an unknown ENVIRONMENT', () => {
    expect(() => parseConfig({ ENVIRONMENT: 'production' })).toThrow(ConfigError);
    expect(() => parseConfig({ ENVIRONMENT: 'PROD' })).toThrow(/ENVIRONMENT/);
  });

  it('accepts each valid environment', () => {
    expect(parseConfig({ ENVIRONMENT: 'paper' }).environment).toBe('paper');
    expect(parseConfig(PROD_MIN).environment).toBe('prod');
  });

  it('requires STATIC_IP in prod so orders.ipUsed is never blank', () => {
    expect(() => parseConfig({ ...PROD_MIN, STATIC_IP: '' })).toThrow(/STATIC_IP/);
  });

  it('requires a non-empty allowlist in prod', () => {
    expect(() => parseConfig({ ...PROD_MIN, ALLOWED_UIDS: '' })).toThrow(/ALLOWED_UIDS/);
  });

  it('defaults the instrument cache to disabled and passes a directory through verbatim', () => {
    expect(parseConfig({}).instrumentsCacheDir).toBe('');
    expect(
      parseConfig({ INSTRUMENTS_CACHE_DIR: '/var/lib/pm/instruments' }).instrumentsCacheDir,
    ).toBe('/var/lib/pm/instruments');
  });

  it('allows a blank STATIC_IP outside prod', () => {
    expect(parseConfig({ ENVIRONMENT: 'dry-run' }).staticIp).toBe('');
  });

  it('carries only secret NAMES, never values', () => {
    const config = parseConfig({ DHAN_ACCESS_TOKEN_SECRET: 'dhan-token-v2' });
    expect(config.secrets.dhan.accessToken).toBe('dhan-token-v2');
    expect(config.secrets.kite.accessToken).toBe('kite-access-token');
    expect(JSON.stringify(config)).not.toMatch(/eyJ|Bearer/);
  });

  it('rejects a non-numeric port', () => {
    expect(() => parseConfig({ PORT: 'eighty' })).toThrow(ConfigError);
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseConfig({ PORT: '0' })).toThrow(/PORT/);
    expect(() => parseConfig({ PORT: '70000' })).toThrow(/PORT/);
  });

  it('treats a blank numeric var as absent', () => {
    expect(parseConfig({ PORT: '   ' }).port).toBe(8080);
  });

  it('parses rate limit, interval and simulator knobs', () => {
    const config = parseConfig({
      RATE_LIMIT_MAX: '5',
      RATE_LIMIT_WINDOW_MS: '1000',
      RECONCILE_INTERVAL_MS: '2000',
      PORTFOLIO_REFRESH_INTERVAL_MS: '3000',
      SIMULATOR_FILL_AFTER_MS: '0',
    });
    expect(config.rateLimit).toEqual({ max: 5, windowMs: 1000 });
    expect(config.reconcileIntervalMs).toBe(2000);
    expect(config.portfolioRefreshIntervalMs).toBe(3000);
    expect(config.simulatorFillAfterMs).toBe(0);
  });

  it('parses exchange holidays and rejects a malformed one', () => {
    expect(parseConfig({ MARKET_HOLIDAYS: '2026-01-26, 2026-03-25' }).marketHolidays).toEqual([
      '2026-01-26',
      '2026-03-25',
    ]);
    expect(() => parseConfig({ MARKET_HOLIDAYS: '26-01-2026' })).toThrow(ConfigError);
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => parseConfig({ LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
    expect(parseConfig({ LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
  });

  it('reports every issue it found', () => {
    try {
      parseConfig({ ENVIRONMENT: 'prod' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues).toHaveLength(2);
    }
  });
});
