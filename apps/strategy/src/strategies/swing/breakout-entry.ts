/**
 * Breakout entry (swing) — docs/05 §5.6 "signal entries".
 *
 * Entry when the latest close clears the highest high of the previous N candles
 * **and** volume confirms (> k × the average of those N). Size comes from risk,
 * not from conviction: `perTradeRiskPct × book capital / (entry − stop)`
 * (docs/10 §10.3), then clamped by the book's remaining budget and its
 * `maxPositionValueInr`.
 */

import { z } from 'zod';
import { CanonicalSymbolSchema, availableBudget, symbolKey } from '@pm/core';
import type { Candle, CanonicalSymbol } from '@pm/core';
import {
  defineStrategy,
  type ProposalDraft,
  type Rationale,
  type StrategyContext,
} from '../../types.js';
import {
  limitOrder,
  lotAndTick,
  makeDraft,
  ownedInBook,
  qtyForBudget,
  roundDownToLot,
  roundMoney,
  roundToTick,
} from '../util.js';

export const BREAKOUT_ENTRY_STRATEGY_ID = 'breakout_entry';

const DAY_MS = 86_400_000;

export const BreakoutEntryParamsSchema = z.object({
  instruments: z.array(CanonicalSymbolSchema).min(1),
  /** How many completed candles form the breakout base. */
  lookbackCandles: z.number().int().min(2).max(250),
  /** Volume must exceed this multiple of the base's average volume. */
  volumeMultiple: z.number().positive().finite(),
  /** Protective stop, as a % below the entry price. */
  stopPct: z.number().positive().max(50),
  /** Overrides the book's `risk.perTradeRiskPct`. */
  perTradeRiskPct: z.number().positive().max(100).optional(),
  interval: z.enum(['15m', '1h', '1d']).default('1d'),
});

export type BreakoutEntryParams = z.infer<typeof BreakoutEntryParamsSchema>;

export interface BreakoutSignal {
  priorHigh: number;
  avgVolume: number;
  close: number;
  volume: number;
  breakout: boolean;
  volumeConfirmed: boolean;
}

/** Pure signal evaluation — the part the backtest replays. */
export function evaluateBreakout(
  candles: readonly Candle[],
  lookbackCandles: number,
  volumeMultiple: number,
): BreakoutSignal | undefined {
  if (candles.length < lookbackCandles + 1) return undefined;
  const latest = candles.at(-1);
  if (latest === undefined) return undefined;
  const base = candles.slice(-lookbackCandles - 1, -1);
  if (base.length === 0) return undefined;

  const priorHigh = base.reduce((max, c) => Math.max(max, c.high), Number.NEGATIVE_INFINITY);
  const avgVolume = base.reduce((sum, c) => sum + c.volume, 0) / base.length;
  return {
    priorHigh,
    avgVolume,
    close: latest.close,
    volume: latest.volume,
    breakout: latest.close > priorHigh,
    volumeConfirmed: latest.volume > volumeMultiple * avgVolume,
  };
}

export function describe(input: {
  symbol: CanonicalSymbol;
  signal: BreakoutSignal;
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  riskPct: number;
  lookbackCandles: number;
  volumeMultiple: number;
}): Rationale {
  return {
    summary:
      `${input.symbol.tradingSymbol} closed ₹${input.signal.close} above the ` +
      `${input.lookbackCandles}-candle high ₹${roundMoney(input.signal.priorHigh, 2)} on ` +
      `${roundMoney(input.signal.volume / Math.max(input.signal.avgVolume, 1), 2)}× average volume: ` +
      `BUY ${input.quantity} @ ₹${input.entryPrice}, stop ₹${input.stopPrice} ` +
      `(${input.riskPct}% of book capital at risk).`,
    signals: {
      strategy: BREAKOUT_ENTRY_STRATEGY_ID,
      priorHigh: roundMoney(input.signal.priorHigh, 2),
      avgVolume: roundMoney(input.signal.avgVolume, 2),
      close: input.signal.close,
      volume: input.signal.volume,
      volumeMultiple: input.volumeMultiple,
      lookbackCandles: input.lookbackCandles,
      entryPrice: input.entryPrice,
      stopPrice: input.stopPrice,
      perTradeRiskPct: input.riskPct,
    },
    confidence: 'medium',
  };
}

async function run(ctx: StrategyContext<BreakoutEntryParams>): Promise<{
  proposals: ProposalDraft[];
  notes?: string | undefined;
}> {
  const { book, params, now } = ctx;
  const capturedAt = now.toISOString();

  const basis = book.allocatedCapitalInr;
  if (!(basis > 0)) {
    return { proposals: [], notes: `book '${book.id}' has no allocated capital` };
  }

  const riskPct = params.perTradeRiskPct ?? book.risk.perTradeRiskPct;
  if (!(riskPct > 0)) {
    return { proposals: [], notes: `book '${book.id}' has perTradeRiskPct = ${riskPct}` };
  }

  const quotes = await ctx.market.quotes(params.instruments);
  const budget = availableBudget(book);
  const to = now.toISOString();
  const from = new Date(now.getTime() - (params.lookbackCandles + 10) * DAY_MS).toISOString();
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
      to,
    });
    const signal = evaluateBreakout(candles, params.lookbackCandles, params.volumeMultiple);
    if (signal === undefined || !signal.breakout || !signal.volumeConfirmed) continue;

    const { lotSize, tickSize } = lotAndTick(await ctx.market.instrument(symbol));
    const entryPrice = roundToTick(quote.ltp, tickSize);
    const stopPrice = roundToTick(entryPrice * (1 - params.stopPct / 100), tickSize, 'floor');
    const riskPerUnit = entryPrice - stopPrice;
    if (!(entryPrice > 0) || !(riskPerUnit > 0)) continue;

    const riskCapitalInr = (basis * riskPct) / 100;
    const byRisk = roundDownToLot(riskCapitalInr / riskPerUnit, lotSize);
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
          side: 'BUY',
          quantity,
          product: book.product,
          limitPrice: entryPrice,
        }),
        rationale: describe({
          symbol,
          signal,
          quantity,
          entryPrice,
          stopPrice,
          riskPct,
          lookbackCandles: params.lookbackCandles,
          volumeMultiple: params.volumeMultiple,
        }),
        ltp: quote.ltp,
        capturedAt,
      }),
    );
  }

  return { proposals };
}

export const breakoutEntryStrategy = defineStrategy<BreakoutEntryParams>({
  id: BREAKOUT_ENTRY_STRATEGY_ID,
  horizon: 'swing',
  schedule: ['intraday'],
  paramsSchema: BreakoutEntryParamsSchema,
  run,
});
