/**
 * SIP / DCA — docs/05 §5.6 ("BUY fixed ₹ of chosen instruments on a schedule").
 *
 * On a scheduled day it buys a fixed rupee amount of each configured instrument:
 * DELIVERY, LIMIT at the live LTP (snapped to the tick grid, so the price collar
 * can never reject it), quantity floored to a whole lot.
 *
 * Idempotence beyond the harness dedupe: the ledger is consulted so a second
 * intraday tick on the same IST day never re-buys what already filled.
 *
 * Deviation from docs/05 §5.5 (noted deliberately): the table lists "DCA
 * scheduling" under the **eod** tick, but a proposal written at 15:45 IST can
 * never pass the `marketHours` guardrail (09:15–15:30) and would expire unusable.
 * DCA therefore runs on the **intraday** tick, on its scheduled day.
 */

import { z } from 'zod';
import { CanonicalSymbolSchema, istDateKey, symbolKey } from '@pm/core';
import type { CanonicalSymbol } from '@pm/core';
import {
  defineStrategy,
  type ProposalDraft,
  type Rationale,
  type StrategyContext,
} from '../../types.js';
import {
  istDayOfMonth,
  istWeekday,
  limitOrder,
  lotAndTick,
  makeDraft,
  qtyForBudget,
  roundToTick,
} from '../util.js';

export const DCA_STRATEGY_ID = 'dca';

export const DcaParamsSchema = z
  .object({
    instruments: z.array(CanonicalSymbolSchema).min(1),
    /** Rupees to deploy per instrument per scheduled day. */
    amountInrPerInstrument: z.number().positive().finite(),
    frequency: z.enum(['weekly', 'monthly']),
    /** 1 = Monday … 5 = Friday (IST). Required for `weekly`. */
    weekdayIst: z.number().int().min(1).max(5).optional(),
    /** 1–28 (IST), so every month has the day. Required for `monthly`. */
    dayOfMonthIst: z.number().int().min(1).max(28).optional(),
  })
  .superRefine((p, ctx) => {
    if (p.frequency === 'weekly' && p.weekdayIst === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['weekdayIst'],
        message: 'weekly DCA needs weekdayIst',
      });
    }
    if (p.frequency === 'monthly' && p.dayOfMonthIst === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['dayOfMonthIst'],
        message: 'monthly DCA needs dayOfMonthIst',
      });
    }
  });

export type DcaParams = z.infer<typeof DcaParamsSchema>;

/** Is today (IST) a contribution day for these params? */
export function isContributionDay(now: Date | string, params: DcaParams): boolean {
  return params.frequency === 'weekly'
    ? istWeekday(now) === params.weekdayIst
    : istDayOfMonth(now) === params.dayOfMonthIst;
}

export function describe(input: {
  symbol: CanonicalSymbol;
  amountInr: number;
  ltp: number;
  quantity: number;
  frequency: DcaParams['frequency'];
  dateKey: string;
}): Rationale {
  return {
    summary:
      `${input.frequency} SIP: deploy ₹${input.amountInr} into ` +
      `${input.symbol.tradingSymbol} — ${input.quantity} @ ₹${input.ltp} on ${input.dateKey}.`,
    signals: {
      strategy: DCA_STRATEGY_ID,
      frequency: input.frequency,
      amountInrPerInstrument: input.amountInr,
      ltp: input.ltp,
      quantity: input.quantity,
      istDate: input.dateKey,
    },
    confidence: 'medium',
  };
}

async function run(ctx: StrategyContext<DcaParams>): Promise<{
  proposals: ProposalDraft[];
  notes?: string | undefined;
}> {
  const { book, params, now } = ctx;
  const capturedAt = now.toISOString();
  const dateKey = istDateKey(now);

  if (book.product !== 'DELIVERY') {
    return { proposals: [], notes: `book '${book.id}' is ${book.product}; DCA is DELIVERY-only` };
  }
  if (!isContributionDay(now, params)) {
    return { proposals: [], notes: `${dateKey} is not a ${params.frequency} contribution day` };
  }

  const boughtToday = new Set(
    ctx.ledger
      .filter(
        (e) =>
          e.bookId === book.id &&
          e.strategyId === ctx.def.id &&
          e.side === 'BUY' &&
          istDateKey(e.ts) === dateKey,
      )
      .map((e) => e.symbolKey),
  );

  const quotes = await ctx.market.quotes(params.instruments);
  const proposals: ProposalDraft[] = [];

  for (const symbol of params.instruments) {
    const key = symbolKey(symbol);
    if (boughtToday.has(key)) continue;

    const quote = quotes.get(key);
    if (quote === undefined || !(quote.ltp > 0)) continue;

    const { lotSize, tickSize } = lotAndTick(await ctx.market.instrument(symbol));
    const limitPrice = roundToTick(quote.ltp, tickSize);
    const quantity = qtyForBudget(params.amountInrPerInstrument, limitPrice, lotSize);
    if (quantity <= 0) continue;

    proposals.push(
      makeDraft({
        strategyId: ctx.def.id,
        bookId: book.id,
        horizon: ctx.def.horizon,
        intent: 'dca',
        order: limitOrder({
          symbol,
          side: 'BUY',
          quantity,
          product: book.product,
          limitPrice,
        }),
        rationale: describe({
          symbol,
          amountInr: params.amountInrPerInstrument,
          ltp: quote.ltp,
          quantity,
          frequency: params.frequency,
          dateKey,
        }),
        ltp: quote.ltp,
        capturedAt,
      }),
    );
  }

  return { proposals };
}

export const dcaStrategy = defineStrategy<DcaParams>({
  id: DCA_STRATEGY_ID,
  horizon: 'long_term',
  schedule: ['intraday'],
  paramsSchema: DcaParamsSchema,
  run,
});
