/**
 * Stop-loss / target monitor — docs/05 §5.6 (the two "monitor" rows).
 *
 *   LTP ≤ stop    → SELL **SL-M** with the trigger at the stop
 *   LTP ≥ target  → SELL **LIMIT** at the target
 *
 * Only quantity the *ledger* attributes to this book is ever offered for sale
 * (docs/10 §10.4), and only in the book's own product, so a swing exit can never
 * touch the long-term sleeve's delivery shares.
 *
 * When both levels are hit in the same tick the **stop wins**: protecting
 * capital outranks booking a gain.
 */

import { z } from 'zod';
import { CanonicalSymbolSchema, symbolKey } from '@pm/core';
import type { CanonicalSymbol } from '@pm/core';
import {
  defineStrategy,
  type ProposalDraft,
  type ProposalIntent,
  type Rationale,
  type StrategyContext,
} from '../../types.js';
import {
  limitOrder,
  lotAndTick,
  makeDraft,
  ownedInBook,
  roundDownToLot,
  roundToTick,
  stopMarketOrder,
} from '../util.js';

export const STOP_TARGET_MONITOR_STRATEGY_ID = 'stop_target_monitor';

export const StopTargetMonitorParamsSchema = z.object({
  levels: z
    .array(
      z
        .object({
          symbol: CanonicalSymbolSchema,
          stopPrice: z.number().positive().finite().optional(),
          targetPrice: z.number().positive().finite().optional(),
        })
        .superRefine((level, ctx) => {
          if (level.stopPrice === undefined && level.targetPrice === undefined) {
            ctx.addIssue({
              code: 'custom',
              message: 'a level needs at least one of stopPrice / targetPrice',
            });
          }
          if (
            level.stopPrice !== undefined &&
            level.targetPrice !== undefined &&
            level.targetPrice <= level.stopPrice
          ) {
            ctx.addIssue({
              code: 'custom',
              path: ['targetPrice'],
              message: 'targetPrice must be above stopPrice',
            });
          }
        }),
    )
    .min(1),
});

export type StopTargetMonitorParams = z.infer<typeof StopTargetMonitorParamsSchema>;

export function describe(input: {
  symbol: CanonicalSymbol;
  intent: Extract<ProposalIntent, 'stop' | 'target'>;
  quantity: number;
  ltp: number;
  level: number;
}): Rationale {
  const hit = input.intent === 'stop' ? '≤ stop' : '≥ target';
  return {
    summary:
      `${input.symbol.tradingSymbol} LTP ₹${input.ltp} ${hit} ₹${input.level}: ` +
      `exit ${input.quantity} ${input.intent === 'stop' ? 'at market on trigger' : `at ₹${input.level}`}.`,
    signals: {
      strategy: STOP_TARGET_MONITOR_STRATEGY_ID,
      ltp: input.ltp,
      [input.intent === 'stop' ? 'stopPrice' : 'targetPrice']: input.level,
      quantity: input.quantity,
    },
    confidence: 'high',
  };
}

async function run(ctx: StrategyContext<StopTargetMonitorParams>): Promise<{
  proposals: ProposalDraft[];
  notes?: string | undefined;
}> {
  const { book, params, now } = ctx;
  const capturedAt = now.toISOString();

  const quotes = await ctx.market.quotes(params.levels.map((l) => l.symbol));
  const proposals: ProposalDraft[] = [];

  for (const level of params.levels) {
    const key = symbolKey(level.symbol);
    const quote = quotes.get(key);
    if (quote === undefined || !(quote.ltp > 0)) continue;

    const { lotSize, tickSize } = lotAndTick(await ctx.market.instrument(level.symbol));
    const owned = roundDownToLot(
      ownedInBook(ctx.ledger, book.id, level.symbol, book.product),
      lotSize,
    );
    if (owned <= 0) continue;

    const stopHit = level.stopPrice !== undefined && quote.ltp <= level.stopPrice;
    const targetHit = level.targetPrice !== undefined && quote.ltp >= level.targetPrice;
    if (!stopHit && !targetHit) continue;

    // Stop outranks target when both fire in the same tick.
    if (stopHit && level.stopPrice !== undefined) {
      const triggerPrice = roundToTick(level.stopPrice, tickSize);
      proposals.push(
        makeDraft({
          strategyId: ctx.def.id,
          bookId: book.id,
          horizon: ctx.def.horizon,
          intent: 'stop',
          order: stopMarketOrder({
            symbol: level.symbol,
            side: 'SELL',
            quantity: owned,
            product: book.product,
            triggerPrice,
          }),
          rationale: describe({
            symbol: level.symbol,
            intent: 'stop',
            quantity: owned,
            ltp: quote.ltp,
            level: triggerPrice,
          }),
          ltp: quote.ltp,
          capturedAt,
        }),
      );
      continue;
    }

    if (level.targetPrice !== undefined) {
      const limitPrice = roundToTick(level.targetPrice, tickSize);
      proposals.push(
        makeDraft({
          strategyId: ctx.def.id,
          bookId: book.id,
          horizon: ctx.def.horizon,
          intent: 'target',
          order: limitOrder({
            symbol: level.symbol,
            side: 'SELL',
            quantity: owned,
            product: book.product,
            limitPrice,
          }),
          rationale: describe({
            symbol: level.symbol,
            intent: 'target',
            quantity: owned,
            ltp: quote.ltp,
            level: limitPrice,
          }),
          ltp: quote.ltp,
          capturedAt,
        }),
      );
    }
  }

  return { proposals };
}

export const stopTargetMonitorStrategy = defineStrategy<StopTargetMonitorParams>({
  id: STOP_TARGET_MONITOR_STRATEGY_ID,
  horizon: 'swing',
  schedule: ['intraday'],
  paramsSchema: StopTargetMonitorParamsSchema,
  run,
});
