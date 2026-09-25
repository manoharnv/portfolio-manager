import { beforeEach, describe, expect, it } from 'vitest';
import { BrokerError } from '@pm/core';
import { SessionUnavailableError } from '../ports/index.js';
import {
  MAX_QUOTE_SYMBOLS,
  createQuotesService,
  parseSymbolKeys,
  type QuotesService,
} from './quotes.js';
import { FakeBrokerAdapter, FakeBrokerGateway } from '../test-utils/fakes.js';
import { INFY, RELIANCE, makeQuote } from '../test-utils/fixtures.js';

describe('parseSymbolKeys', () => {
  it('parses one well-formed key', () => {
    expect(parseSymbolKeys('NSE:EQ:RELIANCE')).toEqual({
      ok: true,
      symbols: [RELIANCE],
    });
  });

  it('parses a comma-separated list, trimming whitespace', () => {
    const result = parseSymbolKeys(' NSE:EQ:RELIANCE , NSE:EQ:INFY ');
    expect(result).toEqual({ ok: true, symbols: [RELIANCE, INFY] });
  });

  it('ignores empty entries from trailing or doubled commas', () => {
    expect(parseSymbolKeys('NSE:EQ:RELIANCE,,')).toEqual({ ok: true, symbols: [RELIANCE] });
  });

  it('accepts a derivative trading symbol', () => {
    const result = parseSymbolKeys('NSE:FNO:NIFTY24DEC22000CE');
    expect(result).toMatchObject({
      ok: true,
      symbols: [{ exchange: 'NSE', segment: 'FNO', tradingSymbol: 'NIFTY24DEC22000CE' }],
    });
  });

  it('accepts every exchange and segment core knows', () => {
    expect(parseSymbolKeys('BSE:EQ:TCS,MCX:COMMODITY:GOLD,NSE:CURRENCY:USDINR')).toMatchObject({
      ok: true,
    });
  });

  it('rejects a lower-cased key rather than guessing at the instrument', () => {
    expect(parseSymbolKeys('nse:eq:reliance')).toMatchObject({ ok: false });
    expect(parseSymbolKeys('NSE:eq:RELIANCE')).toMatchObject({ ok: false });
  });

  it('rejects a key with a missing segment', () => {
    const result = parseSymbolKeys('NSE:RELIANCE');
    expect(result).toMatchObject({ ok: false });
    expect((result as { detail: string }).detail).toMatch(/EXCHANGE:SEGMENT:TRADINGSYMBOL/);
  });

  it('rejects extra segments, unknown exchanges and empty trading symbols', () => {
    expect(parseSymbolKeys('NSE:EQ:RELIANCE:X')).toMatchObject({ ok: false });
    expect(parseSymbolKeys('NASDAQ:EQ:AAPL')).toMatchObject({ ok: false });
    expect(parseSymbolKeys('NSE:OPTIONS:X')).toMatchObject({ ok: false });
    expect(parseSymbolKeys('NSE:EQ:')).toMatchObject({ ok: false });
  });

  it('rejects an empty list', () => {
    expect(parseSymbolKeys('')).toMatchObject({ ok: false });
    expect(parseSymbolKeys('  ,  ')).toMatchObject({ ok: false });
  });

  it('accepts exactly 20 symbols and rejects 21', () => {
    const key = (i: number): string => `NSE:EQ:SYM${i}`;
    const twenty = Array.from({ length: MAX_QUOTE_SYMBOLS }, (_, i) => key(i)).join(',');
    expect(parseSymbolKeys(twenty)).toMatchObject({ ok: true });

    const twentyOne = Array.from({ length: MAX_QUOTE_SYMBOLS + 1 }, (_, i) => key(i)).join(',');
    const result = parseSymbolKeys(twentyOne);
    expect(result).toMatchObject({ ok: false });
    expect((result as { detail: string }).detail).toMatch(/at most 20/);
  });
});

interface Harness {
  service: QuotesService;
  adapter: FakeBrokerAdapter;
  broker: FakeBrokerGateway;
}

function harness(): Harness {
  const adapter = new FakeBrokerAdapter({
    quotes: [makeQuote({ symbol: RELIANCE, ltp: 2951 }), makeQuote({ symbol: INFY, ltp: 1610 })],
  });
  const broker = new FakeBrokerGateway(adapter);
  return { service: createQuotesService({ broker }), adapter, broker };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('getQuotes', () => {
  it('returns the adapter’s quotes for the parsed symbols', async () => {
    const result = await h.service.getQuotes('u1', 'NSE:EQ:RELIANCE,NSE:EQ:INFY');

    expect(result).toMatchObject({ ok: true });
    const quotes = (result as { quotes: { ltp: number }[] }).quotes;
    expect(quotes.map((q) => q.ltp)).toEqual([2951, 1610]);
  });

  it('reports malformed input without ever reaching the broker', async () => {
    // The gateway would throw if it were consulted, so an INVALID_PAYLOAD here
    // proves parsing happens first.
    h.broker.error = new SessionUnavailableError('dhan', 'should not be reached');
    expect(await h.service.getQuotes('u1', 'nse:eq:reliance')).toMatchObject({
      ok: false,
      reason: 'INVALID_PAYLOAD',
    });
  });

  it('reports a missing session', async () => {
    h.broker.error = new SessionUnavailableError('dhan', 'no token');
    expect(await h.service.getQuotes('u1', 'NSE:EQ:RELIANCE')).toMatchObject({
      ok: false,
      reason: 'SESSION_INVALID',
    });
  });

  it('maps AUTH_EXPIRED to a re-login refusal', async () => {
    h.adapter.script.throwOn = { getQuote: new BrokerError('AUTH_EXPIRED', 'token dead') };
    expect(await h.service.getQuotes('u1', 'NSE:EQ:RELIANCE')).toMatchObject({
      ok: false,
      reason: 'SESSION_INVALID',
    });
  });

  it('surfaces a broker failure with its typed kind', async () => {
    h.adapter.script.throwOn = { getQuote: new BrokerError('RATE_LIMITED', 'slow down') };
    expect(await h.service.getQuotes('u1', 'NSE:EQ:RELIANCE')).toEqual({
      ok: false,
      reason: 'BROKER_ERROR',
      detail: 'slow down',
      kind: 'RATE_LIMITED',
    });
  });

  it('maps a plain Error to UNKNOWN', async () => {
    h.adapter.script.throwOn = { getQuote: new Error('kaboom') };
    expect(await h.service.getQuotes('u1', 'NSE:EQ:RELIANCE')).toMatchObject({
      reason: 'BROKER_ERROR',
      kind: 'UNKNOWN',
    });
  });

  it('survives a thrown non-Error without losing the detail', async () => {
    h.adapter.script.throwOn = { getQuote: 'just a string' as unknown as Error };
    expect(await h.service.getQuotes('u1', 'NSE:EQ:RELIANCE')).toEqual({
      ok: false,
      reason: 'BROKER_ERROR',
      detail: 'just a string',
      kind: 'UNKNOWN',
    });
  });
});
