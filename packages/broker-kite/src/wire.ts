/**
 * Kite Connect v3 wire layer — docs/02-broker-abstraction.md §2.7.
 *
 * Isolated on purpose: this is the ONLY module that knows Kite's field names,
 * envelope shape, and endpoint paths. It owns mapping in BOTH directions
 * (neutral ⇆ Kite) using `@pm/core`'s mapping tables — `adapter.ts` calls
 * these functions with neutral inputs and gets neutral outputs back; it never
 * touches a Kite field name directly.
 *
 * Every response is parsed with zod: lenient on fields we don't read
 * (`z.looseObject`), strict on fields we do. A malformed response never
 * becomes a partial neutral object — it throws `BrokerError('UNKNOWN', ...)`.
 */

import { z } from 'zod';
import {
  fromKiteExchangeSegment,
  fromKiteProduct,
  toKiteExchangeSegment,
  toKiteOrderType,
  toKiteProduct,
  toKiteValidity,
  BrokerError,
  type CanonicalSymbol,
  type Candle,
  type Funds,
  type HistoricalRequest,
  type Holding,
  type InstrumentRef,
  type NormalizedOrder,
  type OrderAck,
  type OrderStatus,
  type OrderStatusCode,
  type Position,
  type Quote,
} from '@pm/core';
import type { HttpClient, HttpResponse } from './http.js';
import { mapKiteError, mapTransportError } from './errors.js';

export const KITE_BASE_URL = 'https://api.kite.trade';
export const KITE_API_VERSION = '3';

export interface KiteWireContext {
  http: HttpClient;
  apiKey: string;
  accessToken: string;
  /** Overridable for tests; defaults to {@link KITE_BASE_URL} in `adapter.ts`. */
  baseUrl: string;
}

// ---------------------------------------------------------------------------
// Headers & form encoding
// ---------------------------------------------------------------------------

export function buildAuthHeaders(
  apiKey: string,
  accessToken: string,
  opts?: { form?: boolean | undefined },
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `token ${apiKey}:${accessToken}`,
    'X-Kite-Version': KITE_API_VERSION,
  };
  if (opts?.form === true) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  return headers;
}

export type FormValue = string | number | boolean | undefined;

/** `application/x-www-form-urlencoded` encoding, skipping `undefined` values. */
export function formEncode(record: Record<string, FormValue>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

const KiteEnvelopeSchema = z.looseObject({
  status: z.string(),
  data: z.unknown().optional(),
  message: z.string().optional(),
  error_type: z.string().optional(),
});

/**
 * Unwrap Kite's `{status, data}` envelope from an already-received response,
 * throwing a mapped `BrokerError` for `{status:'error', ...}`, a non-2xx HTTP
 * status, a non-JSON body, or a body that doesn't even match the envelope
 * shape. Exported so `auth.ts` (which makes its own unauthenticated request
 * to `/session/token`, outside this file's per-endpoint helpers) can reuse it.
 */
export function parseKiteEnvelope(res: HttpResponse): unknown {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(res.bodyText);
  } catch {
    throw new BrokerError(
      'UNKNOWN',
      `Kite response was not valid JSON (HTTP ${String(res.status)}): ${res.bodyText.slice(0, 200)}`,
      res.bodyText,
    );
  }

  const envelope = KiteEnvelopeSchema.safeParse(parsedJson);
  if (!envelope.success) {
    throw new BrokerError(
      'UNKNOWN',
      `Kite response did not match the expected envelope shape: ${envelope.error.message}`,
      parsedJson,
    );
  }

  if (envelope.data.status !== 'success' || res.status >= 400) {
    throw mapKiteError(
      {
        httpStatus: res.status,
        errorType: envelope.data.error_type,
        message: envelope.data.message,
      },
      parsedJson,
    );
  }

  return envelope.data.data;
}

