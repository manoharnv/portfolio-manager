import { describe, expect, it } from 'vitest';
import type { CanonicalSymbol, OrderType, Product, Validity } from './domain.js';
import { UnsupportedMappingError } from './errors.js';
import {
  EXCHANGE_SEGMENT_TABLE,
  ORDER_TYPE_TABLE,
  PRODUCT_TABLE,
  VALIDITY_TABLE,
  fromDhanExchangeSegment,
  fromDhanOrderType,
  fromDhanProduct,
  fromDhanValidity,
  fromKiteExchangeSegment,
  fromKiteOrderType,
  fromKiteProduct,
  fromKiteValidity,
  isProductSupported,
  toDhanExchangeSegment,
  toDhanOrderType,
  toDhanProduct,
  toDhanValidity,
  toKiteExchangeSegment,
  toKiteOrderType,
  toKiteProduct,
  toKiteValidity,
} from './mapping.js';

describe('product table (docs/02 §2.5)', () => {
  it('matches the spec table exactly', () => {
    expect(PRODUCT_TABLE).toEqual({
      DELIVERY: { dhan: 'CNC', kite: 'CNC' },
      INTRADAY: { dhan: 'INTRADAY', kite: 'MIS' },
      MARGIN: { dhan: 'MARGIN', kite: 'NRML' },
      MTF: { dhan: 'MTF', kite: null },
    });
  });

  it.each(Object.keys(PRODUCT_TABLE) as Product[])('maps %s to Dhan and back', (product) => {
    const code = toDhanProduct(product);
    expect(code).toBe(PRODUCT_TABLE[product].dhan);
    expect(fromDhanProduct(code)).toBe(product);
  });

  it.each((Object.keys(PRODUCT_TABLE) as Product[]).filter((p) => p !== 'MTF'))(
    'maps %s to Kite and back',
    (product) => {
      const code = toKiteProduct(product);
      expect(code).toBe(PRODUCT_TABLE[product].kite);
      expect(fromKiteProduct(code)).toBe(product);
    },
  );

  it('throws for MTF on Kite instead of returning undefined', () => {
    expect(() => toKiteProduct('MTF')).toThrow(UnsupportedMappingError);
    expect(() => toKiteProduct('MTF')).toThrow('kite does not support product=MTF');
    expect(isProductSupported('kite', 'MTF')).toBe(false);
    expect(isProductSupported('dhan', 'MTF')).toBe(true);
  });

  it('throws for unrecognised broker codes', () => {
    expect(() => fromDhanProduct('MIS')).toThrow(UnsupportedMappingError);
    expect(() => fromKiteProduct('INTRADAY')).toThrow(UnsupportedMappingError);
    expect(() => fromKiteProduct('MTF')).toThrow(/Unrecognised kite product code: MTF/);
  });
});

describe('order type table (docs/02 §2.5)', () => {
  it('matches the spec table exactly', () => {
    expect(ORDER_TYPE_TABLE).toEqual({
      MARKET: { dhan: 'MARKET', kite: 'MARKET' },
      LIMIT: { dhan: 'LIMIT', kite: 'LIMIT' },
      SL: { dhan: 'STOP_LOSS', kite: 'SL' },
      'SL-M': { dhan: 'STOP_LOSS_MARKET', kite: 'SL-M' },
    });
  });

  it.each(Object.keys(ORDER_TYPE_TABLE) as OrderType[])('round-trips %s on both brokers', (t) => {
    expect(toDhanOrderType(t)).toBe(ORDER_TYPE_TABLE[t].dhan);
    expect(fromDhanOrderType(toDhanOrderType(t))).toBe(t);
    expect(toKiteOrderType(t)).toBe(ORDER_TYPE_TABLE[t].kite);
    expect(fromKiteOrderType(toKiteOrderType(t))).toBe(t);
  });

  it('does not confuse Dhan and Kite stop-loss codes', () => {
    expect(() => fromKiteOrderType('STOP_LOSS')).toThrow(UnsupportedMappingError);
    expect(() => fromDhanOrderType('SL')).toThrow(UnsupportedMappingError);
    expect(() => fromDhanOrderType('SL-M')).toThrow(UnsupportedMappingError);
  });
});

