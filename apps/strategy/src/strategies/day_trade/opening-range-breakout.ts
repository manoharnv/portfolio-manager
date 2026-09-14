/**
 * Opening-range breakout (day trade, MIS) — docs/10 §10.1's day-trade horizon.
 *
 * The opening range is the high/low of the first `rangeMinutes` of the session
 * (09:15 IST onward). Once that window closes:
 *
 *   LTP > rangeHigh                → BUY  LIMIT, stop at rangeLow
 *   LTP < rangeLow  (allowShort)   → SELL LIMIT, stop at rangeHigh
 *
 * There is a hard entry cutoff — a day-trade entry late in the session has no
 * room left to work before square-off.
 */

import { z } from 'zod';
import {
  CanonicalSymbolSchema,
  MARKET_OPEN_MINUTES_IST,
  availableBudget,
  istDateKey,
  istMinuteOfDay,
  symbolKey,
} from '@pm/core';
import type { Candle, CanonicalSymbol, Side } from '@pm/core';
import {
  defineStrategy,
  type ProposalDraft,
  type Rationale,
  type StrategyContext,
} from '../../types.js';
import {
  istInstantIso,
  limitOrder,
  lotAndTick,
  makeDraft,
  ownedInBook,
  qtyForBudget,
  roundDownToLot,
  roundMoney,
  roundToTick,
} from '../util.js';

export const OPENING_RANGE_BREAKOUT_STRATEGY_ID = 'opening_range_breakout';

export const OpeningRangeBreakoutParamsSchema = z.object({
  instruments: z.array(CanonicalSymbolSchema).min(1),
  /** Length of the opening range from 09:15 IST. */
  rangeMinutes: z.number().int().min(1).max(120).default(15),
  /** No new entries after this IST minute-of-day (default 14:00). */
  entryCutoffMinuteIst: z
    .number()
    .int()
    .min(0)
    .max(1439)
    .default(14 * 60),
  allowShort: z.boolean().default(false),
  interval: z.enum(['1m', '5m', '15m']).default('5m'),
  perTradeRiskPct: z.number().positive().max(100).optional(),
});

export type OpeningRangeBreakoutParams = z.infer<typeof OpeningRangeBreakoutParamsSchema>;

export interface OpeningRange {
  high: number;
  low: number;
  candles: number;
}

/** High/low of the candles that fall inside the opening window on `dateKey`. */
export function openingRange(
  candles: readonly Candle[],
  dateKey: string,
  rangeMinutes: number,
): OpeningRange | undefined {
  const end = MARKET_OPEN_MINUTES_IST + rangeMinutes;
  const inRange = candles.filter((c) => {
    if (istDateKey(c.ts) !== dateKey) return false;
    const m = istMinuteOfDay(c.ts);
    return m >= MARKET_OPEN_MINUTES_IST && m < end;
  });
  if (inRange.length === 0) return undefined;
  return {
    high: inRange.reduce((max, c) => Math.max(max, c.high), Number.NEGATIVE_INFINITY),
    low: inRange.reduce((min, c) => Math.min(min, c.low), Number.POSITIVE_INFINITY),
    candles: inRange.length,
  };
}

export function describe(input: {
  symbol: CanonicalSymbol;
  side: Side;
  range: OpeningRange;
  rangeMinutes: number;
  ltp: number;
  entryPrice: number;
  stopPrice: number;
  quantity: number;
  riskPct: number;
}): Rationale {
  const broke = input.side === 'BUY' ? 'above' : 'below';
  const level = input.side === 'BUY' ? input.range.high : input.range.low;
  return {
    summary:
      `${input.symbol.tradingSymbol} traded ₹${input.ltp} ${broke} the ` +
      `${input.rangeMinutes}-min opening range ` +
      `₹${roundMoney(input.range.low, 2)}–₹${roundMoney(input.range.high, 2)}: ` +
      `${input.side} ${input.quantity} MIS @ ₹${input.entryPrice}, stop ₹${input.stopPrice}.`,
    signals: {
      strategy: OPENING_RANGE_BREAKOUT_STRATEGY_ID,
      rangeHigh: roundMoney(input.range.high, 2),
      rangeLow: roundMoney(input.range.low, 2),
      rangeCandles: input.range.candles,
      rangeMinutes: input.rangeMinutes,
      brokenLevel: roundMoney(level, 2),
      ltp: input.ltp,
      entryPrice: input.entryPrice,
      stopPrice: input.stopPrice,
      perTradeRiskPct: input.riskPct,
    },
    confidence: 'medium',
  };
}