/**
 * Send a request and unwrap Kite's envelope in one step — the common case for
 * every per-endpoint helper below. Transport failures (fetch threw) are
 * mapped to `BrokerError('NETWORK', ...)` here too.
 */
async function sendAndUnwrap(
  http: HttpClient,
  req: Parameters<HttpClient['request']>[0],
): Promise<unknown> {
  let res;
  try {
    res = await http.request(req);
  } catch (err) {
    throw mapTransportError(err);
  }
  return parseKiteEnvelope(res);
}

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new BrokerError(
      'UNKNOWN',
      `Malformed Kite ${what} response: ${result.error.message}`,
      data,
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Timestamps — Kite mixes "YYYY-MM-DD HH:mm:ss" (IST, no offset) and
// "YYYY-MM-DDTHH:mm:ss+0530" (offset without a colon). Normalise both to a
// proper ISO-8601 string with a colon in the offset.
// VERIFY-LIVE: confirm both raw formats against live responses (quote
// timestamps vs. historical-candle timestamps) — inferred from public docs.
// ---------------------------------------------------------------------------

const SPACE_DATETIME_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const OFFSET_NO_COLON_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-])(\d{2})(\d{2})$/;

function normalizeKiteTimestamp(raw: string): string {
  const spaceMatch = SPACE_DATETIME_RE.exec(raw);
  if (spaceMatch !== null) {
    // Kite's bare "date time" strings are IST wall-clock with no explicit zone.
    return `${spaceMatch[1]}T${spaceMatch[2]}+05:30`;
  }
  const offsetMatch = OFFSET_NO_COLON_RE.exec(raw);
  if (offsetMatch !== null) {
    return `${offsetMatch[1]}${offsetMatch[2]}${offsetMatch[3]}:${offsetMatch[4]}`;
  }
  // Already ISO-ish (has a colon in its offset, or a trailing Z) — pass through.
  return raw;
}

function normalizeKiteTimestampOrThrow(raw: string | null | undefined, what: string): string {
  if (raw === null || raw === undefined || raw.length === 0) {
    throw new BrokerError('UNKNOWN', `Kite ${what} is missing a timestamp we rely on`, raw);
  }
  return normalizeKiteTimestamp(raw);
}

// ---------------------------------------------------------------------------
// Orders — POST /orders/regular, PUT /orders/regular/{id},
// DELETE /orders/regular/{id}, GET /orders/{id}, GET /orders
// ---------------------------------------------------------------------------

const OrderAckDataSchema = z.looseObject({
  order_id: z.string().min(1),
});

/**
 * `resolveInstrument`/lot-tick validation happen in `adapter.ts` before this
 * is called. Mapping calls below (`toKiteProduct` etc.) run before the HTTP
 * request, so an unsupported neutral value (MTF has no Kite product) throws
 * `UnsupportedMappingError` with ZERO HTTP calls made.
 */
export async function placeRegularOrder(
  ctx: KiteWireContext,
  order: NormalizedOrder,
  ref: InstrumentRef,
  tag: string,
): Promise<OrderAck> {
  const kiteProduct = toKiteProduct(order.product);
  const kiteOrderType = toKiteOrderType(order.orderType);
  const kiteValidity = toKiteValidity(order.validity);

  const body = formEncode({
    tradingsymbol: order.symbol.tradingSymbol,
    exchange: ref.exchangeSegmentCode,
    transaction_type: order.side,
    order_type: kiteOrderType,
    quantity: order.quantity,
    product: kiteProduct,
    price: order.limitPrice,
    trigger_price: order.triggerPrice,
    validity: kiteValidity,
    disclosed_quantity: order.disclosedQuantity,
    tag,
  });

  const data = await sendAndUnwrap(ctx.http, {
    method: 'POST',
    url: `${ctx.baseUrl}/orders/regular`,
    headers: buildAuthHeaders(ctx.apiKey, ctx.accessToken, { form: true }),
    body,
  });
  const parsed = parseOrThrow(OrderAckDataSchema, data, 'place-order');
  return { brokerOrderId: parsed.order_id, status: 'SUBMITTED', raw: data };
}

