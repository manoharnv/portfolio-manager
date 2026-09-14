import { BrokerError, UnsupportedMappingError, type CanonicalSymbol } from '@pm/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MASTER_MAX_AGE_MS,
  DHAN_SCRIP_MASTER_DETAILED_URL,
  DHAN_SCRIP_MASTER_URL,
  DhanInstrumentMaster,
  fetchCsv,
  parseCsv,
  toExchangeSegmentCode,
} from './instruments.js';
import {
  FakeHttpClient,
  MASTER_LOADED_AT,
  NIFTY_CE,
  RELIANCE,
  RELIANCE_BSE,
  SCRIP_MASTER_CSV,
  SCRIP_MASTER_CSV_NEW_HEADERS,
  UNKNOWN_SYMBOL,
  makeMaster,
  textResponse,
} from './test-utils.js';

describe('parseCsv', () => {
  it('keeps commas inside quoted fields', () => {
    const rows = parseCsv('a,b,c\n1,"two, and a half",3\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', 'two, and a half', '3'],
    ]);
  });

  it('unescapes doubled quotes and keeps newlines inside quotes', () => {
    const rows = parseCsv('a,b\n"say ""hi""","line1\nline2"\n');
    expect(rows[1]).toEqual(['say "hi"', 'line1\nline2']);
  });

  it('handles CRLF, a missing trailing newline and a BOM', () => {
    const rows = parseCsv('﻿a,b\r\n1,2');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('drops blank lines rather than emitting phantom rows', () => {
    expect(parseCsv('a,b\n\n1,2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('preserves empty trailing fields', () => {
    expect(parseCsv('a,b,c\n1,,')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
    ]);
  });
});

describe('toExchangeSegmentCode', () => {
  it('maps the legacy single-letter segments', () => {
    expect(toExchangeSegmentCode('NSE', 'E')).toBe('NSE_EQ');
    expect(toExchangeSegmentCode('BSE', 'E')).toBe('BSE_EQ');
    expect(toExchangeSegmentCode('NSE', 'D')).toBe('NSE_FNO');
    expect(toExchangeSegmentCode('MCX', 'M')).toBe('MCX_COMM');
  });

  it('maps the spelled-out segments and passes a full code through', () => {
    expect(toExchangeSegmentCode('nse', 'equity')).toBe('NSE_EQ');
    expect(toExchangeSegmentCode('NSE', 'derivative')).toBe('NSE_FNO');
    expect(toExchangeSegmentCode('NSE', 'NSE_EQ')).toBe('NSE_EQ');
  });

  it('returns undefined for combinations we do not trade', () => {
    expect(toExchangeSegmentCode('NSE', 'C')).toBeUndefined();
    expect(toExchangeSegmentCode('BSE', 'D')).toBeUndefined();
    expect(toExchangeSegmentCode('MCX', 'E')).toBeUndefined();
    expect(toExchangeSegmentCode('NSE', 'X')).toBeUndefined();
  });
});

describe('DhanInstrumentMaster.loadFromCsv', () => {
  it('indexes the tradeable rows and skips the rest', () => {
    const master = new DhanInstrumentMaster();
    const stats = master.loadFromCsv(SCRIP_MASTER_CSV, MASTER_LOADED_AT);
    expect(stats).toEqual({ rows: 5, indexed: 3, skipped: 2, duplicates: 0 });
    expect(master.size).toBe(3);
    expect(master.loadedAt).toEqual(MASTER_LOADED_AT);
  });

  it('indexes only the requested segments — F&O and currency rows are never materialised', () => {
    const master = new DhanInstrumentMaster();
    const stats = master.loadFromCsv(SCRIP_MASTER_CSV, MASTER_LOADED_AT, { segments: ['EQ'] });
    expect(stats).toEqual({ rows: 5, indexed: 2, skipped: 3, duplicates: 0 });
    expect(master.size).toBe(2);
    expect(master.resolve(RELIANCE)).toMatchObject({ brokerInstrumentId: '11536' });
    expect(() => master.resolve(NIFTY_CE)).toThrow();
  });

  it('resolves the same trading symbol differently per exchange segment', () => {
    const master = makeMaster();
    expect(master.resolve(RELIANCE)).toEqual({
      broker: 'dhan',
      canonical: RELIANCE,
      brokerInstrumentId: '11536',
      exchangeSegmentCode: 'NSE_EQ',
      lotSize: 1,
      tickSize: 0.05,
    });
    expect(master.resolve(RELIANCE_BSE)).toMatchObject({
      brokerInstrumentId: '500325',
      exchangeSegmentCode: 'BSE_EQ',
      tickSize: 0.01,
    });
    expect(master.resolve(NIFTY_CE)).toMatchObject({
      brokerInstrumentId: '46285',
      exchangeSegmentCode: 'NSE_FNO',
      lotSize: 75,
      tickSize: 0.05,
    });
  });

  it('carries the chart-only fields on the Dhan-flavoured row', () => {
    const row = makeMaster().resolveDhan(NIFTY_CE);
    expect(row.instrumentType).toBe('OPTIDX');
    expect(row.expiryCode).toBe(1);
  });

  it('accepts the newer plain header family', () => {
    const master = makeMaster(SCRIP_MASTER_CSV_NEW_HEADERS);
    expect(master.size).toBe(2);
    expect(master.resolve(RELIANCE).brokerInstrumentId).toBe('11536');
  });

  it('applies a tick-size divisor when Dhan reports paise', () => {
    const master = new DhanInstrumentMaster();
    master.loadFromCsv(
      'EXCH_ID,SEGMENT,SECURITY_ID,TRADING_SYMBOL,LOT_SIZE,TICK_SIZE\nNSE,E,11536,RELIANCE,1,5',
      MASTER_LOADED_AT,
      { tickSizeDivisor: 100 },
    );
    expect(master.resolve(RELIANCE).tickSize).toBeCloseTo(0.05, 10);
  });

  it('rejects a nonsensical divisor', () => {
    expect(() =>
      new DhanInstrumentMaster().loadFromCsv(SCRIP_MASTER_CSV, MASTER_LOADED_AT, {
        tickSizeDivisor: 0,
      }),
    ).toThrow(BrokerError);
  });

  it('counts duplicate rows and keeps the first', () => {
    const csv = [
      'EXCH_ID,SEGMENT,SECURITY_ID,TRADING_SYMBOL,LOT_SIZE,TICK_SIZE',
      'NSE,E,11536,RELIANCE,1,0.05',
      'NSE,E,99988,RELIANCE,1,0.05',
    ].join('\n');
    const master = new DhanInstrumentMaster();
    expect(master.loadFromCsv(csv, MASTER_LOADED_AT).duplicates).toBe(1);
    expect(master.resolve(RELIANCE).brokerInstrumentId).toBe('11536');
  });

  it('throws on an empty file or a missing required column', () => {
    const master = new DhanInstrumentMaster();
    expect(() => master.loadFromCsv('', MASTER_LOADED_AT)).toThrow(/CSV is empty/);
    expect(() => master.loadFromCsv('A,B\n1,2', MASTER_LOADED_AT)).toThrow(
      /missing required column/,
    );
  });

  it('replaces the previous contents on reload', () => {
    const master = makeMaster();
    const later = new Date(MASTER_LOADED_AT.getTime() + 86_400_000);
    master.loadFromCsv(SCRIP_MASTER_CSV_NEW_HEADERS, later);
    expect(master.size).toBe(2);
    expect(master.loadedAt).toEqual(later);
    expect(() => master.resolve(RELIANCE_BSE)).toThrow(BrokerError);
  });

  it('does not index a row whose tick size is unusable', () => {
    // BADTICK is in the fixture with tickSize 0: it must resolve as UNKNOWN
    // rather than as an instrument every limit price fails against.
    const badTick: CanonicalSymbol = { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'BADTICK' };
    expect(() => makeMaster().resolve(badTick)).toThrow(/No Dhan instrument/);
  });

  it('skips a row whose segment core cannot map back', () => {
    // `NSE_FNO` is mappable; a hand-forged `MCX_EQ` is not.
    const master = new DhanInstrumentMaster();
    const stats = master.loadFromCsv(
      'EXCH_ID,SEGMENT,SECURITY_ID,TRADING_SYMBOL,LOT_SIZE,TICK_SIZE\nMCX,MCX_EQ,1,GOLD,1,1',
      MASTER_LOADED_AT,
    );
    expect(stats).toMatchObject({ rows: 1, indexed: 0, skipped: 1 });
  });
});

describe('DhanInstrumentMaster.resolve', () => {
  it('throws INSTRUMENT_UNKNOWN for a symbol that is not in the file', () => {
    const err = (() => {
      try {
        makeMaster().resolve(UNKNOWN_SYMBOL);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BrokerError);
    expect((err as BrokerError).kind).toBe('INSTRUMENT_UNKNOWN');
    expect((err as BrokerError).message).toContain('NSE:EQ:NOTLISTED');
  });

  it('throws INSTRUMENT_UNKNOWN before it is loaded (fail closed)', () => {
    const master = new DhanInstrumentMaster();
    expect(master.size).toBe(0);
    try {
      master.resolve(RELIANCE);
      expect.unreachable('resolve must throw');
    } catch (err) {
      expect((err as BrokerError).kind).toBe('INSTRUMENT_UNKNOWN');
      expect((err as BrokerError).message).toContain('not loaded');
    }
  });

  it("propagates core's mapping error for an unsupported neutral segment", () => {
    const master = makeMaster();
    expect(() =>
      master.resolve({ exchange: 'NSE', segment: 'CURRENCY', tradingSymbol: 'USDINR24DECFUT' }),
    ).toThrow(UnsupportedMappingError);
  });
});

describe('DhanInstrumentMaster.isStale', () => {
  const loaded = MASTER_LOADED_AT.getTime();

  it('is stale when never loaded', () => {
    expect(new DhanInstrumentMaster().isStale(MASTER_LOADED_AT)).toBe(true);
  });

  it('is fresh up to the boundary and stale past it', () => {
    const master = makeMaster();
    expect(master.isStale(new Date(loaded + DEFAULT_MASTER_MAX_AGE_MS))).toBe(false);
    expect(master.isStale(new Date(loaded + DEFAULT_MASTER_MAX_AGE_MS + 1))).toBe(true);
    expect(master.isStale(new Date(loaded + 60_000), 60_000)).toBe(false);
    expect(master.isStale(new Date(loaded + 60_001), 60_000)).toBe(true);
  });
});

describe('fetchCsv', () => {
  it('GETs the scrip master and returns the text', async () => {
    const http = new FakeHttpClient(textResponse(200, SCRIP_MASTER_CSV));
    const csv = await fetchCsv(http);
    expect(csv).toBe(SCRIP_MASTER_CSV);
    expect(http.last).toEqual({
      method: 'GET',
      url: DHAN_SCRIP_MASTER_URL,
      headers: { Accept: 'text/csv' },
    });
  });

  it('accepts an override url (e.g. the detailed file)', async () => {
    const http = new FakeHttpClient(textResponse(200, SCRIP_MASTER_CSV));
    await fetchCsv(http, DHAN_SCRIP_MASTER_DETAILED_URL);
    expect(http.last.url).toBe(DHAN_SCRIP_MASTER_DETAILED_URL);
  });

  it('throws a typed error on a non-2xx and on an empty body', async () => {
    await expect(
      fetchCsv(new FakeHttpClient(textResponse(404, 'not found'))),
    ).rejects.toBeInstanceOf(BrokerError);
    await expect(fetchCsv(new FakeHttpClient(textResponse(200, '   ')))).rejects.toThrow(
      /empty body/,
    );
  });
});
