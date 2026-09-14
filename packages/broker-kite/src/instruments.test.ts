import { describe, expect, it } from 'vitest';
import { BrokerError } from '@pm/core';
import { KiteInstrumentMaster, fetchCsv, parseCsv } from './instruments.js';
import {
  BSE_TATASTEEL,
  FakeHttpClient,
  KITE_INSTRUMENTS_CSV,
  MCX_GOLDPETAL,
  NFO_NIFTY_CE,
  NSE_RELIANCE,
  fixedClock,
  makeLoadedInstrumentMaster,
} from './test-utils.js';

describe('parseCsv', () => {
  it('parses a quoted field containing a comma as a single value', () => {
    const rows = parseCsv('a,b,c\n1,"x, y",3\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', '3'],
    ]);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    const rows = parseCsv('name\n"Say ""hi"" now"\n');
    expect(rows).toEqual([['name'], ['Say "hi" now']]);
  });

  it('handles CRLF line endings', () => {
    const rows = parseCsv('a,b\r\n1,2\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles a file with no trailing newline', () => {
    const rows = parseCsv('a,b\n1,2');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('KiteInstrumentMaster', () => {
  it('resolves an NSE equity with its lot size and tick size', () => {
    const master = makeLoadedInstrumentMaster();
    const ref = master.resolve(NSE_RELIANCE);
    expect(ref).toMatchObject({
      broker: 'kite',
      canonical: NSE_RELIANCE,
      brokerInstrumentId: '738561',
      exchangeSegmentCode: 'NSE',
      lotSize: 1,
      tickSize: 0.05,
    });
  });

  it('resolves a BSE equity', () => {
    const ref = makeLoadedInstrumentMaster().resolve(BSE_TATASTEEL);
    expect(ref.exchangeSegmentCode).toBe('BSE');
    expect(ref.brokerInstrumentId).toBe('500400');
  });

  it('resolves an NFO derivative with a >1 lot size', () => {
    const ref = makeLoadedInstrumentMaster().resolve(NFO_NIFTY_CE);
    expect(ref.exchangeSegmentCode).toBe('NFO');
    expect(ref.lotSize).toBe(25);
  });

  it('resolves an MCX commodity with a different tick size', () => {
    const ref = makeLoadedInstrumentMaster().resolve(MCX_GOLDPETAL);
    expect(ref.exchangeSegmentCode).toBe('MCX');
    expect(ref.tickSize).toBe(1);
  });

  it('preserves the quoted-comma name field without corrupting column alignment', () => {
    // If the quoted comma in "Reliance Industries, Ltd." leaked into the next
    // column, `tick_size`/`lot_size` parsing below would be wrong.
    const ref = makeLoadedInstrumentMaster().resolve(NSE_RELIANCE);
    expect(ref.lotSize).toBe(1);
    expect(ref.tickSize).toBe(0.05);
  });

  it('throws BrokerError(INSTRUMENT_UNKNOWN) for a symbol not in the CSV', () => {
    const master = makeLoadedInstrumentMaster();
    const unknown = { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'NOPE' } as const;
    expect(() => master.resolve(unknown)).toThrow(BrokerError);

    let caught: unknown;
    try {
      master.resolve(unknown);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BrokerError);
    expect((caught as BrokerError).kind).toBe('INSTRUMENT_UNKNOWN');
  });

  it('indexes only the requested segments — derivatives are never materialised', () => {
    const master = new KiteInstrumentMaster();
    master.loadFromCsv(KITE_INSTRUMENTS_CSV, new Date('2026-01-13T04:30:00.000Z'), {
      segments: ['EQ'],
    });
    expect(master.size).toBe(2);
    expect(master.has(NSE_RELIANCE)).toBe(true);
    expect(master.has(BSE_TATASTEEL)).toBe(true);
    expect(master.has(NFO_NIFTY_CE)).toBe(false);
    expect(master.has(MCX_GOLDPETAL)).toBe(false);
  });

  it('skips rows on a segment @pm/core has no mapping for, without throwing', () => {
    const master = makeLoadedInstrumentMaster();
    // 5 data rows in the fixture, one of them (CDS) is unmappable.
    expect(master.size).toBe(4);
  });

  it('has() reflects resolvability without throwing', () => {
    const master = makeLoadedInstrumentMaster();
    expect(master.has(NSE_RELIANCE)).toBe(true);
    expect(master.has({ exchange: 'NSE', segment: 'EQ', tradingSymbol: 'NOPE' })).toBe(false);
  });

  it('throws a plain Error when a required column is missing', () => {
    const master = new KiteInstrumentMaster();
    const badCsv = 'instrument_token,tradingsymbol,lot_size,exchange\n1,X,1,NSE\n'; // no tick_size
    expect(() => master.loadFromCsv(badCsv, new Date())).toThrow(/tick_size/);
  });

  it('loads an empty (header-only) CSV to an empty, non-stale master', () => {
    const master = new KiteInstrumentMaster();
    master.loadFromCsv(
      'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n',
      fixedClock()(),
    );
    expect(master.size).toBe(0);
    expect(master.isStale(fixedClock()(), 1)).toBe(false);
  });

  it('loads completely empty input without throwing', () => {
    const master = new KiteInstrumentMaster();
    expect(() => master.loadFromCsv('', fixedClock()())).not.toThrow();
    expect(master.size).toBe(0);
  });

  it('skips a genuinely blank line in the middle of the file', () => {
    const master = new KiteInstrumentMaster();
    const csv =
      'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n' +
      '738561,2885,RELIANCE,RELIANCE,0,,0,0.05,1,EQ,NSE,NSE\n' +
      '\n' +
      '500400,1348,TATASTEEL,TATASTEEL,0,,0,0.05,1,EQ,BSE,BSE\n';
    master.loadFromCsv(csv, fixedClock()());
    expect(master.size).toBe(2);
  });

  describe('isStale', () => {
    it('is stale before the first load', () => {
      expect(new KiteInstrumentMaster().isStale(new Date(), 24 * 60 * 60 * 1000)).toBe(true);
    });

    it('is not stale within maxAgeMs', () => {
      const loadedAt = new Date('2026-01-13T00:00:00.000Z');
      const master = makeLoadedInstrumentMaster(loadedAt);
      const now = new Date(loadedAt.getTime() + 1_000);
      expect(master.isStale(now, 24 * 60 * 60 * 1000)).toBe(false);
    });

    it('is stale once maxAgeMs has elapsed', () => {
      const loadedAt = new Date('2026-01-13T00:00:00.000Z');
      const master = makeLoadedInstrumentMaster(loadedAt);
      const now = new Date(loadedAt.getTime() + 24 * 60 * 60 * 1000 + 1);
      expect(master.isStale(now, 24 * 60 * 60 * 1000)).toBe(true);
    });
  });
});

describe('fetchCsv', () => {
  it('returns the body text on a 200 response', async () => {
    const http = new FakeHttpClient();
    http.enqueue({ status: 200, headers: {}, bodyText: KITE_INSTRUMENTS_CSV });
    const text = await fetchCsv(http, 'https://api.kite.trade/instruments');
    expect(text).toBe(KITE_INSTRUMENTS_CSV);
    expect(http.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://api.kite.trade/instruments',
    });
  });

  it('throws a typed error on a non-2xx status', async () => {
    const http = new FakeHttpClient();
    http.enqueue({ status: 500, headers: {}, bodyText: 'Internal Server Error' });
    await expect(fetchCsv(http, 'https://api.kite.trade/instruments')).rejects.toMatchObject({
      kind: 'UNKNOWN',
    });
  });

  it('maps a transport failure to NETWORK', async () => {
    const http = new FakeHttpClient();
    http.onRequest(() => {
      throw new TypeError('dns failure');
    });
    await expect(fetchCsv(http, 'https://api.kite.trade/instruments')).rejects.toMatchObject({
      kind: 'NETWORK',
    });
  });
});