export interface KiteOrderModifyPatch {
  quantity?: number | undefined;
  limitPrice?: number | undefined;
  triggerPrice?: number | undefined;
  disclosedQuantity?: number | undefined;
  orderType?: NormalizedOrder['orderType'] | undefined;
  validity?: NormalizedOrder['validity'] | undefined;
}

/**
 * Kite's modify endpoint only accepts a handful of mutable fields — symbol,
 * exchange, side and product cannot be changed after placement, so a
 * `Partial<NormalizedOrder>` patch carrying them is silently ignored here
 * (Kite would reject an attempt to send them anyway).
 */
export async function modifyRegularOrder(
  ctx: KiteWireContext,
  brokerOrderId: string,
  patch: KiteOrderModifyPatch,
): Promise<OrderAck> {
  const body = formEncode({
    quantity: patch.quantity,
    price: patch.limitPrice,
    trigger_price: patch.triggerPrice,
    disclosed_quantity: patch.disclosedQuantity,
    order_type: patch.orderType !== undefined ? toKiteOrderType(patch.orderType) : undefined,
    validity: patch.validity !== undefined ? toKiteValidity(patch.validity) : undefined,
  });

  const data = await sendAndUnwrap(ctx.http, {
    method: 'PUT',
    url: `${ctx.baseUrl}/orders/regular/${encodeURIComponent(brokerOrderId)}`,
    headers: buildAuthHeaders(ctx.apiKey, ctx.accessToken, { form: true }),
    body,
  });
  const parsed = parseOrThrow(OrderAckDataSchema, data, 'modify-order');
  return { brokerOrderId: parsed.order_id, status: 'SUBMITTED', raw: data };
}

export async function cancelRegularOrder(
  ctx: KiteWireContext,
  brokerOrderId: string,
): Promise<OrderAck> {
  const data = await sendAndUnwrap(ctx.http, {
    method: 'DELETE',
    url: `${ctx.baseUrl}/orders/regular/${encodeURIComponent(brokerOrderId)}`,
    headers: buildAuthHeaders(ctx.apiKey, ctx.accessToken),
  });
  const parsed = parseOrThrow(OrderAckDataSchema, data, 'cancel-order');
  return { brokerOrderId: parsed.order_id, status: 'CANCELLED', raw: data };
}

// One order entry, as returned both by GET /orders (current state) and as an
// element of the GET /orders/{id} history array.
const KiteOrderEntrySchema = z.looseObject({
  order_id: z.string().min(1),
  status: z.string(),
  filled_quantity: z.number(),
  pending_quantity: z.number(),
  average_price: z.number().nullable().optional(),
  // VERIFY-LIVE: confirm the exact rejection-message field name (Kite docs
  // and live payloads have used both `status_message` and `status_message_raw`).
  status_message: z.string().nullable().optional(),
  order_timestamp: z.string().nullable().optional(),
  exchange_update_timestamp: z.string().nullable().optional(),
  exchange_timestamp: z.string().nullable().optional(),
});
type KiteOrderEntry = z.infer<typeof KiteOrderEntrySchema>;

/**
 * Kite order-status strings beyond the obvious terminal ones (`COMPLETE`,
 * `REJECTED`, `CANCELLED`) are a long tail of transient states
 * (`OPEN PENDING`, `VALIDATION PENDING`, `MODIFY PENDING`, `TRIGGER PENDING`,
 * `PUT ORDER REQ RECEIVED`, ...). We fold every "*PENDING*" / receipt state
 * into `SUBMITTED`; anything neither recognised nor pending fails closed to
 * `UNKNOWN` rather than being guessed as `OPEN`.
 * VERIFY-LIVE: confirm this list against live order events, especially
 * whether `TRIGGER PENDING` should surface as OPEN (current choice) or its
 * own state, and whether EXPIRED is ever actually emitted for regular orders.
 */
