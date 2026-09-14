/**
 * Neutral enum ⇆ broker code mapping tables — docs/02-broker-abstraction.md §2.5.
 *
 * Every lookup is total in one direction and throws {@link UnsupportedMappingError}
 * otherwise. Nothing here returns `undefined`: a missing mapping must never
 * degrade into a default order attribute on the wire.
 */

import type { Exchange, OrderType, Product, Segment, Validity } from './domain.js';
import { UnsupportedMappingError } from './errors.js';

export type DhanProduct = 'CNC' | 'INTRADAY' | 'MARGIN' | 'MTF';
export type KiteProduct = 'CNC' | 'MIS' | 'NRML';

export type DhanOrderType = 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'STOP_LOSS_MARKET';
export type KiteOrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';

export type DhanExchangeSegment = 'NSE_EQ' | 'BSE_EQ' | 'NSE_FNO' | 'MCX_COMM';
export type KiteExchange = 'NSE' | 'BSE' | 'NFO' | 'MCX';

export type DhanValidity = 'DAY' | 'IOC';
export type KiteValidity = 'DAY' | 'IOC';

/** A neutral (exchange, segment) pair — `CanonicalSymbol` satisfies this. */
export interface ExchangeSegment {
  exchange: Exchange;
  segment: Segment;
}

// ---------------------------------------------------------------------------
// Tables (exported so tests and adapters can iterate every row)
// ---------------------------------------------------------------------------

/** `null` ⇒ the broker has no equivalent and the order must be rejected. */
export const PRODUCT_TABLE: Readonly<
  Record<Product, { dhan: DhanProduct; kite: KiteProduct | null }>
> = {
  DELIVERY: { dhan: 'CNC', kite: 'CNC' },
  INTRADAY: { dhan: 'INTRADAY', kite: 'MIS' },
  MARGIN: { dhan: 'MARGIN', kite: 'NRML' },
  MTF: { dhan: 'MTF', kite: null },
};

export const ORDER_TYPE_TABLE: Readonly<
  Record<OrderType, { dhan: DhanOrderType; kite: KiteOrderType }>
> = {
  MARKET: { dhan: 'MARKET', kite: 'MARKET' },
  LIMIT: { dhan: 'LIMIT', kite: 'LIMIT' },
  SL: { dhan: 'STOP_LOSS', kite: 'SL' },
  'SL-M': { dhan: 'STOP_LOSS_MARKET', kite: 'SL-M' },
};

export const EXCHANGE_SEGMENT_TABLE: readonly {
  exchange: Exchange;
  segment: Segment;
  dhan: DhanExchangeSegment;
  kite: KiteExchange;
}[] = [
  { exchange: 'NSE', segment: 'EQ', dhan: 'NSE_EQ', kite: 'NSE' },
  { exchange: 'BSE', segment: 'EQ', dhan: 'BSE_EQ', kite: 'BSE' },
  { exchange: 'NSE', segment: 'FNO', dhan: 'NSE_FNO', kite: 'NFO' },
  { exchange: 'MCX', segment: 'COMMODITY', dhan: 'MCX_COMM', kite: 'MCX' },
];

export const VALIDITY_TABLE: Readonly<
  Record<Validity, { dhan: DhanValidity; kite: KiteValidity }>
> = {
  DAY: { dhan: 'DAY', kite: 'DAY' },
  IOC: { dhan: 'IOC', kite: 'IOC' },
};

// ---------------------------------------------------------------------------
// Reverse indexes, derived once from the tables above so the two directions can
// never drift apart.
// ---------------------------------------------------------------------------

function invert<T extends string, K extends string>(
  table: Readonly<Record<T, { dhan: unknown; kite: unknown }>>,
  side: 'dhan' | 'kite',
): Map<K, T> {
  const out = new Map<K, T>();
  for (const [neutral, codes] of Object.entries(table) as [T, { dhan: unknown; kite: unknown }][]) {
    const code = codes[side];
    if (typeof code === 'string') {
      out.set(code as K, neutral);
    }
  }
  return out;
}

const DHAN_PRODUCT_REVERSE = invert<Product, DhanProduct>(PRODUCT_TABLE, 'dhan');
const KITE_PRODUCT_REVERSE = invert<Product, KiteProduct>(PRODUCT_TABLE, 'kite');
const DHAN_ORDER_TYPE_REVERSE = invert<OrderType, DhanOrderType>(ORDER_TYPE_TABLE, 'dhan');
const KITE_ORDER_TYPE_REVERSE = invert<OrderType, KiteOrderType>(ORDER_TYPE_TABLE, 'kite');
const DHAN_VALIDITY_REVERSE = invert<Validity, DhanValidity>(VALIDITY_TABLE, 'dhan');
const KITE_VALIDITY_REVERSE = invert<Validity, KiteValidity>(VALIDITY_TABLE, 'kite');

const segmentKey = (es: ExchangeSegment): string => `${es.exchange}:${es.segment}`;
const EXCHANGE_SEGMENT_BY_NEUTRAL = new Map(
  EXCHANGE_SEGMENT_TABLE.map((row) => [segmentKey(row), row] as const),
);
const EXCHANGE_SEGMENT_BY_DHAN = new Map(
  EXCHANGE_SEGMENT_TABLE.map((row) => [row.dhan, row] as const),
);
const EXCHANGE_SEGMENT_BY_KITE = new Map(
  EXCHANGE_SEGMENT_TABLE.map((row) => [row.kite, row] as const),
);

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

