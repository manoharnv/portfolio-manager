/**
 * Broker-neutral domain model — docs/02-broker-abstraction.md §2.2.
 *
 * No Dhan/Kite field names may leak past the adapter boundary; everything
 * upstream (strategy engine, execution backend, mobile app) speaks these types.
 *
 * NOTE (deviation from the spec text, deliberate): optional fields are declared
 * `?: T | undefined` rather than `?: T`. Under `exactOptionalPropertyTypes` the
 * narrower `?: T` form is *not* assignable from a zod-inferred `?: T | undefined`,
 * which would make `schemas.ts` and `domain.ts` describe incompatible shapes.
 * Semantics are unchanged; the property is still optional.
 */

export type Broker = 'dhan' | 'kite';
export type Exchange = 'NSE' | 'BSE' | 'MCX';
export type Segment = 'EQ' | 'FNO' | 'CURRENCY' | 'COMMODITY';

export interface CanonicalSymbol {
  exchange: Exchange;
  segment: Segment;
  /** e.g. "RELIANCE", "NIFTY24DEC22000CE" */
  tradingSymbol: string;
}

/** Opaque, broker-specific instrument handle produced by resolveInstrument(). */
export interface InstrumentRef {
  broker: Broker;
  canonical: CanonicalSymbol;
  /** Dhan securityId | Kite instrument_token */
  brokerInstrumentId: string;
  /** Dhan "NSE_EQ" | Kite "NSE" */
  exchangeSegmentCode: string;
  lotSize: number;
  tickSize: number;
}

export type Side = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
/** Neutral product names; mapped to broker codes in `mapping.ts`. */
export type Product = 'DELIVERY' | 'INTRADAY' | 'MARGIN' | 'MTF';
export type Validity = 'DAY' | 'IOC';

export interface NormalizedOrder {
  symbol: CanonicalSymbol;
  side: Side;
  /** In units; the adapter validates against lotSize. */
  quantity: number;
  orderType: OrderType;
  product: Product;
  validity: Validity;
  /** Required for LIMIT / SL. */
  limitPrice?: number | undefined;
  /** Required for SL / SL-M. */
  triggerPrice?: number | undefined;
  disclosedQuantity?: number | undefined;
}

export type OrderStatusCode =
  'SUBMITTED' | 'OPEN' | 'PARTIAL' | 'COMPLETE' | 'CANCELLED' | 'REJECTED' | 'EXPIRED' | 'UNKNOWN';

export interface OrderAck {
  brokerOrderId: string;
  /** Usually 'SUBMITTED' at ack time. */
  status: OrderStatusCode;
  /** Broker response, kept verbatim for audit. */
  raw: unknown;
}

export interface OrderStatus {
  brokerOrderId: string;
  status: OrderStatusCode;
  filledQty: number;
  pendingQty: number;
  avgPrice?: number | undefined;
  rejectionReason?: string | undefined;
  /** ISO 8601 */
  updatedAt: string;
  raw: unknown;
}

export interface Holding {
  symbol: CanonicalSymbol;
  quantity: number;
  avgCostPrice: number;
  lastPrice: number;
  pnl: number;
  raw: unknown;
}

export interface Position {
  symbol: CanonicalSymbol;
  netQty: number;
  product: Product;
  avgPrice: number;
  lastPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  raw: unknown;
}

export interface Funds {
  availableCash: number;
  usedMargin: number;
  availableMargin: number;
  raw: unknown;
}

export interface Quote {
  symbol: CanonicalSymbol;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** ISO 8601 */
  ts: string;
}

export interface Candle {
  /** ISO 8601 */
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface HistoricalRequest {
  symbol: CanonicalSymbol;
  interval: '1m' | '5m' | '15m' | '1h' | '1d';
  /** ISO 8601 */
  from: string;
  /** ISO 8601 */
  to: string;
}

export interface SessionStatus {
  broker: Broker;
  connected: boolean;
  /** ISO 8601; broker token expiry. */
  expiresAt?: string | undefined;
  /** Last order-API call was not IP-rejected. */
  staticIpOk?: boolean | undefined;
}

/**
 * Stable identity for an instrument across the whole system:
 * `${exchange}:${segment}:${tradingSymbol}` — also the Firestore doc id for the
 * cached portfolio read model (docs/03 §3.6).
 */
export function symbolKey(sym: CanonicalSymbol): string {
  return `${sym.exchange}:${sym.segment}:${sym.tradingSymbol}`;
}

/** Inverse of {@link symbolKey}. Throws on a malformed key. */
export function parseSymbolKey(key: string): CanonicalSymbol {
  const parts = key.split(':');
  if (parts.length !== 3) {
    throw new Error(`Malformed symbolKey: ${JSON.stringify(key)}`);
  }
  const [exchange, segment, tradingSymbol] = parts as [string, string, string];
  if (tradingSymbol.length === 0) {
    throw new Error(`Malformed symbolKey: ${JSON.stringify(key)}`);
  }
  return {
    exchange: exchange as Exchange,
    segment: segment as Segment,
    tradingSymbol,
  };
}
