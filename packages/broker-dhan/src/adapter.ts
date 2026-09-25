/**
 * `DhanAdapter` — the neutral `BrokerAdapter` over DhanHQ v2 (docs/02 §2.3/§2.6).
 *
 * Shape of the thing:
 *   - every dependency is injected (HTTP, session accessor, instrument master,
 *     clock), so the whole class is unit-testable without a socket or a wall
 *     clock (docs/00 §0.5);
 *   - nothing Dhan-shaped crosses the boundary: bodies are built in `wire.ts`
 *     from core's mapping tables, responses come back as domain types;
 *   - **there is no retry loop.** A `BrokerError` propagates as-is, so
 *     `AUTH_EXPIRED` / `IP_NOT_WHITELISTED` can never be silently re-fired
 *     (docs/02 §2.10). Retry policy belongs to the execution backend, which can
 *     consult `isRetryableError`.
 *
 * `placeOrder` re-validates lot size and tick grid even though core's guardrails
 * already do: it is the last code that runs before money moves, and a rejection
 * here costs nothing while a wrong order costs real rupees.
 */

import {
  BrokerError,
  isMultipleOf,
  symbolKey,
  toDhanExchangeSegment,
  toDhanOrderType,
  toDhanProduct,
  toDhanValidity,
  type BrokerAdapter,
  type Candle,
  type CanonicalSymbol,
  type Exchange,
  type Funds,
  type HistoricalRequest,
  type Holding,
  type InstrumentRef,
  type NormalizedOrder,
  type OrderAck,
  type OrderStatus,
  type Position,
  type Quote,
  type SessionStatus,
} from '@pm/core';
import { describeSession, type DhanSession } from './auth.js';
import { isDhanEmptyResult } from './errors.js';
import type { HttpClient, HttpRequest } from './http.js';
import type { DhanInstrument, DhanInstrumentMaster } from './instruments.js';
import {
  DHAN_BASE_URL,
  buildCancelOrderRequest,
  buildFundsRequest,
  buildGetOrderRequest,
  buildHistoricalChartRequest,
  buildHoldingsRequest,
  buildIntradayChartRequest,
  buildListOrdersRequest,
  buildMarketQuoteRequest,
  buildModifyOrderRequest,
  buildPlaceOrderRequest,
  buildPositionsRequest,
  parseChartsResponse,
  parseFundsResponse,
  parseHoldingsResponse,
  parseLastPrices,
  parseMarketQuoteResponse,
  parseOrderAckResponse,
  parseOrderListResponse,
  parseOrderResponse,
  parsePositionsResponse,
  quoteKey,
  toHolding,
  toPosition,
  type DhanModifyOrderBody,
  type DhanPlaceOrderBody,
  type DhanWireContext,
} from './wire.js';

/**
 * Dhan's order-tag field length.
 * VERIFY-LIVE: confirm the cap. Over-long keys are rejected rather than hashed —
 * nothing in this package persists the full key, so a hash would break the audit
 * trail that makes `idempotencyKey` worth having (contrast docs/02 §2.7, where
 * Kite's 20-char `tag` is a hash *and* the full key is stored in Firestore).
 */
export const DHAN_CORRELATION_ID_MAX_LENGTH = 25;

/** Neutral interval ⇒ Dhan intraday `interval` (minutes). `1d` uses /charts/historical. */
export const DHAN_INTRADAY_INTERVALS: Readonly<Record<string, string>> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
};

export interface DhanAdapterDeps {
  http: HttpClient;
  /** Reads today's session (from Secret Manager in production). */
  session: () => DhanSession;
  instruments: DhanInstrumentMaster;
  clock: () => Date;
  baseUrl?: string | undefined;
  /**
   * Fill the LTP the portfolio endpoints omit from a market-quote snapshot
   * (one extra request). Default `true`; with `false`, a holding without a price
   * is an error rather than a ₹0 valuation.
   */
  enrichPortfolioPrices?: boolean | undefined;
  /** Expiry safety margin for `getSessionStatus`. */
  sessionMarginMs?: number | undefined;
  /** Exchange assumed for demat holdings Dhan reports as `ALL`. */
  defaultHoldingExchange?: Exchange | undefined;
  /** Per-request timeout handed to the HTTP client. */
  timeoutMs?: number | undefined;
}