async function run(ctx: StrategyContext<OpeningRangeBreakoutParams>): Promise<{
  proposals: ProposalDraft[];
  notes?: string | undefined;
}> {
  const { book, params, now } = ctx;
  const capturedAt = now.toISOString();

  if (book.product !== 'INTRADAY') {
    return {
      proposals: [],
      notes: `book '${book.id}' is ${book.product}; opening-range breakout is MIS-only`,
    };
  }

  const dateKey = istDateKey(now);
  const minute = istMinuteOfDay(now);
  const rangeEnd = MARKET_OPEN_MINUTES_IST + params.rangeMinutes;
  if (minute < rangeEnd) {
    return { proposals: [], notes: `opening range still forming (ends at minute ${rangeEnd} IST)` };
  }
  if (minute > params.entryCutoffMinuteIst) {
    return {
      proposals: [],
      notes: `past the entry cutoff (minute ${params.entryCutoffMinuteIst} IST)`,
    };
  }

  const basis = book.allocatedCapitalInr;
  const riskPct = params.perTradeRiskPct ?? book.risk.perTradeRiskPct;
  if (!(basis > 0) || !(riskPct > 0)) {
    return { proposals: [], notes: `book '${book.id}' cannot size a trade` };
  }

  const quotes = await ctx.market.quotes(params.instruments);
  const budget = availableBudget(book);
  const from = istInstantIso(dateKey, MARKET_OPEN_MINUTES_IST);
  const proposals: ProposalDraft[] = [];

  for (const symbol of params.instruments) {
    const key = symbolKey(symbol);
    if (ownedInBook(ctx.ledger, book.id, symbol, book.product) !== 0) continue;

    const quote = quotes.get(key);
    if (quote === undefined || !(quote.ltp > 0)) continue;

    const candles = await ctx.market.historical({
      symbol,
      interval: params.interval,
      from,
      to: capturedAt,
    });
    const range = openingRange(candles, dateKey, params.rangeMinutes);
    if (range === undefined || !(range.high > 0) || !(range.low > 0)) continue;

    let side: Side;
    let rawStop: number;
    if (quote.ltp > range.high) {
      side = 'BUY';
      rawStop = range.low;
    } else if (quote.ltp < range.low && params.allowShort) {
      side = 'SELL';
      rawStop = range.high;
    } else {
      continue;
    }

    const { lotSize, tickSize } = lotAndTick(await ctx.market.instrument(symbol));
    const entryPrice = roundToTick(quote.ltp, tickSize);
    const stopPrice = roundToTick(rawStop, tickSize, side === 'BUY' ? 'floor' : 'ceil');
    const riskPerUnit = Math.abs(entryPrice - stopPrice);
    if (!(entryPrice > 0) || !(riskPerUnit > 0)) continue;

    const byRisk = roundDownToLot((basis * riskPct) / 100 / riskPerUnit, lotSize);
    const byBudget = qtyForBudget(
      Math.min(budget, book.risk.maxPositionValueInr),
      entryPrice,
      lotSize,
    );
    const quantity = Math.min(byRisk, byBudget);
    if (quantity <= 0) continue;

    proposals.push(
      makeDraft({
        strategyId: ctx.def.id,
        bookId: book.id,
        horizon: ctx.def.horizon,
        intent: 'entry',
        order: limitOrder({
          symbol,
          side,
          quantity,
          product: book.product,
          limitPrice: entryPrice,
        }),
        rationale: describe({
          symbol,
          side,
          range,
          rangeMinutes: params.rangeMinutes,
          ltp: quote.ltp,
          entryPrice,
          stopPrice,
          quantity,
          riskPct,
        }),
        ltp: quote.ltp,
        capturedAt,
      }),
    );
  }

  return { proposals };
}

export const openingRangeBreakoutStrategy = defineStrategy<OpeningRangeBreakoutParams>({
  id: OPENING_RANGE_BREAKOUT_STRATEGY_ID,
  horizon: 'day_trade',
  schedule: ['intraday'],
  paramsSchema: OpeningRangeBreakoutParamsSchema,
  run,
});
