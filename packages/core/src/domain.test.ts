import { describe, expect, it } from 'vitest';
import { parseSymbolKey, symbolKey, type CanonicalSymbol } from './domain.js';

describe('symbolKey', () => {
  it('joins exchange, segment and trading symbol', () => {
    expect(symbolKey({ exchange: 'NSE', segment: 'EQ', tradingSymbol: 'RELIANCE' })).toBe(
      'NSE:EQ:RELIANCE',
    );
  });

  it('distinguishes the same trading symbol on different exchanges/segments', () => {
    const a: CanonicalSymbol = { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'IDEA' };
    const b: CanonicalSymbol = { exchange: 'BSE', segment: 'EQ', tradingSymbol: 'IDEA' };
    const c: CanonicalSymbol = { exchange: 'NSE', segment: 'FNO', tradingSymbol: 'IDEA' };
    expect(new Set([symbolKey(a), symbolKey(b), symbolKey(c)]).size).toBe(3);
  });

  it('round-trips through parseSymbolKey', () => {
    const sym: CanonicalSymbol = {
      exchange: 'NSE',
      segment: 'FNO',
      tradingSymbol: 'NIFTY24DEC22000CE',
    };
    expect(parseSymbolKey(symbolKey(sym))).toEqual(sym);
  });

  it.each(['', 'NSE', 'NSE:EQ', 'NSE:EQ:', 'NSE:EQ:RELIANCE:EXTRA'])(
    'rejects the malformed key %j',
    (key) => {
      expect(() => parseSymbolKey(key)).toThrow(/Malformed symbolKey/);
    },
  );
});