describe('exchange segment table (docs/02 §2.5)', () => {
  it('matches the spec table exactly', () => {
    expect(EXCHANGE_SEGMENT_TABLE).toEqual([
      { exchange: 'NSE', segment: 'EQ', dhan: 'NSE_EQ', kite: 'NSE' },
      { exchange: 'BSE', segment: 'EQ', dhan: 'BSE_EQ', kite: 'BSE' },
      { exchange: 'NSE', segment: 'FNO', dhan: 'NSE_FNO', kite: 'NFO' },
      { exchange: 'MCX', segment: 'COMMODITY', dhan: 'MCX_COMM', kite: 'MCX' },
    ]);
  });

  it.each(EXCHANGE_SEGMENT_TABLE)('round-trips $exchange/$segment on both brokers', (row) => {
    const neutral = { exchange: row.exchange, segment: row.segment };
    expect(toDhanExchangeSegment(neutral)).toBe(row.dhan);
    expect(fromDhanExchangeSegment(row.dhan)).toEqual(neutral);
    expect(toKiteExchangeSegment(neutral)).toBe(row.kite);
    expect(fromKiteExchangeSegment(row.kite)).toEqual(neutral);
  });

  it('accepts a CanonicalSymbol directly', () => {
    const symbol: CanonicalSymbol = { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'RELIANCE' };
    expect(toDhanExchangeSegment(symbol)).toBe('NSE_EQ');
    expect(toKiteExchangeSegment(symbol)).toBe('NSE');
  });

  it.each([
    { exchange: 'BSE', segment: 'FNO' },
    { exchange: 'NSE', segment: 'CURRENCY' },
    { exchange: 'MCX', segment: 'EQ' },
    { exchange: 'BSE', segment: 'COMMODITY' },
  ] as const)('throws for the unsupported combination %j', (combo) => {
    expect(() => toDhanExchangeSegment(combo)).toThrow(UnsupportedMappingError);
    expect(() => toKiteExchangeSegment(combo)).toThrow(UnsupportedMappingError);
  });

  it('throws for unknown broker codes', () => {
    expect(() => fromDhanExchangeSegment('NSE')).toThrow(UnsupportedMappingError);
    expect(() => fromKiteExchangeSegment('NSE_EQ')).toThrow(UnsupportedMappingError);
    expect(() => fromKiteExchangeSegment('BFO')).toThrow(UnsupportedMappingError);
  });
});

describe('validity table (docs/02 §2.5)', () => {
  it('matches the spec table exactly', () => {
    expect(VALIDITY_TABLE).toEqual({
      DAY: { dhan: 'DAY', kite: 'DAY' },
      IOC: { dhan: 'IOC', kite: 'IOC' },
    });
  });

  it.each(Object.keys(VALIDITY_TABLE) as Validity[])('round-trips %s on both brokers', (v) => {
    expect(toDhanValidity(v)).toBe(VALIDITY_TABLE[v].dhan);
    expect(fromDhanValidity(toDhanValidity(v))).toBe(v);
    expect(toKiteValidity(v)).toBe(VALIDITY_TABLE[v].kite);
    expect(fromKiteValidity(toKiteValidity(v))).toBe(v);
  });

  it('throws for unknown validity codes', () => {
    expect(() => fromDhanValidity('GTT')).toThrow(UnsupportedMappingError);
    expect(() => fromKiteValidity('TTL')).toThrow(UnsupportedMappingError);
  });
});

describe('unknown neutral values', () => {
  it('throw rather than silently defaulting', () => {
    expect(() => toDhanProduct('CNC' as Product)).toThrow(UnsupportedMappingError);
    expect(() => toKiteProduct('MIS' as Product)).toThrow(UnsupportedMappingError);
    expect(() => toDhanOrderType('STOP_LOSS' as OrderType)).toThrow(UnsupportedMappingError);
    expect(() => toKiteOrderType('SLM' as OrderType)).toThrow(UnsupportedMappingError);
    expect(() => toDhanValidity('GTC' as Validity)).toThrow(UnsupportedMappingError);
    expect(() => toKiteValidity('GTC' as Validity)).toThrow(UnsupportedMappingError);
    expect(isProductSupported('dhan', 'FUTURES' as Product)).toBe(false);
  });
});
