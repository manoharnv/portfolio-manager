/**
 * Intraday square-off — docs/10 §10.6 "Intraday square-off guard".
 *
 * Every MIS position the ledger attributes to the day-trade book is offered for
 * exit once the session is inside `squareOffMinutesBeforeClose`, so the position
 * closes on our terms rather than the broker's auto-square-off (with its charges).
 *
 * It also runs on the **eod** tick as a safety net. Note that a draft produced at
 * 15:45 IST is correctly dropped by the `marketHours` guardrail — the value of
 * the eod run is the audited "MIS still open after the close" record, not a
 * writable proposal. The intraday run near 15:15 is the one that acts.
 */

import { z } from 'zod';
import {
  MARKET_CLOSE_MINUTES_IST,
  istMinuteOfDay,
  parseSymbolKey,
  positionsByBook,
  symbolKey,
} from '@pm/core';
import type { CanonicalSymbol, Side } from '@pm/core';
import {
  defineStrategy,
  type ProposalDraft,
  type Rationale,
  type StrategyContext,
} from '../../types.js';
import { limitOrder, lotAndTick, makeDraft, marketOrder, roundToTick } from '../util.js';

export const EOD_SQUARE_OFF_STRATEGY_ID = 'eod_square_off';

export const EodSquareOffParamsSchema = z.object({
  /** MARKET guarantees the exit; LIMIT at LTP protects the price. */
  orderType: z.enum(['MARKET', 'LIMIT']).default('MARKET'),
  /** Start proposing exits this many minutes before 15:30 IST. */
  squareOffMinutesBeforeClose: z.number().int().min(0).max(360).default(15),
});

export type EodSquareOffParams = z.infer<typeof EodSquareOffParamsSchema>;

export function describe(input: {
  symbol: CanonicalSymbol;
  side: Side;
  quantity: number;
  ltp: number;
  minutesToClose: number;
  orderType: EodSquareOffParams['orderType'];
}): Rationale {
  return {
    summary:
      `Square off ${input.quantity} MIS ${input.symbol.tradingSymbol}: ` +
      `${input.side} ${input.orderType} with ${input.minutesToClose} min to the close ` +
      `(LTP ₹${input.ltp}).`,
    signals: {
      strategy: EOD_SQUARE_OFF_STRATEGY_ID,
      minutesToClose: input.minutesToClose,
      orderType: input.orderType,
      quantity: input.quantity,
      ltp: input.ltp,
    },
    confidence: 'high',
  };
}

async function run(ctx: StrategyContext<EodSquareOffParams>): Promise<{
  proposals: ProposalDraft[];
  notes?: string | undefined;
}> {
  const { book, params, now } = ctx;
  const capturedAt = now.toISOString();

  if (book.product !== 'INTRADAY') {
    return { proposals: [], notes: `book '${book.id}' is ${book.product}; nothing to square off` };
  }

  const minutesToClose = MARKET_CLOSE_MINUTES_IST - istMinuteOfDay(now);
  const due =
    ctx.tick === 'eod' ||
    (minutesToClose >= 0 && minutesToClose <= params.squareOffMinutesBeforeClose);
  if (!due) {
    return {
      proposals: [],
      notes: `${minutesToClose} min to close, window is ${params.squareOffMinutesBeforeClose} min`,
    };
  }

  const open = positionsByBook(ctx.ledger).filter(
    (p) => p.bookId === book.id && p.product === 'INTRADAY' && p.qty !== 0,
  );
  if (open.length === 0) return { proposals: [], notes: 'no open MIS positions in this book' };

  const symbols = open.map((p) => parseSymbolKey(p.symbolKey));
  const quotes = await ctx.market.quotes(symbols);
  const proposals: ProposalDraft[] = [];

  for (const position of open) {
    const symbol = parseSymbolKey(position.symbolKey);
    const quote = quotes.get(symbolKey(symbol));
    if (quote === undefined || !(quote.ltp > 0)) continue;

    const side: Side = position.qty > 0 ? 'SELL' : 'BUY';
    const quantity = Math.abs(position.qty);
    const { tickSize } = lotAndTick(await ctx.market.instrument(symbol));

    const order =
      params.orderType === 'LIMIT'
        ? limitOrder({
            symbol,
            side,
            quantity,
            product: 'INTRADAY',
            limitPrice: roundToTick(quote.ltp, tickSize),
          })
        : marketOrder({ symbol, side, quantity, product: 'INTRADAY' });

    proposals.push(
      makeDraft({
        strategyId: ctx.def.id,
        bookId: book.id,
        horizon: ctx.def.horizon,
        intent: 'square_off',
        order,
        rationale: describe({
          symbol,
          side,
          quantity,
          ltp: quote.ltp,
          minutesToClose,
          orderType: params.orderType,
        }),
        ltp: quote.ltp,
        capturedAt,
      }),
    );
  }

  return { proposals };
}

export const eodSquareOffStrategy = defineStrategy<EodSquareOffParams>({
  id: EOD_SQUARE_OFF_STRATEGY_ID,
  horizon: 'day_trade',
  schedule: ['intraday', 'eod'],
  paramsSchema: EodSquareOffParamsSchema,
  run,
});
