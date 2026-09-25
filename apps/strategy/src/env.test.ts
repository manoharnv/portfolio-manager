import { describe, expect, it } from 'vitest';
import { instrumentSource, parseSegments, readEnv } from './env.js';

describe('readEnv', () => {
  const BASE = {
    PM_UID: 'u1',
    PM_BROKER_SECRET: 'projects/p/secrets/s/versions/latest',
    PM_INSTRUMENTS_URL: 'file:///var/lib/pm/instruments/dhan-scrip-master.csv',
  };

  it('reads the required values and applies the defaults', () => {
    expect(readEnv(BASE)).toEqual({
      uid: 'u1',
      brokerSecret: 'projects/p/secrets/s/versions/latest',
      instrumentsUrl: 'file:///var/lib/pm/instruments/dhan-scrip-master.csv',
      holidays: [],
      segments: ['EQ'],
      prettyLogs: false,
      intradayIntervalMinutes: 5,
    });
  });

  it('parses holidays, segments and the interval', () => {
    expect(
      readEnv({
        ...BASE,
        PM_HOLIDAYS: '2026-10-02, 2026-11-10',
        PM_INSTRUMENT_SEGMENTS: 'EQ,FNO',
        PM_INTRADAY_INTERVAL_MINUTES: '15',
        PM_PRETTY_LOGS: 'true',
      }),
    ).toMatchObject({
      holidays: ['2026-10-02', '2026-11-10'],
      segments: ['EQ', 'FNO'],
      intradayIntervalMinutes: 15,
      prettyLogs: true,
    });
  });

  it('fails closed on a missing required variable', () => {
    expect(() => readEnv({ ...BASE, PM_UID: ' ' })).toThrow(/PM_UID/);
  });

  it('prefers the cache directory and requires one of directory / URL', () => {
    const env = readEnv({ ...BASE, PM_INSTRUMENTS_DIR: '/var/lib/pm/instruments' });
    expect(env.instrumentsDir).toBe('/var/lib/pm/instruments');
    expect(env.instrumentsUrl).toBe(BASE.PM_INSTRUMENTS_URL);
    expect(() => readEnv({ ...BASE, PM_INSTRUMENTS_URL: '' })).toThrow(/PM_INSTRUMENTS_DIR/);
  });
});

describe('instrumentSource', () => {
  it("picks the broker's file inside the cache directory", () => {
    expect(instrumentSource({ instrumentsDir: '/var/lib/pm/instruments' }, 'dhan')).toBe(
      'file:///var/lib/pm/instruments/dhan-scrip-master.csv',
    );
    expect(instrumentSource({ instrumentsDir: '/var/lib/pm/instruments' }, 'kite')).toBe(
      'file:///var/lib/pm/instruments/kite-instruments.csv',
    );
  });

  it('falls back to the single URL for either broker when no directory is set', () => {
    expect(instrumentSource({ instrumentsUrl: 'https://api.kite.trade/instruments' }, 'kite')).toBe(
      'https://api.kite.trade/instruments',
    );
  });

  it('refuses when nothing is configured', () => {
    expect(() => instrumentSource({}, 'dhan')).toThrow(/PM_INSTRUMENTS_DIR/);
  });
});

describe('parseSegments', () => {
  it('defaults to equities only', () => {
    expect(parseSegments(undefined)).toEqual(['EQ']);
    expect(parseSegments('')).toEqual(['EQ']);
    expect(parseSegments(' , ')).toEqual(['EQ']);
  });

  it('accepts a comma-separated, case-insensitive list', () => {
    expect(parseSegments(' eq, FNO ')).toEqual(['EQ', 'FNO']);
  });

  it('refuses an unknown segment rather than silently indexing nothing', () => {
    expect(() => parseSegments('EQ,BONDS')).toThrow(/unknown segment 'BONDS'/);
  });
});