function mapKiteOrderStatus(raw: string, filledQty: number, pendingQty: number): OrderStatusCode {
  const status = raw.toUpperCase();
  if (status === 'COMPLETE') return 'COMPLETE';
  if (status === 'REJECTED') return 'REJECTED';
  if (status === 'CANCELLED') return 'CANCELLED';
  if (status === 'EXPIRED') return 'EXPIRED';
  if (status === 'OPEN' || status === 'TRIGGER PENDING') {
    return filledQty > 0 && pendingQty > 0 ? 'PARTIAL' : 'OPEN';
  }
  if (status.includes('PENDING') || status === 'PUT ORDER REQ RECEIVED') return 'SUBMITTED';
  return 'UNKNOWN';
}

function toOrderStatus(entry: KiteOrderEntry): OrderStatus {
  const updatedAtRaw =
    entry.exchange_update_timestamp ?? entry.exchange_timestamp ?? entry.order_timestamp;
  return {
    brokerOrderId: entry.order_id,
    status: mapKiteOrderStatus(entry.status, entry.filled_quantity, entry.pending_quantity),
    filledQty: entry.filled_quantity,
    pendingQty: entry.pending_quantity,
    avgPrice: entry.average_price ?? undefined,
    rejectionReason: entry.status_message ?? undefined,
    updatedAt: normalizeKiteTimestampOrThrow(updatedAtRaw, 'order timestamp'),
    raw: entry,
  };
}

/** `GET /orders/{order_id}` returns the order's full history; use the latest entry. */
export async function fetchOrderHistory(
  ctx: KiteWireContext,
  brokerOrderId: string,
): Promise<OrderStatus> {
  const data = await sendAndUnwrap(ctx.http, {
    method: 'GET',
    url: `${ctx.baseUrl}/orders/${encodeURIComponent(brokerOrderId)}`,
    headers: buildAuthHeaders(ctx.apiKey, ctx.accessToken),
  });
  const history = parseOrThrow(z.array(KiteOrderEntrySchema), data, 'order-history');
  const latest = history[history.length - 1];
  if (latest === undefined) {
    throw new BrokerError(
      'UNKNOWN',
      `Kite returned an empty order history for ${brokerOrderId}`,
      data,
    );
  }
  return toOrderStatus(latest);
}

export async function fetchOrders(ctx: KiteWireContext): Promise<OrderStatus[]> {
  const data = await sendAndUnwrap(ctx.http, {
    method: 'GET',
    url: `${ctx.baseUrl}/orders`,
    headers: buildAuthHeaders(ctx.apiKey, ctx.accessToken),
  });
  const orders = parseOrThrow(z.array(KiteOrderEntrySchema), data, 'order-list');
  return orders.map(toOrderStatus);
}

// ---------------------------------------------------------------------------
// Portfolio — GET /portfolio/holdings, GET /portfolio/positions
// ---------------------------------------------------------------------------

const KiteHoldingEntrySchema = z.looseObject({
  tradingsymbol: z.string().min(1),
  exchange: z.string().min(1),
  quantity: z.number(),
  average_price: z.number(),
  last_price: z.number(),
  pnl: z.number(),
});

export async function fetchHoldings(ctx: KiteWireContext): Promise<Holding[]> {
  const data = await sendAndUnwrap(ctx.http, {
    method: 'GET',
    url: `${ctx.baseUrl}/portfolio/holdings`,
    headers: buildAuthHeaders(ctx.apiKey, ctx.accessToken),
  });
  const holdings = parseOrThrow(z.array(KiteHoldingEntrySchema), data, 'holdings');
  return holdings.map((h) => {
    const { exchange, segment } = fromKiteExchangeSegment(h.exchange);
    return {
      symbol: { exchange, segment, tradingSymbol: h.tradingsymbol },
      // VERIFY-LIVE: confirm whether unsettled T1 quantity (`t1_quantity`)
      // should be folded into this figure for a "total holding" view.
      quantity: h.quantity,
      avgCostPrice: h.average_price,
      lastPrice: h.last_price,
      pnl: h.pnl,
      raw: h,
    };
  });
}

