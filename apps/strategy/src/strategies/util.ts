/**
 * Shared, pure helpers for strategy modules.
 *
 * Everything here is deterministic and total: no clock, no I/O, no throwing on
 * ordinary inputs. Sizing always rounds **down** so a strategy can never round
 * its way past a budget or a lot boundary.
 */

import type {
  BookId,
  CanonicalSymbol,
  Horizon,
  InstrumentRef,
  LedgerEntry,
  NormalizedOrder,
  Product,
  Side,
  Validity,
} from '@pm/core';
import { estimateOrderNotionalInr, istDateKey, ownedQty, symbolKey } from '@pm/core';
import type { ProposalDraft, ProposalIntent, Rationale } from '../types.js';

/** IST weekday for an instant: 0 = Sunday … 6 = Saturday. */
export function istWeekday(now: Date | string): number {
  return new Date(`${istDateKey(now)}T00:00:00.000Z`).getUTCDay();
}

/** IST day-of-month (1–31) for an instant. */
export function istDayOfMonth(now: Date | string): number {
  return Number(istDateKey(now).slice(8, 10));
}

/** ISO-8601 instant for `minuteOfDay` on an IST calendar date, e.g. 09:15 IST. */
export function istInstantIso(dateKey: string, minuteOfDay: number): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${dateKey}T${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}:00.000+05:30`;
}

/** Kill float dust without pretending to more precision than money has. */
export function roundMoney(value: number, dp = 6): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

export type TickRounding = 'nearest' | 'floor' | 'ceil';

/** Snap a price onto the instrument's tick grid. */
export function roundToTick(
  price: number,
  tickSize: number,
  mode: TickRounding = 'nearest',
): number {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) return price;
  const steps = price / tickSize;
  const snapped =
    mode === 'floor'
      ? Math.floor(roundMoney(steps, 9))
      : mode === 'ceil'
        ? Math.ceil(roundMoney(steps, 9))
        : Math.round(steps);
  return roundMoney(snapped * tickSize);
}

/** Largest whole multiple of `lotSize` not exceeding `qty`. Never negative. */
export function roundDownToLot(qty: number, lotSize: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  const lot = Number.isFinite(lotSize) && lotSize >= 1 ? Math.floor(lotSize) : 1;
  return Math.floor(qty / lot) * lot;
}

/** How many units of `price` fit in `budgetInr`, rounded down to whole lots. */
export function qtyForBudget(budgetInr: number, price: number, lotSize: number): number {
  if (!Number.isFinite(budgetInr) || budgetInr <= 0) return 0;
  if (!Number.isFinite(price) || price <= 0) return 0;
  return roundDownToLot(budgetInr / price, lotSize);
}

/** Rupee value of an order, to paise. */
export function estimateValueInr(quantity: number, price: number): number {
  return roundMoney(quantity * price, 2);
}

/** Signed quantity this book owns of `symbol` in `product`, from the ledger. */
export function ownedInBook(
  ledger: readonly LedgerEntry[],
  bookId: string,
  symbol: CanonicalSymbol,
  product: Product,
): number {
  return ownedQty(ledger, bookId, symbolKey(symbol), product);
}

// ---------------------------------------------------------------------------
// Order builders — each emits exactly the price fields its type permits, so the
// result always satisfies `NormalizedOrderSchema`'s superRefine.
// ---------------------------------------------------------------------------

interface OrderBase {
  symbol: CanonicalSymbol;
  side: Side;
  quantity: number;
  product: Product;
  validity?: Validity | undefined;
}

export function limitOrder(args: OrderBase & { limitPrice: number }): NormalizedOrder {
  return {
    symbol: args.symbol,
    side: args.side,
    quantity: args.quantity,
    orderType: 'LIMIT',
    product: args.product,
    validity: args.validity ?? 'DAY',
    limitPrice: args.limitPrice,
  };
}

export function marketOrder(args: OrderBase): NormalizedOrder {
  return {
    symbol: args.symbol,
    side: args.side,
    quantity: args.quantity,
    orderType: 'MARKET',
    product: args.product,
    validity: args.validity ?? 'DAY',
  };
}

/** SL-M: a trigger and no limit — the stop-loss workhorse (docs/05 §5.6). */
export function stopMarketOrder(args: OrderBase & { triggerPrice: number }): NormalizedOrder {
  return {
    symbol: args.symbol,
    side: args.side,
    quantity: args.quantity,
    orderType: 'SL-M',
    product: args.product,
    validity: args.validity ?? 'DAY',
    triggerPrice: args.triggerPrice,
  };
}

// ---------------------------------------------------------------------------
// Draft builder
// ---------------------------------------------------------------------------

export interface DraftArgs {
  strategyId: string;
  bookId: BookId;
  horizon: Horizon;
  intent: ProposalIntent;
  order: NormalizedOrder;
  rationale: Rationale;
  /** Live LTP at decision time — also the market-context anchor. */
  ltp: number;
  /** ISO-8601; always `ctx.now.toISOString()`, never a wall-clock read. */
  capturedAt: string;
  estimatedCharges?: number | undefined;
}

export function makeDraft(args: DraftArgs): ProposalDraft {
  const notional = estimateOrderNotionalInr(args.order, args.ltp) ?? args.order.quantity * args.ltp;
  const draft: ProposalDraft = {
    strategyId: args.strategyId,
    bookId: args.bookId,
    horizon: args.horizon,
    intent: args.intent,
    order: args.order,
    rationale: {
      ...args.rationale,
      signals: { ...args.rationale.signals, intent: args.intent },
    },
    marketContext: {
      ltpAtProposal: args.ltp,
      estimatedValueInr: roundMoney(notional, 2),
      capturedAt: args.capturedAt,
    },
  };
  if (args.estimatedCharges !== undefined) {
    draft.marketContext.estimatedCharges = args.estimatedCharges;
  }
  return draft;
}

/** Lot/tick, with safe fallbacks when the instrument master has no entry. */
export function lotAndTick(instrument: InstrumentRef | undefined): {
  lotSize: number;
  tickSize: number;
} {
  const lotSize = instrument !== undefined && instrument.lotSize >= 1 ? instrument.lotSize : 1;
  const tickSize = instrument !== undefined && instrument.tickSize > 0 ? instrument.tickSize : 0.05;
  return { lotSize, tickSize };
}