function invalidOrder(message: string, raw?: unknown): BrokerError {
  // Local, pre-flight refusal: nothing has been sent, so the caller knows the
  // order does not exist at the broker.
  return new BrokerError('UNKNOWN', `Dhan order rejected before sending: ${message}`, raw);
}

/** ISO instant ⇒ Dhan's IST wall-clock strings. */
export function toIstParts(iso: string, context: string): { date: string; time: string } {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new BrokerError('UNKNOWN', `Dhan ${context}: unparseable timestamp ${iso}`, iso);
  }
  const ist = new Date(ms + 5.5 * 60 * 60 * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return {
    date: `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`,
    time: `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`,
  };
}

export class DhanAdapter implements BrokerAdapter {
  readonly broker = 'dhan' as const;

  private readonly deps: DhanAdapterDeps;
  /** Set by the last order-API call; `undefined` until one has been made. */
  private ipOk: boolean | undefined;

  constructor(deps: DhanAdapterDeps) {
    this.deps = deps;
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private ctx(): DhanWireContext {
    const session = this.deps.session();
    return {
      baseUrl: this.deps.baseUrl ?? DHAN_BASE_URL,
      clientId: session.clientId,
      accessToken: session.accessToken,
    };
  }

  private send(req: HttpRequest): ReturnType<HttpClient['request']> {
    const timeoutMs = this.deps.timeoutMs;
    return this.deps.http.request(timeoutMs === undefined ? req : { ...req, timeoutMs });
  }

  /**
   * Wraps an order-API call so `staticIpOk` reflects the last attempt
   * (docs/02 §2.2). Does not swallow, translate or retry anything.
   */
  private async orderCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const out = await fn();
      this.ipOk = true;
      return out;
    } catch (err) {
      if (err instanceof BrokerError && err.kind === 'IP_NOT_WHITELISTED') {
        this.ipOk = false;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Session & instruments
  // -------------------------------------------------------------------------

  /** Derived from the session's expiry against the injected clock — no probe. */
  async getSessionStatus(): Promise<SessionStatus> {
    const status: SessionStatus = describeSession(
      this.deps.session(),
      this.deps.clock(),
      this.deps.sessionMarginMs,
    );
    if (this.ipOk !== undefined) status.staticIpOk = this.ipOk;
    return status;
  }

  // `async` on purpose: an unknown symbol must reject the promise, never throw
  // synchronously out of a method the interface types as `Promise`-returning.
  async resolveInstrument(sym: CanonicalSymbol): Promise<InstrumentRef> {
    return this.deps.instruments.resolve(sym);
  }

  // -------------------------------------------------------------------------
  // Portfolio
  // -------------------------------------------------------------------------

  async getHoldings(): Promise<Holding[]> {
    const ctx = this.ctx();
    const res = await this.send(buildHoldingsRequest(ctx));
    if (isDhanEmptyResult(res)) return []; // Dhan says "No holdings available" as an error
    const rows = parseHoldingsResponse(res, 'holdings', {
      ...(this.deps.defaultHoldingExchange === undefined
        ? {}
        : { defaultExchange: this.deps.defaultHoldingExchange }),
    });
    const prices = await this.lastPrices(rows, 'holdings');
    return rows.map((row) =>
      toHolding(
        row,
        this.priceFor(row.exchangeSegment, row.securityId, row.symbol, prices, row.lastPrice),
      ),
    );
  }

  async getPositions(): Promise<Position[]> {
    const ctx = this.ctx();
    const res = await this.send(buildPositionsRequest(ctx));
    if (isDhanEmptyResult(res)) return [];
    const rows = parsePositionsResponse(res, 'positions');
    const prices = await this.lastPrices(rows, 'positions');
    return rows.map((row) =>
      toPosition(
        row,
        this.priceFor(row.exchangeSegment, row.securityId, row.symbol, prices, row.lastPrice),
      ),
    );
  }

  async getFunds(): Promise<Funds> {
    const res = await this.send(buildFundsRequest(this.ctx()));
    return parseFundsResponse(res, 'funds');
  }

  /** One quote snapshot for every row the portfolio endpoint priced at nothing. */
  private async lastPrices(
    rows: readonly {
      exchangeSegment: string;
      securityId: string;
      lastPrice?: number | undefined;
    }[],
    context: string,
  ): Promise<Map<string, number>> {
    const missing = rows.filter((r) => r.lastPrice === undefined);
    if (missing.length === 0) return new Map();
    if (this.deps.enrichPortfolioPrices === false) return new Map();

    const bySegment: Record<string, number[]> = {};
    for (const row of missing) {
      const id = Number(row.securityId);
      if (!Number.isFinite(id)) continue;
      (bySegment[row.exchangeSegment] ??= []).push(id);
    }
    if (Object.keys(bySegment).length === 0) return new Map();
    const res = await this.send(buildMarketQuoteRequest(this.ctx(), bySegment));
    return parseLastPrices(res, `${context} price enrichment`);
  }

  private priceFor(
    exchangeSegment: string,
    securityId: string,
    symbol: CanonicalSymbol,
    prices: ReadonlyMap<string, number>,
    reported: number | undefined,
  ): number {
    if (reported !== undefined) return reported;
    const found = prices.get(quoteKey(exchangeSegment, securityId));
    if (found === undefined) {
      // Fail closed: a valuation we had to invent is worse than no valuation.
      throw new BrokerError(
        'UNKNOWN',
        `No last traded price for ${symbolKey(symbol)}; refusing to report a ₹0 valuation`,
        { exchangeSegment, securityId },
      );
    }
    return found;
  }

  // -------------------------------------------------------------------------
  // Market data
  // -------------------------------------------------------------------------

  async getQuote(syms: CanonicalSymbol[]): Promise<Quote[]> {
    if (syms.length === 0) return [];
    const bySegment: Record<string, number[]> = {};
    const index = new Map<string, CanonicalSymbol>();
    for (const sym of syms) {
      const row = this.deps.instruments.resolveDhan(sym);
      const id = Number(row.securityId);
      if (!Number.isFinite(id)) {
        throw new BrokerError(
          'INSTRUMENT_UNKNOWN',
          `Dhan securityId for ${symbolKey(sym)} is not numeric: ${row.securityId}`,
          row,
        );
      }
      (bySegment[row.exchangeSegment] ??= []).push(id);
      index.set(quoteKey(row.exchangeSegment, row.securityId), sym);
    }
    const res = await this.send(buildMarketQuoteRequest(this.ctx(), bySegment));
    return parseMarketQuoteResponse(res, 'quote', index);
  }

  async getHistorical(req: HistoricalRequest): Promise<Candle[]> {
    const row = this.deps.instruments.resolveDhan(req.symbol);
    const from = toIstParts(req.from, 'historical');
    const to = toIstParts(req.to, 'historical');
    const ctx = this.ctx();

    if (req.interval === '1d') {
      const body = {
        securityId: row.securityId,
        exchangeSegment: row.exchangeSegment,
        instrument: this.chartInstrument(row),
        expiryCode: row.expiryCode,
        oi: false,
        fromDate: from.date,
        toDate: to.date,
      };
      const res = await this.send(buildHistoricalChartRequest(ctx, body));
      return parseChartsResponse(res, 'historical chart');
    }

    const interval = DHAN_INTRADAY_INTERVALS[req.interval];
    if (interval === undefined) {
      throw new BrokerError('UNKNOWN', `Dhan has no intraday interval for ${req.interval}`, req);
    }
    // VERIFY-LIVE: intraday `fromDate`/`toDate` format — `YYYY-MM-DD HH:mm:ss`
    // IST here; Dhan has also documented a plain date for this endpoint.
    const body = {
      securityId: row.securityId,
      exchangeSegment: row.exchangeSegment,
      instrument: this.chartInstrument(row),
      interval,
      oi: false,
      fromDate: `${from.date} ${from.time}`,
      toDate: `${to.date} ${to.time}`,
    };
    const res = await this.send(buildIntradayChartRequest(ctx, body));
    return parseChartsResponse(res, 'intraday chart');
  }

  /** Dhan's chart `instrument` comes from the scrip master; equities default. */
  private chartInstrument(row: DhanInstrument): string {
    if (row.instrumentType.length > 0) return row.instrumentType;
    if (row.canonical.segment === 'EQ') return 'EQUITY';
    throw new BrokerError(
      'INSTRUMENT_UNKNOWN',
      `Scrip master has no instrument type for ${symbolKey(row.canonical)}; ` +
        'the chart API needs one',
      row,
    );
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  /**
   * Validate against the resolved instrument, build the docs/02 §2.6 body from
   * core's mapping tables, POST once, return the ack. Every refusal below
   * happens before any HTTP call.
   */
  async placeOrder(order: NormalizedOrder, idempotencyKey: string): Promise<OrderAck> {
    const body = this.buildPlaceOrderBody(order, idempotencyKey);
    return this.orderCall(async () => {
      const res = await this.send(buildPlaceOrderRequest(this.ctx(), body));
      return parseOrderAckResponse(res, 'place order');
    });
  }

  /** Exposed for tests and for dry-run previews: the exact body we would send. */
  buildPlaceOrderBody(order: NormalizedOrder, idempotencyKey: string): DhanPlaceOrderBody {
    const key = idempotencyKey.trim();
    if (key.length === 0) {
      throw invalidOrder('idempotencyKey is required (it becomes correlationId)');
    }
    if (key.length > DHAN_CORRELATION_ID_MAX_LENGTH) {
      throw invalidOrder(
        `idempotencyKey is ${key.length} chars; Dhan's correlationId holds ` +
          `${DHAN_CORRELATION_ID_MAX_LENGTH}`,
      );
    }

    const instrument = this.deps.instruments.resolveDhan(order.symbol);
    this.validateQuantity(order, instrument);
    const price = this.validatedPrice(order, instrument);
    const triggerPrice = this.validatedTrigger(order, instrument);

    return {
      dhanClientId: this.deps.session().clientId,
      transactionType: order.side,
      exchangeSegment: toDhanExchangeSegment(order.symbol),
      productType: toDhanProduct(order.product),
      orderType: toDhanOrderType(order.orderType),
      validity: toDhanValidity(order.validity),
      securityId: instrument.securityId,
      quantity: order.quantity,
      price,
      triggerPrice,
      disclosedQuantity: order.disclosedQuantity ?? 0,
      correlationId: key,
    };
  }

  private validateQuantity(order: NormalizedOrder, instrument: DhanInstrument): void {
    if (!Number.isInteger(order.quantity) || order.quantity <= 0) {
      throw invalidOrder(`quantity must be a positive integer, got ${order.quantity}`, order);
    }
    if (!isMultipleOf(order.quantity, instrument.lotSize)) {
      throw invalidOrder(
        `quantity ${order.quantity} is not a multiple of the lot size ` +
          `${instrument.lotSize} for ${symbolKey(order.symbol)}`,
        order,
      );
    }
    const disclosed = order.disclosedQuantity;
    if (disclosed !== undefined) {
      if (!Number.isInteger(disclosed) || disclosed < 0) {
        throw invalidOrder(
          `disclosedQuantity must be a non-negative integer, got ${disclosed}`,
          order,
        );
      }
      if (disclosed > order.quantity) {
        throw invalidOrder(
          `disclosedQuantity ${disclosed} exceeds quantity ${order.quantity}`,
          order,
        );
      }
    }
  }

  private validatedPrice(order: NormalizedOrder, instrument: DhanInstrument): number {
    const needsLimit = order.orderType === 'LIMIT' || order.orderType === 'SL';
    if (!needsLimit) return 0;
    const price = order.limitPrice;
    if (price === undefined || !(price > 0)) {
      throw invalidOrder(`${order.orderType} orders need a positive limitPrice`, order);
    }
    if (!isMultipleOf(price, instrument.tickSize)) {
      throw invalidOrder(
        `limitPrice ${price} is not on the ${instrument.tickSize} tick grid for ` +
          symbolKey(order.symbol),
        order,
      );
    }
    return price;
  }

  private validatedTrigger(order: NormalizedOrder, instrument: DhanInstrument): number {
    const needsTrigger = order.orderType === 'SL' || order.orderType === 'SL-M';
    if (!needsTrigger) return 0;
    const trigger = order.triggerPrice;
    if (trigger === undefined || !(trigger > 0)) {
      throw invalidOrder(`${order.orderType} orders need a positive triggerPrice`, order);
    }
    if (!isMultipleOf(trigger, instrument.tickSize)) {
      throw invalidOrder(
        `triggerPrice ${trigger} is not on the ${instrument.tickSize} tick grid for ` +
          symbolKey(order.symbol),
        order,
      );
    }
    return trigger;
  }

  /**
   * Dhan's modify body carries `orderType` and `validity` unconditionally, so the
   * patch must name them — guessing them from a stale local copy could change the
   * order's type behind the caller's back.
   */
  async modifyOrder(brokerOrderId: string, patch: Partial<NormalizedOrder>): Promise<OrderAck> {
    const body = this.buildModifyOrderBody(brokerOrderId, patch);
    return this.orderCall(async () => {
      const res = await this.send(buildModifyOrderRequest(this.ctx(), brokerOrderId, body));
      return parseOrderAckResponse(res, 'modify order');
    });
  }

  buildModifyOrderBody(
    brokerOrderId: string,
    patch: Partial<NormalizedOrder>,
  ): DhanModifyOrderBody {
    if (brokerOrderId.trim().length === 0) {
      throw invalidOrder('brokerOrderId is required to modify an order');
    }
    if (patch.orderType === undefined || patch.validity === undefined) {
      throw invalidOrder(
        'Dhan requires orderType and validity on every modify; include them in the patch',
        patch,
      );
    }
    // Lot/tick can only be checked when the patch names the instrument.
    const instrument =
      patch.symbol === undefined ? undefined : this.deps.instruments.resolveDhan(patch.symbol);
    if (instrument !== undefined) {
      if (patch.quantity !== undefined && !isMultipleOf(patch.quantity, instrument.lotSize)) {
        throw invalidOrder(
          `quantity ${patch.quantity} is not a multiple of the lot size ${instrument.lotSize}`,
          patch,
        );
      }
      for (const [field, value] of [
        ['limitPrice', patch.limitPrice],
        ['triggerPrice', patch.triggerPrice],
      ] as const) {
        if (value !== undefined && !isMultipleOf(value, instrument.tickSize)) {
          throw invalidOrder(
            `${field} ${value} is not on the ${instrument.tickSize} tick grid`,
            patch,
          );
        }
      }
    }

    const body: DhanModifyOrderBody = {
      dhanClientId: this.deps.session().clientId,
      orderId: brokerOrderId,
      orderType: toDhanOrderType(patch.orderType),
      validity: toDhanValidity(patch.validity),
    };
    if (patch.quantity !== undefined) body.quantity = patch.quantity;
    if (patch.limitPrice !== undefined) body.price = patch.limitPrice;
    if (patch.triggerPrice !== undefined) body.triggerPrice = patch.triggerPrice;
    if (patch.disclosedQuantity !== undefined) body.disclosedQuantity = patch.disclosedQuantity;
    return body;
  }

  async cancelOrder(brokerOrderId: string): Promise<OrderAck> {
    if (brokerOrderId.trim().length === 0) {
      throw invalidOrder('brokerOrderId is required to cancel an order');
    }
    return this.orderCall(async () => {
      const res = await this.send(buildCancelOrderRequest(this.ctx(), brokerOrderId));
      return parseOrderAckResponse(res, 'cancel order');
    });
  }

  async getOrder(brokerOrderId: string): Promise<OrderStatus> {
    if (brokerOrderId.trim().length === 0) {
      throw invalidOrder('brokerOrderId is required to fetch an order');
    }
    const res = await this.send(buildGetOrderRequest(this.ctx(), brokerOrderId));
    return parseOrderResponse(res, 'get order');
  }

  async listOrders(): Promise<OrderStatus[]> {
    const res = await this.send(buildListOrdersRequest(this.ctx()));
    if (isDhanEmptyResult(res)) return []; // an empty order book comes back as an error too
    return parseOrderListResponse(res, 'list orders');
  }
}
