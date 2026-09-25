/**
 * The DhanHQ v2 wire layer — docs/02 §2.6.
 *
 * Everything Dhan-shaped lives in this file: URLs, headers, request bodies and
 * response decoding. The adapter above it deals only in neutral domain types, so
 * a Dhan field name can never leak past `adapter.ts` (docs/02 §2.1).
 *
 * Response decoding goes through zod: lenient about *extra* fields (Dhan adds
 * them without notice — `z.looseObject` keeps them, and `raw` keeps the whole
 * payload for the audit trail) and strict about the handful of fields we base
 * money decisions on. A missing required field throws; it never yields a
 * half-filled domain object.
 *
 * Lines marked `VERIFY-LIVE` are wire-level assumptions to confirm against the
 * real API in Phase 1; they are listed together in the adapter's handover notes.
 */

import {
  fromDhanExchangeSegment,
  fromDhanProduct,
  symbolKey,
  type Candle,
  type CanonicalSymbol,
  type Exchange,
  type Funds,
  type Holding,
  type OrderAck,
  type OrderStatus,
  type OrderStatusCode,
  type Position,
  type Product,
  type Quote,
  type Side,
} from '@pm/core';
import { z } from 'zod';
import { dhanHttpError, dhanParseError } from './errors.js';
import type { HttpRequest, HttpResponse } from './http.js';

export const DHAN_BASE_URL = 'https://api.dhan.co/v2';

/**
 * VERIFY-LIVE: docs/02 §2.6 specifies `dhanClientId` as the client header. The
 * DhanHQ market-data (`/marketfeed/*`) docs name it `client-id`. Confirm which
 * endpoints want which, then flip this constant (or split the builder).
 */
export const DHAN_CLIENT_ID_HEADER = 'dhanClientId';

export interface DhanWireContext {
  baseUrl: string;
  clientId: string;
  accessToken: string;
}

/** `access-token` + `dhanClientId` + JSON content type (docs/02 §2.6). */
export function dhanHeaders(
  ctx: Pick<DhanWireContext, 'accessToken' | 'clientId'>,
): Record<string, string> {
  return {
    'access-token': ctx.accessToken,
    [DHAN_CLIENT_ID_HEADER]: ctx.clientId,
    'Content-Type': 'application/json',
  };
}

const url = (ctx: DhanWireContext, path: string): string => `${ctx.baseUrl}${path}`;

// ---------------------------------------------------------------------------
// Decoding helpers
// ---------------------------------------------------------------------------

function issuesToText(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ');
}

/** JSON-decode a body, or throw a typed parse error carrying the raw text. */
export function decodeJson(res: HttpResponse, context: string): unknown {
  if (res.bodyText.trim().length === 0) {
    throw dhanParseError(context, 'empty response body', res.bodyText);
  }
  try {
    return JSON.parse(res.bodyText) as unknown;
  } catch (err) {
    throw dhanParseError(
      context,
      `body is not JSON (${err instanceof Error ? err.message : String(err)})`,
      res.bodyText,
    );
  }
}

/**
 * Non-2xx ⇒ classified `BrokerError`. Dhan also answers 200 with
 * `{"status":"failed", "remarks":{…}}` on some order paths, so that envelope is
 * treated as a failure too.
 * VERIFY-LIVE: confirm which endpoints use the `status:"failed"` envelope.
 */
export function ensureOk(res: HttpResponse, context: string): void {
  if (res.status < 200 || res.status >= 300) {
    throw dhanHttpError(res, context);
  }
  if (/"status"\s*:\s*"(failed|failure|error)"/i.test(res.bodyText)) {
    throw dhanHttpError(res, context);
  }
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw dhanParseError(context, issuesToText(result.error), value);
  }
  return result.data;
}

const NumberLike = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'number' ? v : Number(v.trim())))
  .refine((n) => Number.isFinite(n), { message: 'expected a finite number' });

const StringLike = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => s.length > 0, { message: 'expected a non-empty string' });

function firstNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const n = Number(value.trim());
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Time. Dhan reports IST wall-clock without an offset; we attach one rather than
// letting the host timezone decide (docs/00 §0.5 — nothing reads the clock).
// ---------------------------------------------------------------------------

export const IST_OFFSET = '+05:30';

const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const YMD_HMS = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const DMY_HMS = /^(\d{2})\/(\d{2})\/(\d{4})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const YMD_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Dhan timestamp ⇒ ISO-8601 with an explicit offset.
 * Accepts `YYYY-MM-DD HH:mm:ss`, `DD/MM/YYYY HH:mm:ss`, a bare date, and
 * anything already carrying a timezone.
 * VERIFY-LIVE: confirm the format of `createTime` / `updateTime` /
 * `exchangeTime` / `last_trade_time` on live payloads.
 */
export function dhanTimeToIso(value: string, context: string): string {
  const text = value.trim();
  if (ISO_WITH_TZ.test(text)) return text.replace(' ', 'T');

  const ymd = YMD_HMS.exec(text);
  if (ymd !== null) {
    return `${ymd[1]}-${ymd[2]}-${ymd[3]}T${ymd[4]}:${ymd[5]}:${ymd[6] ?? '00'}${IST_OFFSET}`;
  }
  const dmy = DMY_HMS.exec(text);
  if (dmy !== null) {
    return `${dmy[3]}-${dmy[2]}-${dmy[1]}T${dmy[4]}:${dmy[5]}:${dmy[6] ?? '00'}${IST_OFFSET}`;
  }
  const date = YMD_ONLY.exec(text);
  if (date !== null) {
    return `${date[1]}-${date[2]}-${date[3]}T00:00:00${IST_OFFSET}`;
  }
  throw dhanParseError(context, `unrecognised timestamp ${JSON.stringify(value)}`, value);
}

/**
 * Chart timestamps are epoch **seconds**.
 * VERIFY-LIVE: confirm the epoch is UNIX/UTC — Dhan's binary feed uses a
 * different base, and a silent 10-year shift would poison every backtest.
 */