const KitePositionEntrySchema = z.looseObject({
  tradingsymbol: z.string().min(1),
  exchange: z.string().min(1),
  product: z.string().min(1),
  quantity: z.number(),
  average_price: z.number(),
  last_price: z.number(),
  realised: z.number(),
  unrealised: z.number(),
});

const KitePositionsDataSchema = z.looseObject({
  net: z.array(KitePositionEntrySchema),
  day: z.array(KitePositionEntrySchema).optional(),
});

/** `GET /portfolio/positions` returns `{net, day}`; per spec, only `net` is used. */
export async function fetchPositions(ctx: KiteWireContext): Promise<Position[]> {
  const data = await sendAndUnwrap(ctx.http, {
    method: 'GET',
    url: `${ctx.baseUrl}/portfolio/positions`,
    headers: buildAuthHeaders(ctx.apiKey, ctx.accessToken),
  });
  const parsed = parseOrThrow(KitePositionsDataSchema, data, 'positions');
  return parsed.net.map((p) => {
    const { exchange, segment } = fromKiteExchangeSegment(p.exchange);
    return {
      symbol: { exchange, segment, tradingSymbol: p.tradingsymbol },
      netQty: p.quantity,
      product: fromKiteProduct(p.product),
      avgPrice: p.average_price,
      lastPrice: p.last_price,
      realizedPnl: p.realised,
      unrealizedPnl: p.unrealised,
      raw: p,
    };
  });
}

// ---------------------------------------------------------------------------
// Funds — GET /user/margins (equity segment)
// ---------------------------------------------------------------------------

const KiteMarginsDataSchema = z.looseObject({
  equity: z.looseObject({
    net: z.number(),
    available: z.looseObject({ cash: z.number() }),
    utilised: z.looseObject({ debits: z.number() }),
  }),
});

export async function fetchFunds(ctx: KiteWireContext): Promise<Funds> {
  const data = await sendAndUnwrap(ctx.http, {
    method: 'GET',
    url: `${ctx.baseUrl}/user/margins`,
    headers: buildAuthHeaders(ctx.apiKey, ctx.accessToken),
  });
  const parsed = parseOrThrow(KiteMarginsDataSchema, data, 'margins');
  return {
    // VERIFY-LIVE: confirm `equity.available.cash` (vs. `live_balance`) is the
    // right "available cash" figure, and `equity.utilised.debits` (vs. a sum
    // of exposure+span+...) is the right "used margin" figure.
    availableCash: parsed.equity.available.cash,
    usedMargin: parsed.equity.utilised.debits,
    availableMargin: parsed.equity.net,
    raw: data,
  };
}

// ---------------------------------------------------------------------------
// Historical candles — GET /instruments/historical/{token}/{interval}
// ---------------------------------------------------------------------------

const KITE_INTERVAL_MAP: Readonly<Record<HistoricalRequest['interval'], string>> = {
  '1m': 'minute',
  '5m': '5minute',
  '15m': '15minute',
  '1h': '60minute',
  '1d': 'day',
};

export function toKiteInterval(interval: HistoricalRequest['interval']): string {
  return KITE_INTERVAL_MAP[interval];
}

/**
 * Kite's historical `from`/`to` query params are IST wall-clock strings
 * (`yyyy-mm-dd hh:mm:ss`), not the ISO-8601-with-offset strings
 * `HistoricalRequest` carries.
 * VERIFY-LIVE: confirm the exact accepted format (bare date vs. date+time) —
 * inferred from public docs, not exercised against a live account.
 */