export function toDhanProduct(product: Product): DhanProduct {
  const code = PRODUCT_TABLE[product]?.dhan;
  if (code === undefined) {
    throw new UnsupportedMappingError('dhan', 'product', String(product), 'to-broker');
  }
  return code;
}

export function fromDhanProduct(code: string): Product {
  const neutral = DHAN_PRODUCT_REVERSE.get(code as DhanProduct);
  if (neutral === undefined) {
    throw new UnsupportedMappingError('dhan', 'product', code, 'from-broker');
  }
  return neutral;
}

/** Kite has no MTF product — an MTF order targeted at Kite must be rejected. */
export function toKiteProduct(product: Product): KiteProduct {
  const code = PRODUCT_TABLE[product]?.kite;
  if (code === undefined || code === null) {
    throw new UnsupportedMappingError('kite', 'product', String(product), 'to-broker');
  }
  return code;
}

export function fromKiteProduct(code: string): Product {
  const neutral = KITE_PRODUCT_REVERSE.get(code as KiteProduct);
  if (neutral === undefined) {
    throw new UnsupportedMappingError('kite', 'product', code, 'from-broker');
  }
  return neutral;
}

// ---------------------------------------------------------------------------
// Order type
// ---------------------------------------------------------------------------

export function toDhanOrderType(orderType: OrderType): DhanOrderType {
  const code = ORDER_TYPE_TABLE[orderType]?.dhan;
  if (code === undefined) {
    throw new UnsupportedMappingError('dhan', 'orderType', String(orderType), 'to-broker');
  }
  return code;
}

export function fromDhanOrderType(code: string): OrderType {
  const neutral = DHAN_ORDER_TYPE_REVERSE.get(code as DhanOrderType);
  if (neutral === undefined) {
    throw new UnsupportedMappingError('dhan', 'orderType', code, 'from-broker');
  }
  return neutral;
}

export function toKiteOrderType(orderType: OrderType): KiteOrderType {
  const code = ORDER_TYPE_TABLE[orderType]?.kite;
  if (code === undefined) {
    throw new UnsupportedMappingError('kite', 'orderType', String(orderType), 'to-broker');
  }
  return code;
}

export function fromKiteOrderType(code: string): OrderType {
  const neutral = KITE_ORDER_TYPE_REVERSE.get(code as KiteOrderType);
  if (neutral === undefined) {
    throw new UnsupportedMappingError('kite', 'orderType', code, 'from-broker');
  }
  return neutral;
}

// ---------------------------------------------------------------------------
// Exchange segment. Dhan carries one `exchangeSegment` field; Kite splits it and
// only sends `exchange` (the segment is implied by the trading symbol).
// ---------------------------------------------------------------------------

export function toDhanExchangeSegment(es: ExchangeSegment): DhanExchangeSegment {
  const row = EXCHANGE_SEGMENT_BY_NEUTRAL.get(segmentKey(es));
  if (row === undefined) {
    throw new UnsupportedMappingError('dhan', 'exchangeSegment', segmentKey(es), 'to-broker');
  }
  return row.dhan;
}

export function fromDhanExchangeSegment(code: string): ExchangeSegment {
  const row = EXCHANGE_SEGMENT_BY_DHAN.get(code as DhanExchangeSegment);
  if (row === undefined) {
    throw new UnsupportedMappingError('dhan', 'exchangeSegment', code, 'from-broker');
  }
  return { exchange: row.exchange, segment: row.segment };
}

export function toKiteExchangeSegment(es: ExchangeSegment): KiteExchange {
  const row = EXCHANGE_SEGMENT_BY_NEUTRAL.get(segmentKey(es));
  if (row === undefined) {
    throw new UnsupportedMappingError('kite', 'exchangeSegment', segmentKey(es), 'to-broker');
  }
  return row.kite;
}

export function fromKiteExchangeSegment(code: string): ExchangeSegment {
  const row = EXCHANGE_SEGMENT_BY_KITE.get(code as KiteExchange);
  if (row === undefined) {
    throw new UnsupportedMappingError('kite', 'exchangeSegment', code, 'from-broker');
  }
  return { exchange: row.exchange, segment: row.segment };
}

// ---------------------------------------------------------------------------
// Validity
// ---------------------------------------------------------------------------

export function toDhanValidity(validity: Validity): DhanValidity {
  const code = VALIDITY_TABLE[validity]?.dhan;
  if (code === undefined) {
    throw new UnsupportedMappingError('dhan', 'validity', String(validity), 'to-broker');
  }
  return code;
}

export function fromDhanValidity(code: string): Validity {
  const neutral = DHAN_VALIDITY_REVERSE.get(code as DhanValidity);
  if (neutral === undefined) {
    throw new UnsupportedMappingError('dhan', 'validity', code, 'from-broker');
  }
  return neutral;
}

export function toKiteValidity(validity: Validity): KiteValidity {
  const code = VALIDITY_TABLE[validity]?.kite;
  if (code === undefined) {
    throw new UnsupportedMappingError('kite', 'validity', String(validity), 'to-broker');
  }
  return code;
}

export function fromKiteValidity(code: string): Validity {
  const neutral = KITE_VALIDITY_REVERSE.get(code as KiteValidity);
  if (neutral === undefined) {
    throw new UnsupportedMappingError('kite', 'validity', code, 'from-broker');
  }
  return neutral;
}

/** `false` when this neutral product cannot be expressed on that broker at all. */
export function isProductSupported(broker: 'dhan' | 'kite', product: Product): boolean {
  const row = PRODUCT_TABLE[product];
  if (row === undefined) return false;
  return broker === 'dhan' ? row.dhan !== null : row.kite !== null;
}
