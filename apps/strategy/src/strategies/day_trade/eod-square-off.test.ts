import { describe, expect, it } from 'vitest';
import { symbolKey } from '@pm/core';
import { EodSquareOffParamsSchema, eodSquareOffStrategy } from './eod-square-off.js';
import {
  INFY,
  NOW_IST_1000,
  NOW_IST_1520,
  NOW_IST_1545,
  RELIANCE,
  instrumentMap,
  makeBook,
  makeDayTradeBook,
  makeDef,
  makeInstrument,
  makeLedgerEntry,
  makeQuote,
  makeStrategyContext,
  quoteMap,
} from '../../test-utils/index.js';
import type { StrategyResult } from '../../types.js';

const DEF = makeDef({ id: 'eod_square_off', bookId: 'day_trade', horizon: 'day_trade' });

const mis = (qty: number, bookId = 'day_trade', key = symbolKey(RELIANCE)) =>
  makeLedgerEntry({
    bookId,
    product: 'INTRADAY',
    side: qty > 0 ? 'BUY' : 'SELL',
    qty: Math.abs(qty),
    symbolKey: key,
    price: 100,
  });

async function run(over: Record<string, unknown> = {}, p: unknown = {}): Promise<StrategyResult> {
  return eodSquareOffStrategy.run(
    makeStrategyContext({
      params: p,
      def: DEF,
      book: makeDayTradeBook(),
      ledger: [mis(10)],
      quotes: quoteMap([makeQuote({ ltp: 105 }), makeQuote({ symbol: INFY, ltp: 1500 })]),
      instruments: instrumentMap([makeInstrument()]),
      now: NOW_IST_1520,
      ...over,
    }),
  );
}

describe('EodSquareOffParamsSchema', () => {
  it('defaults to a MARKET exit 15 minutes before the close', () => {
    expect(EodSquareOffParamsSchema.parse({})).toEqual({
      orderType: 'MARKET',
      squareOffMinutesBeforeClose: 15,
    });
  });
});

describe('eod square-off', () => {
  it('exits a long MIS position at market inside the window', async () => {
    const result = await run();
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.order).toMatchObject({
      side: 'SELL',
      quantity: 10,
      orderType: 'MARKET',
      product: 'INTRADAY',
    });
    expect(result.proposals[0]?.order.limitPrice).toBeUndefined();
    expect(result.proposals[0]?.intent).toBe('square_off');
  });

  it('buys back a short MIS position', async () => {
    const result = await run({ ledger: [mis(-8)] });
    expect(result.proposals[0]?.order).toMatchObject({ side: 'BUY', quantity: 8 });
  });

  it('can exit with a LIMIT at the LTP instead', async () => {
    const result = await run({}, { orderType: 'LIMIT' });
    expect(result.proposals[0]?.order).toMatchObject({ orderType: 'LIMIT', limitPrice: 105 });
  });

  it('does nothing outside the square-off window on an intraday tick', async () => {
    const result = await run({ now: NOW_IST_1000 });
    expect(result.proposals).toEqual([]);
    expect(result.notes).toContain('min to close');
  });

  it('fires exactly at the window boundary', async () => {
    // 15:15 IST = 15 minutes to close, the default window.
    const result = await run({ now: '2026-01-13T09:45:00.000Z' });
    expect(result.proposals).toHaveLength(1);
  });

  it('runs on the eod tick as a safety net even after the close', async () => {
    const result = await run({ now: NOW_IST_1545, tick: 'eod' });
    expect(result.proposals).toHaveLength(1);
  });

  it('only touches INTRADAY positions of its own book', async () => {
    const otherBook = await run({ ledger: [mis(10, 'swing')] });
    expect(otherBook.proposals).toEqual([]);

    const delivery = await run({
      ledger: [makeLedgerEntry({ bookId: 'day_trade', product: 'DELIVERY', qty: 10 })],
    });
    expect(delivery.proposals).toEqual([]);
  });

  it('ignores a flat position', async () => {
    const result = await run({ ledger: [mis(10), mis(-10)] });
    expect(result.proposals).toEqual([]);
    expect(result.notes).toContain('no open MIS positions');
  });

  it('is MIS-only — a DELIVERY book proposes nothing', async () => {
    const result = await run({ book: makeBook() });
    expect(result.proposals).toEqual([]);
    expect(result.notes).toContain('nothing to square off');
  });

  it('skips a position with no usable quote — fail closed', async () => {
    const result = await run({ quotes: quoteMap([]) });
    expect(result.proposals).toEqual([]);
  });

  it('squares off every open MIS position in the book', async () => {
    const result = await run({ ledger: [mis(10), mis(4, 'day_trade', symbolKey(INFY))] });
    expect(result.proposals.map((p) => p.order.symbol.tradingSymbol).sort()).toEqual([
      'INFY',
      'RELIANCE',
    ]);
  });

  it('runs on both the intraday and eod ticks', () => {
    expect(eodSquareOffStrategy.schedule).toEqual(['intraday', 'eod']);
  });
});