export function toKiteDateParam(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new BrokerError('UNKNOWN', `Cannot convert ${iso} to a Kite date parameter`, iso);
  }
  const ist = new Date(ms + IST_OFFSET_MS);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const datePart = `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
  const timePart = `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`;
  return `${datePart} ${timePart}`;
}

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const KiteHistoricalDataSchema = z.looseObject({
  candles: z.array(z.array(z.union([z.string(), z.number()]))),
});

export async function fetchHistoricalCandles(
  ctx: KiteWireContext,
  instrumentToken: string,
  interval: HistoricalRequest['interval'],
  fromIso: string,
  toIso: string,
): Promise<Candle[]> {
  const query = new URLSearchParams({
    from: toKiteDateParam(fromIso),
    to: toKiteDateParam(toIso),
  });
  const data = await sendAndUnwrap(ctx.http, {
    method: 'GET',
    url: `${ctx.baseUrl}/instruments/historical/${encodeURIComponent(instrumentToken)}/${toKiteInterval(interval)}?${query.toString()}`,
    headers: buildAuthHeaders(ctx.apiKey, ctx.accessToken),
  });
  const parsed = parseOrThrow(KiteHistoricalDataSchema, data, 'historical-candles');
  return parsed.candles.map((row, i) => {
    const [ts, open, high, low, close, volume] = row;
    if (
      typeof ts !== 'string' ||
      typeof open !== 'number' ||
      typeof high !== 'number' ||
      typeof low !== 'number' ||
      typeof close !== 'number' ||
      typeof volume !== 'number'
    ) {
      throw new BrokerError('UNKNOWN', `Malformed Kite candle at index ${String(i)}`, row);
    }
    return { ts: normalizeKiteTimestamp(ts), open, high, low, close, volume };
  });
}

// ---------------------------------------------------------------------------
// Quotes — GET /quote?i=NSE:RELIANCE&i=...
// ---------------------------------------------------------------------------

const KiteQuoteEntrySchema = z.looseObject({
  last_price: z.number(),
  volume: z.number(),
  timestamp: z.string().nullable().optional(),
  last_trade_time: z.string().nullable().optional(),
  ohlc: z.looseObject({
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
  }),
});

const KiteQuoteDataSchema = z.record(z.string(), KiteQuoteEntrySchema);

/** Builds the `i=EXCH:SYMBOL` query key for one canonical symbol. */
function kiteQuoteKey(sym: CanonicalSymbol): string {
  return `${toKiteExchangeSegment(sym)}:${sym.tradingSymbol}`;
}

export async function fetchQuotes(
  ctx: KiteWireContext,
  symbols: CanonicalSymbol[],
): Promise<Quote[]> {
  const targets = symbols.map((sym) => ({ sym, key: kiteQuoteKey(sym) }));
  const query = targets.map((t) => `i=${encodeURIComponent(t.key)}`).join('&');
  const data = await sendAndUnwrap(ctx.http, {
    method: 'GET',
    url: `${ctx.baseUrl}/quote?${query}`,
    headers: buildAuthHeaders(ctx.apiKey, ctx.accessToken),
  });
  const parsed = parseOrThrow(KiteQuoteDataSchema, data, 'quote');

  return targets.map(({ sym, key }) => {
    const entry = parsed[key];
    if (entry === undefined) {
      throw new BrokerError('UNKNOWN', `Kite quote response is missing an entry for ${key}`, data);
    }
    const tsRaw = entry.last_trade_time ?? entry.timestamp;
    return {
      symbol: sym,
      ltp: entry.last_price,
      open: entry.ohlc.open,
      high: entry.ohlc.high,
      low: entry.ohlc.low,
      close: entry.ohlc.close,
      volume: entry.volume,
      ts: normalizeKiteTimestampOrThrow(tsRaw, `quote timestamp for ${key}`),
    };
  });
}
