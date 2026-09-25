/**
 * Rebalance drift — docs/05 §5.6 ("allocation drifts > band from target weights").
 *
 * Target weights are expressed against the **book's** allocated capital, not the
 * whole account: the long-term sleeve rebalances itself and cannot reach for
 * another book's money (docs/10 §10.3). Sells are capped at what the *ledger*
 * says this book owns (docs/10 §10.4) — never at the broker's commingled
 * position.
 */

import { z } from 'zod';
import { CanonicalSymbolSchema, availableBudget, symbolKey } from '@pm/core';
import type { CanonicalSymbol } from '@pm/core';
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

export const REBALANCE_DRIFT_STRATEGY_ID = 'rebalance_drift';

export const RebalanceDriftParamsSchema = z
  .object({
    targets: z
      .array(
        z.object({
          symbol: CanonicalSymbolSchema,
          /** Share of the book's allocated capital, 0–100. */
          weightPct: z.number().min(0).max(100),
        }),
      )
      .min(1),
    /** Drift (in percentage points of book capital) tolerated before acting. */
    bandPct: z.number().positive().finite(),
    /** Ignore corrections smaller than this, so we don't propose dust. */
    minTradeValueInr: z.number().nonnegative().finite().default(1000),
  })
  .superRefine((p, ctx) => {
    const total = p.targets.reduce((sum, t) => sum + t.weightPct, 0);
    if (total > 100) {
      ctx.addIssue({
        code: 'custom',
        path: ['targets'],
        message: `Σ weightPct must be ≤ 100, got ${total}`,
      });
    }
  });

export type RebalanceDriftParams = z.infer<typeof RebalanceDriftParamsSchema>;

export function describe(input: {
  symbol: CanonicalSymbol;
  side: 'BUY' | 'SELL';
  quantity: number;
  ltp: number;
  currentValueInr: number;
  targetValueInr: number;
  driftPct: number;
  bandPct: number;
  basisInr: number;
}): Rationale {
  return {
    summary:
      `${input.symbol.tradingSymbol} is ${input.driftPct > 0 ? 'over' : 'under'}weight by ` +
      `${Math.abs(roundMoney(input.driftPct, 2))}pp (band ±${input.bandPct}pp): ` +
      `${input.side} ${input.quantity} @ ₹${input.ltp} to move ₹${roundMoney(input.currentValueInr, 2)} ` +
      `toward ₹${roundMoney(input.targetValueInr, 2)}.`,
    signals: {
      strategy: REBALANCE_DRIFT_STRATEGY_ID,
      currentValueInr: roundMoney(input.currentValueInr, 2),
      targetValueInr: roundMoney(input.targetValueInr, 2),
      driftPct: roundMoney(input.driftPct, 4),
      bandPct: input.bandPct,
      bookCapitalInr: input.basisInr,
      ltp: input.ltp,
    },
    confidence: 'medium',
  };
}

async function run(ctx: StrategyContext<RebalanceDriftParams>): Promise<{
  proposals: ProposalDraft[];
  notes?: string | undefined;
}> {
  const { book, params, now } = ctx;
  const capturedAt = now.toISOString();

  if (book.product !== 'DELIVERY') {
    return {
      proposals: [],
      notes: `book '${book.id}' is ${book.product}; rebalancing is DELIVERY-only`,
    };
  }
  const basis = book.allocatedCapitalInr;
  if (!(basis > 0)) {
    return { proposals: [], notes: `book '${book.id}' has no allocated capital` };
  }

  const quotes = await ctx.market.quotes(params.targets.map((t) => t.symbol));
  const budget = availableBudget(book);
  const proposals: ProposalDraft[] = [];

  for (const target of params.targets) {
    const key = symbolKey(target.symbol);
    const quote = quotes.get(key);
    if (quote === undefined || !(quote.ltp > 0)) continue;

    const { lotSize, tickSize } = lotAndTick(await ctx.market.instrument(target.symbol));
    const limitPrice = roundToTick(quote.ltp, tickSize);
    if (!(limitPrice > 0)) continue;

    const owned = ownedInBook(ctx.ledger, book.id, target.symbol, book.product);
    const currentValueInr = owned * quote.ltp;
    const targetValueInr = (basis * target.weightPct) / 100;
    const driftPct = ((currentValueInr - targetValueInr) / basis) * 100;
    if (Math.abs(driftPct) <= params.bandPct) continue;

    const deltaInr = targetValueInr - currentValueInr;
    const side = deltaInr > 0 ? 'BUY' : 'SELL';

    const quantity =
      side === 'BUY'
        ? qtyForBudget(Math.min(deltaInr, budget), limitPrice, lotSize)
        : Math.min(
            qtyForBudget(-deltaInr, limitPrice, lotSize),
            roundDownToLot(Math.max(0, owned), lotSize),
          );
    if (quantity <= 0) continue;
    if (quantity * limitPrice < params.minTradeValueInr) continue;

    proposals.push(
      makeDraft({
        strategyId: ctx.def.id,
        bookId: book.id,
        horizon: ctx.def.horizon,
        intent: 'rebalance',
        order: limitOrder({
          symbol: target.symbol,
          side,
          quantity,
          product: book.product,
          limitPrice,
        }),
        rationale: describe({
          symbol: target.symbol,
          side,
          quantity,
          ltp: quote.ltp,
          currentValueInr,
          targetValueInr,
          driftPct,
          bandPct: params.bandPct,
          basisInr: basis,
        }),
        ltp: quote.ltp,
        capturedAt,
      }),
    );
  }

  return { proposals };
}

export const rebalanceDriftStrategy = defineStrategy<RebalanceDriftParams>({
  id: REBALANCE_DRIFT_STRATEGY_ID,
  horizon: 'long_term',
  schedule: ['intraday'],
  paramsSchema: RebalanceDriftParamsSchema,
  run,
});
