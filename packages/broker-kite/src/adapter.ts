/**
 * `KiteAdapter` — implements `@pm/core`'s `BrokerAdapter` for Zerodha Kite
 * Connect v3 (docs/02-broker-abstraction.md §2.3, §2.7).
 *
 * This class is pure orchestration: instrument resolution, local pre-flight
 * validation (lot size / tick grid), idempotency-key → tag derivation, and
 * session-expiry bookkeeping. Every Kite field name and every neutral⇆Kite
 * mapping call lives in `wire.ts`; this file never spells out a Kite field
 * name itself.
 */

import type {
  BrokerAdapter,
  CanonicalSymbol,
  Candle,
  Funds,
  HistoricalRequest,
  Holding,
  InstrumentRef,
  NormalizedOrder,
  OrderAck,
  OrderStatus,
  Position,
  Quote,
  SessionStatus,
} from '@pm/core';
import type { HttpClient } from './http.js';
import type { KiteInstrumentMaster } from './instruments.js';
import { isSessionValid, type KiteSession } from './auth.js';
import { kiteTagFor } from './tag.js';
import { OrderValidationError } from './errors.js';
import {
  KITE_BASE_URL,
  cancelRegularOrder,
  fetchFunds,
  fetchHistoricalCandles,
  fetchHoldings,
  fetchOrderHistory,
  fetchOrders,
  fetchPositions,
  fetchQuotes,
  modifyRegularOrder,
  placeRegularOrder,
  type KiteWireContext,
} from './wire.js';

export interface KiteAdapterDeps {
  http: HttpClient;
  /** Returns the current session on every call — never cached by the adapter. */
  session: () => KiteSession;
  instruments: KiteInstrumentMaster;
  /** Injected "now" — see docs/00-dev-conventions.md §0.5. Never `Date.now()` internally. */
  clock: () => Date;
  baseUrl?: string | undefined;
}

function isOnTickGrid(price: number, tickSize: number): boolean {
  if (tickSize <= 0) return true;
  const ratio = price / tickSize;
  const nearest = Math.round(ratio);
  return Math.abs(ratio - nearest) < 1e-6;
}

/** Throws `OrderValidationError` — never silently rounds or clamps. */
function validateOrderAgainstInstrument(order: NormalizedOrder, ref: InstrumentRef): void {
  if (order.quantity % ref.lotSize !== 0) {
    throw new OrderValidationError(
      'LOT_SIZE',
      `quantity ${String(order.quantity)} is not a multiple of lot size ${String(ref.lotSize)} for ${order.symbol.tradingSymbol}`,
    );
  }
  if (order.limitPrice !== undefined && !isOnTickGrid(order.limitPrice, ref.tickSize)) {
    throw new OrderValidationError(
      'TICK_SIZE',
      `limitPrice ${String(order.limitPrice)} is not on the tick grid (tick size ${String(ref.tickSize)}) for ${order.symbol.tradingSymbol}`,
    );
  }
  if (order.triggerPrice !== undefined && !isOnTickGrid(order.triggerPrice, ref.tickSize)) {
    throw new OrderValidationError(
      'TICK_SIZE',
      `triggerPrice ${String(order.triggerPrice)} is not on the tick grid (tick size ${String(ref.tickSize)}) for ${order.symbol.tradingSymbol}`,
    );
  }
}

export class KiteAdapter implements BrokerAdapter {
  readonly broker = 'kite' as const;

  private readonly deps: KiteAdapterDeps;
  private readonly baseUrl: string;

  constructor(deps: KiteAdapterDeps) {
    this.deps = deps;
    this.baseUrl = deps.baseUrl ?? KITE_BASE_URL;
  }

  private ctx(): KiteWireContext {
    const session = this.deps.session();
    return {
      http: this.deps.http,
      apiKey: session.apiKey,
      accessToken: session.accessToken,
      baseUrl: this.baseUrl,
    };
  }

  // Every method below is declared `async` — even the ones that look like a
  // one-line delegation to a wire function — never `return riskyCall()` from
  // a non-async method. `this.ctx()` (session() underneath), instrument
  // resolution and lot/tick validation all do synchronous work that can
  // throw; wrapping the method body in `async` is what turns that throw into
  // a rejected promise instead of a raw exception escaping the call itself.
  // `BrokerReadAdapter`/`BrokerAdapter` methods must never throw synchronously.

  /** Derived from `expiresAt` vs. the injected clock — no network probe. */
  async getSessionStatus(): Promise<SessionStatus> {
    const session = this.deps.session();
    const now = this.deps.clock();
    return {
      broker: 'kite',
      connected: isSessionValid(session, now, 0),
      expiresAt: session.expiresAt,
    };
  }

  async getHoldings(): Promise<Holding[]> {
    return fetchHoldings(this.ctx());
  }

  async getPositions(): Promise<Position[]> {
    return fetchPositions(this.ctx());
  }

  async getFunds(): Promise<Funds> {
    return fetchFunds(this.ctx());
  }

  async resolveInstrument(sym: CanonicalSymbol): Promise<InstrumentRef> {
    return this.deps.instruments.resolve(sym);
  }

  async getQuote(syms: CanonicalSymbol[]): Promise<Quote[]> {
    return fetchQuotes(this.ctx(), syms);
  }

  async getHistorical(req: HistoricalRequest): Promise<Candle[]> {
    const ref = this.deps.instruments.resolve(req.symbol);
    return fetchHistoricalCandles(
      this.ctx(),
      ref.brokerInstrumentId,
      req.interval,
      req.from,
      req.to,
    );
  }

  /**
   * Resolve → validate (lot size, tick grid) → map to Kite fields → POST.
   * Both the instrument resolution and the neutral→Kite product/order-type
   * mapping (inside `placeRegularOrder`) happen before any HTTP call, so an
   * unknown instrument, a lot/tick mismatch, or an unsupported product (MTF
   * has no Kite equivalent) all fail with zero HTTP calls made.
   */
  async placeOrder(order: NormalizedOrder, idempotencyKey: string): Promise<OrderAck> {
    const ref = this.deps.instruments.resolve(order.symbol);
    validateOrderAgainstInstrument(order, ref);
    const tag = kiteTagFor(idempotencyKey);
    return placeRegularOrder(this.ctx(), order, ref, tag);
  }

  /**
   * Kite's modify endpoint only accepts quantity/price/order_type/
   * trigger_price/validity/disclosed_quantity — symbol, side and product
   * cannot be changed post-placement, so those fields of `patch` (if present)
   * are ignored rather than rejected.
   */
  async modifyOrder(brokerOrderId: string, patch: Partial<NormalizedOrder>): Promise<OrderAck> {
    return modifyRegularOrder(this.ctx(), brokerOrderId, {
      quantity: patch.quantity,
      limitPrice: patch.limitPrice,
      triggerPrice: patch.triggerPrice,
      disclosedQuantity: patch.disclosedQuantity,
      orderType: patch.orderType,
      validity: patch.validity,
    });
  }

  async cancelOrder(brokerOrderId: string): Promise<OrderAck> {
    return cancelRegularOrder(this.ctx(), brokerOrderId);
  }

  /** `GET /orders/{id}` returns the order's full history; the latest entry is used. */
  async getOrder(brokerOrderId: string): Promise<OrderStatus> {
    return fetchOrderHistory(this.ctx(), brokerOrderId);
  }

  async listOrders(): Promise<OrderStatus[]> {
    return fetchOrders(this.ctx());
  }
}