export function epochSecondsToIso(seconds: number, context: string): string {
  if (!Number.isFinite(seconds) || Math.abs(seconds) > 4_102_444_800) {
    throw dhanParseError(context, `implausible epoch seconds ${String(seconds)}`, seconds);
  }
  return new Date(seconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface DhanPlaceOrderBody {
  dhanClientId: string;
  correlationId: string;
  transactionType: Side;
  exchangeSegment: string;
  productType: string;
  orderType: string;
  validity: string;
  securityId: string;
  quantity: number;
  disclosedQuantity: number;
  price: number;
  triggerPrice: number;
}

export interface DhanModifyOrderBody {
  dhanClientId: string;
  orderId: string;
  orderType: string;
  validity: string;
  quantity?: number | undefined;
  price?: number | undefined;
  triggerPrice?: number | undefined;
  disclosedQuantity?: number | undefined;
  legName?: string | undefined;
}

export function buildPlaceOrderRequest(
  ctx: DhanWireContext,
  body: DhanPlaceOrderBody,
): HttpRequest {
  return {
    method: 'POST',
    url: url(ctx, '/orders'),
    headers: dhanHeaders(ctx),
    body: JSON.stringify(body),
  };
}

export function buildModifyOrderRequest(
  ctx: DhanWireContext,
  brokerOrderId: string,
  body: DhanModifyOrderBody,
): HttpRequest {
  return {
    method: 'PUT',
    url: url(ctx, `/orders/${encodeURIComponent(brokerOrderId)}`),
    headers: dhanHeaders(ctx),
    body: JSON.stringify(body),
  };
}

export function buildCancelOrderRequest(ctx: DhanWireContext, brokerOrderId: string): HttpRequest {
  return {
    method: 'DELETE',
    url: url(ctx, `/orders/${encodeURIComponent(brokerOrderId)}`),
    headers: dhanHeaders(ctx),
  };
}

export function buildGetOrderRequest(ctx: DhanWireContext, brokerOrderId: string): HttpRequest {
  return {
    method: 'GET',
    url: url(ctx, `/orders/${encodeURIComponent(brokerOrderId)}`),
    headers: dhanHeaders(ctx),
  };
}

export function buildListOrdersRequest(ctx: DhanWireContext): HttpRequest {
  return { method: 'GET', url: url(ctx, '/orders'), headers: dhanHeaders(ctx) };
}

/**
 * Dhan order states ⇒ neutral `OrderStatusCode`.
 * An unrecognised state maps to `UNKNOWN`, which callers must treat as
 * "may or may not have executed" (docs/02 §2.1) — it is never coerced to a
 * terminal state.
 * VERIFY-LIVE: confirm the full state list, especially `TRANSIT` vs `PENDING`.
 */
export const DHAN_ORDER_STATUS_MAP: Readonly<Record<string, OrderStatusCode>> = {
  TRANSIT: 'SUBMITTED',
  PENDING: 'OPEN',
  OPEN: 'OPEN',
  CONFIRM: 'OPEN',
  MODIFIED: 'OPEN',
  TRIGGERED: 'OPEN',
  PART_TRADED: 'PARTIAL',
  PARTIALLY_TRADED: 'PARTIAL',
  TRADED: 'COMPLETE',
  EXECUTED: 'COMPLETE',
  COMPLETE: 'COMPLETE',
  CANCELLED: 'CANCELLED',
  CANCELED: 'CANCELLED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
};

export function mapDhanOrderStatus(code: string | undefined): OrderStatusCode {
  if (code === undefined) return 'UNKNOWN';
  return DHAN_ORDER_STATUS_MAP[code.trim().toUpperCase()] ?? 'UNKNOWN';
}

const OrderAckSchema = z.looseObject({
  orderId: StringLike,
  orderStatus: z.string().optional(),
});

/** `{orderId, orderStatus}` ⇒ `OrderAck`. Used by place / modify / cancel. */
export function parseOrderAckResponse(res: HttpResponse, context: string): OrderAck {
  ensureOk(res, context);
  const raw = decodeJson(res, context);
  // Some deployments wrap the ack in `{data:{…}}`.
  // VERIFY-LIVE: confirm whether the ack is bare or wrapped.
  const body =
    typeof raw === 'object' && raw !== null && 'data' in raw && !('orderId' in raw)
      ? (raw as { data: unknown }).data
      : raw;
  const parsed = parseWith(OrderAckSchema, body, context);
  return {
    brokerOrderId: parsed.orderId,
    status: mapDhanOrderStatus(parsed.orderStatus),
    raw,
  };
}

const OrderRowSchema = z.looseObject({
  orderId: StringLike,
  orderStatus: z.string().optional(),
  quantity: NumberLike.optional(),
  filledQty: NumberLike.optional(),
  tradedQty: NumberLike.optional(),
  remainingQuantity: NumberLike.optional(),
  averageTradedPrice: NumberLike.optional(),
  omsErrorDescription: z.string().optional(),
  omsErrorCode: z.string().optional(),
  updateTime: z.string().optional(),
  createTime: z.string().optional(),
  exchangeTime: z.string().optional(),
});

function toOrderStatus(row: z.infer<typeof OrderRowSchema>, context: string): OrderStatus {
  const record = row as unknown as Record<string, unknown>;
  const filledQty = firstNumber(record, ['filledQty', 'tradedQty', 'filled_qty']) ?? 0;
  const quantity = row.quantity ?? 0;
  const pendingQty = row.remainingQuantity ?? Math.max(quantity - filledQty, 0);
  const stamp = firstString(record, ['updateTime', 'exchangeTime', 'createTime']);
  if (stamp === undefined) {
    throw dhanParseError(context, 'order has no updateTime/exchangeTime/createTime', row);
  }
  const avgPrice = row.averageTradedPrice;
  const rejection = firstString(record, ['omsErrorDescription', 'omsErrorCode']);

  const out: OrderStatus = {
    brokerOrderId: row.orderId,
    status: mapDhanOrderStatus(row.orderStatus),
    filledQty,
    pendingQty,
    updatedAt: dhanTimeToIso(stamp, context),
    raw: row,
  };
  if (avgPrice !== undefined && avgPrice > 0) out.avgPrice = avgPrice;
  if (rejection !== undefined) out.rejectionReason = rejection;
  return out;
}

/**
 * `GET /v2/orders/{id}`.
 * VERIFY-LIVE: Dhan has documented this as both a bare object and a
 * single-element array; both are accepted here.
 */
export function parseOrderResponse(res: HttpResponse, context: string): OrderStatus {
  ensureOk(res, context);
  const raw = decodeJson(res, context);
  const body = Array.isArray(raw) ? raw[0] : raw;
  if (body === undefined) {
    throw dhanParseError(context, 'empty order list for a single-order lookup', raw);
  }
  return toOrderStatus(parseWith(OrderRowSchema, body, context), context);
}

/** `GET /v2/orders` — the day's order book. */
export function parseOrderListResponse(res: HttpResponse, context: string): OrderStatus[] {
  ensureOk(res, context);
  const raw = decodeJson(res, context);
  if (!Array.isArray(raw)) {
    throw dhanParseError(context, 'expected a JSON array of orders', raw);
  }
  const rows = parseWith(z.array(OrderRowSchema), raw, context);
  return rows.map((row) => toOrderStatus(row, context));
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

export function buildHoldingsRequest(ctx: DhanWireContext): HttpRequest {
  return { method: 'GET', url: url(ctx, '/holdings'), headers: dhanHeaders(ctx) };
}

export function buildPositionsRequest(ctx: DhanWireContext): HttpRequest {
  return { method: 'GET', url: url(ctx, '/positions'), headers: dhanHeaders(ctx) };
}

export function buildFundsRequest(ctx: DhanWireContext): HttpRequest {
  return { method: 'GET', url: url(ctx, '/fundlimit'), headers: dhanHeaders(ctx) };
}

/**
 * A holding/position as Dhan reports it. `lastPrice` is optional because the
 * portfolio endpoints do not reliably carry one; the adapter fills it from a
 * market-quote snapshot and refuses to report a valuation it had to invent.
 */
export interface DhanHoldingRow {
  symbol: CanonicalSymbol;
  securityId: string;
  exchangeSegment: string;
  quantity: number;
  avgCostPrice: number;
  lastPrice?: number | undefined;
  raw: unknown;
}

export interface DhanPositionRow {
  symbol: CanonicalSymbol;
  securityId: string;
  exchangeSegment: string;
  netQty: number;
  product: Product;
  avgPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  lastPrice?: number | undefined;
  raw: unknown;
}

const HoldingSchema = z.looseObject({
  tradingSymbol: StringLike,
  securityId: StringLike,
  exchange: z.string().optional(),
  exchangeSegment: z.string().optional(),
  totalQty: NumberLike.optional(),
  availableQty: NumberLike.optional(),
  avgCostPrice: NumberLike,
});

/**
 * Holdings are demat-level, and Dhan reports `exchange: "ALL"` for them.
 * VERIFY-LIVE: confirm the `exchange` values; `ALL`/absent is treated as this
 * exchange, which is safe for equities (same symbol both venues) but must be
 * checked before any BSE-only scrip is traded.
 */
export const DEFAULT_HOLDING_EXCHANGE: Exchange = 'NSE';

export interface HoldingParseOptions {
  defaultExchange?: Exchange | undefined;
}

export function parseHoldingsResponse(
  res: HttpResponse,
  context: string,
  opts: HoldingParseOptions = {},
): DhanHoldingRow[] {
  ensureOk(res, context);
  const raw = decodeJson(res, context);
  if (!Array.isArray(raw)) {
    throw dhanParseError(context, 'expected a JSON array of holdings', raw);
  }
  const fallback = opts.defaultExchange ?? DEFAULT_HOLDING_EXCHANGE;
  return parseWith(z.array(HoldingSchema), raw, context).map((row) => {
    const record = row as unknown as Record<string, unknown>;
    const exchange = (row.exchange ?? '').trim().toUpperCase();
    const exchangeSegment =
      row.exchangeSegment !== undefined && row.exchangeSegment.trim().length > 0
        ? row.exchangeSegment.trim().toUpperCase()
        : exchange === '' || exchange === 'ALL'
          ? `${fallback}_EQ`
          : `${exchange}_EQ`;
    const neutral = fromDhanExchangeSegment(exchangeSegment);
    const quantity = row.totalQty ?? row.availableQty;
    if (quantity === undefined) {
      throw dhanParseError(context, `holding ${row.tradingSymbol} has no quantity field`, row);
    }
    const out: DhanHoldingRow = {
      symbol: { ...neutral, tradingSymbol: row.tradingSymbol },
      securityId: row.securityId,
      exchangeSegment,
      quantity,
      avgCostPrice: row.avgCostPrice,
      raw: row,
    };
    const ltp = firstNumber(record, ['lastTradedPrice', 'lastPrice', 'ltp']);
    if (ltp !== undefined) out.lastPrice = ltp;
    return out;
  });
}

const PositionSchema = z.looseObject({
  tradingSymbol: StringLike,
  securityId: StringLike,
  exchangeSegment: StringLike,
  productType: StringLike,
  netQty: NumberLike,
  costPrice: NumberLike.optional(),
  buyAvg: NumberLike.optional(),
  realizedProfit: NumberLike.optional(),
  unrealizedProfit: NumberLike.optional(),
});

export function parsePositionsResponse(res: HttpResponse, context: string): DhanPositionRow[] {
  ensureOk(res, context);
  const raw = decodeJson(res, context);
  if (!Array.isArray(raw)) {
    throw dhanParseError(context, 'expected a JSON array of positions', raw);
  }
  return parseWith(z.array(PositionSchema), raw, context).map((row) => {
    const record = row as unknown as Record<string, unknown>;
    const exchangeSegment = row.exchangeSegment.toUpperCase();
    const neutral = fromDhanExchangeSegment(exchangeSegment);
    const avgPrice = row.costPrice ?? row.buyAvg;
    if (avgPrice === undefined) {
      throw dhanParseError(context, `position ${row.tradingSymbol} has no cost price`, row);
    }
    const out: DhanPositionRow = {
      symbol: { ...neutral, tradingSymbol: row.tradingSymbol },
      securityId: row.securityId,
      exchangeSegment,
      netQty: row.netQty,
      product: fromDhanProduct(row.productType.toUpperCase()),
      avgPrice,
      realizedPnl: row.realizedProfit ?? 0,
      unrealizedPnl: row.unrealizedProfit ?? 0,
      raw: row,
    };
    const ltp = firstNumber(record, ['lastTradedPrice', 'lastPrice', 'ltp']);
    if (ltp !== undefined) out.lastPrice = ltp;
    return out;
  });
}

/** Holding P&L is derived, not reported: `(ltp − avg cost) × qty`. */
export function toHolding(row: DhanHoldingRow, lastPrice: number): Holding {
  return {
    symbol: row.symbol,
    quantity: row.quantity,
    avgCostPrice: row.avgCostPrice,
    lastPrice,
    pnl: (lastPrice - row.avgCostPrice) * row.quantity,
    raw: row.raw,
  };
}

export function toPosition(row: DhanPositionRow, lastPrice: number): Position {
  return {
    symbol: row.symbol,
    netQty: row.netQty,
    product: row.product,
    avgPrice: row.avgPrice,
    lastPrice,
    realizedPnl: row.realizedPnl,
    unrealizedPnl: row.unrealizedPnl,
    raw: row.raw,
  };
}

const FundsSchema = z.looseObject({
  availabelBalance: NumberLike.optional(), // Dhan's spelling. VERIFY-LIVE.
  availableBalance: NumberLike.optional(),
  utilizedAmount: NumberLike.optional(),
  withdrawableBalance: NumberLike.optional(),
});

/**
 * `GET /v2/fundlimit`.
 * `availableMargin` is what `runGuardrails` checks an order against, so it is
 * mapped from Dhan's available balance — the number that can actually fund a
 * new trade. `availableCash` is the withdrawable subset.
 * VERIFY-LIVE: the field is spelled `availabelBalance` in Dhan's docs; confirm
 * the live spelling and whether `withdrawableBalance` is always present.
 */
export function parseFundsResponse(res: HttpResponse, context: string): Funds {
  ensureOk(res, context);
  const raw = decodeJson(res, context);
  const parsed = parseWith(FundsSchema, raw, context);
  const available = parsed.availabelBalance ?? parsed.availableBalance;
  if (available === undefined) {
    throw dhanParseError(context, 'no availabelBalance/availableBalance field', raw);
  }
  if (parsed.utilizedAmount === undefined) {
    throw dhanParseError(context, 'no utilizedAmount field', raw);
  }
  return {
    availableCash: parsed.withdrawableBalance ?? available,
    usedMargin: parsed.utilizedAmount,
    availableMargin: available,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

export interface DhanChartBody {
  securityId: string;
  exchangeSegment: string;
  instrument: string;
  expiryCode?: number | undefined;
  oi: boolean;
  fromDate: string;
  toDate: string;
  /** Intraday only: `"1" | "5" | "15" | "25" | "60"` minutes. */
  interval?: string | undefined;
}

export function buildHistoricalChartRequest(
  ctx: DhanWireContext,
  body: DhanChartBody,
): HttpRequest {
  return {
    method: 'POST',
    url: url(ctx, '/charts/historical'),
    headers: dhanHeaders(ctx),
    body: JSON.stringify(body),
  };
}

export function buildIntradayChartRequest(ctx: DhanWireContext, body: DhanChartBody): HttpRequest {
  return {
    method: 'POST',
    url: url(ctx, '/charts/intraday'),
    headers: dhanHeaders(ctx),
    body: JSON.stringify(body),
  };
}

const ChartSchema = z.looseObject({
  open: z.array(NumberLike),
  high: z.array(NumberLike),
  low: z.array(NumberLike),
  close: z.array(NumberLike),
  volume: z.array(NumberLike),
  timestamp: z.array(NumberLike).optional(),
  start_Time: z.array(NumberLike).optional(),
});

/**
 * Columnar OHLCV ⇒ `Candle[]`. Ragged columns are a hard error: silently
 * truncating would misalign price and time.
 */
export function parseChartsResponse(res: HttpResponse, context: string): Candle[] {
  ensureOk(res, context);
  const raw = decodeJson(res, context);
  const body =
    typeof raw === 'object' && raw !== null && 'data' in raw
      ? (raw as { data: unknown }).data
      : raw;
  const parsed = parseWith(ChartSchema, body, context);
  const stamps = parsed.timestamp ?? parsed.start_Time;
  if (stamps === undefined) {
    throw dhanParseError(context, 'no timestamp/start_Time column', body);
  }
  const n = stamps.length;
  const columns: [string, number[]][] = [
    ['open', parsed.open],
    ['high', parsed.high],
    ['low', parsed.low],
    ['close', parsed.close],
    ['volume', parsed.volume],
  ];
  for (const [name, column] of columns) {
    if (column.length !== n) {
      throw dhanParseError(
        context,
        `ragged chart columns: ${name} has ${column.length} values, timestamp has ${n}`,
        body,
      );
    }
  }
  const candles: Candle[] = [];
  for (let i = 0; i < n; i += 1) {
    candles.push({
      ts: epochSecondsToIso(stamps[i] as number, context),
      open: parsed.open[i] as number,
      high: parsed.high[i] as number,
      low: parsed.low[i] as number,
      close: parsed.close[i] as number,
      volume: parsed.volume[i] as number,
    });
  }
  return candles;
}

// ---------------------------------------------------------------------------
// Market quote snapshot
// ---------------------------------------------------------------------------

/**
 * `POST /v2/marketfeed/quote` — the full snapshot (LTP + OHLC + volume), which
 * is what the neutral `Quote` needs. Body is `{ "<segment>": [<securityId>…] }`.
 * VERIFY-LIVE: confirm security ids may be sent as numbers and the 1000-symbol
 * per-request cap.
 */
export function buildMarketQuoteRequest(
  ctx: DhanWireContext,
  bySegment: Record<string, number[]>,
): HttpRequest {
  return {
    method: 'POST',
    url: url(ctx, '/marketfeed/quote'),
    headers: dhanHeaders(ctx),
    body: JSON.stringify(bySegment),
  };
}

/** `${exchangeSegment}:${securityId}` — the identity a quote response is keyed by. */
export const quoteKey = (exchangeSegment: string, securityId: string): string =>
  `${exchangeSegment}:${securityId}`;

const QuoteRowSchema = z.looseObject({
  last_price: NumberLike,
  volume: NumberLike.optional(),
  last_trade_time: z.string().optional(),
  ohlc: z.looseObject({
    open: NumberLike,
    high: NumberLike,
    low: NumberLike,
    close: NumberLike,
  }),
});

const QuoteResponseSchema = z.looseObject({
  data: z.record(z.string(), z.record(z.string(), z.unknown())),
});

/**
 * Last traded prices only, keyed by {@link quoteKey}. Used to fill the LTP the
 * portfolio endpoints omit; deliberately looser than {@link parseMarketQuoteResponse}
 * because a valuation needs a price but not a trade time.
 */
export function parseLastPrices(res: HttpResponse, context: string): Map<string, number> {
  ensureOk(res, context);
  const raw = decodeJson(res, context);
  const parsed = parseWith(QuoteResponseSchema, raw, context);
  const out = new Map<string, number>();
  for (const [segment, rows] of Object.entries(parsed.data)) {
    for (const [securityId, row] of Object.entries(rows)) {
      if (typeof row !== 'object' || row === null) continue;
      const ltp = firstNumber(row as Record<string, unknown>, ['last_price', 'ltp', 'lastPrice']);
      if (ltp !== undefined) out.set(quoteKey(segment, securityId), ltp);
    }
  }
  return out;
}

/**
 * Response ⇒ `Quote[]`, in the order of `index`. A symbol Dhan did not answer
 * for is omitted rather than zero-filled; a quote with no trade time is an
 * error, because a `Quote` with an invented `ts` would defeat the staleness
 * guardrail.
 */
export function parseMarketQuoteResponse(
  res: HttpResponse,
  context: string,
  index: ReadonlyMap<string, CanonicalSymbol>,
): Quote[] {
  ensureOk(res, context);
  const raw = decodeJson(res, context);
  const parsed = parseWith(QuoteResponseSchema, raw, context);
  const out: Quote[] = [];
  for (const [key, symbol] of index) {
    const [segment, securityId] = key.split(':') as [string, string];
    const row = parsed.data[segment]?.[securityId];
    if (row === undefined) continue;
    const quote = parseWith(QuoteRowSchema, row, `${context} (${symbolKey(symbol)})`);
    if (quote.last_trade_time === undefined) {
      throw dhanParseError(
        `${context} (${symbolKey(symbol)})`,
        'quote has no last_trade_time; refusing to stamp it with the local clock',
        row,
      );
    }
    out.push({
      symbol,
      ltp: quote.last_price,
      open: quote.ohlc.open,
      high: quote.ohlc.high,
      low: quote.ohlc.low,
      close: quote.ohlc.close,
      volume: quote.volume ?? 0,
      ts: dhanTimeToIso(quote.last_trade_time, context),
    });
  }
  return out;
}
