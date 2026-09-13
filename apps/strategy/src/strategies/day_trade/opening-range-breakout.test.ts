import { describe, expect, it } from 'vitest';
import { MARKET_OPEN_MINUTES_IST, symbolKey } from '@pm/core';
import type { Candle } from '@pm/core';
import { openingRange, openingRangeBreakoutStrategy } from './opening-range-breakout.js';
import {
  IST_DATE,
  NOW_IST_1000,
  RELIANCE,
  instrumentMap,
  intradayCandles,
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

const DEF = makeDef({ id: 'opening_range_breakout', bookId: 'day_trade', horizon: 'day_trade' });

/** 09:15, 09:20, 09:25 inside the 15-min range; 09:30 outside it. */
const CANDLES: Candle[] = intradayCandles(IST_DATE, MARKET_OPEN_MINUTES_IST, 5, [
  { o: 100, h: 104, l: 99, c: 103, v: 1000 },
  { o: 103, h: 106, l: 101, c: 104, v: 1000 },
  { o: 104, h: 105, l: 98, c: 101, v: 1000 },
  { o: 101, h: 130, l: 90, c: 120, v: 1000 },
]);

const params = {
  instruments: [RELIANCE],
  rangeMinutes: 15,
  entryCutoffMinuteIst: 14 * 60,
  allowShort: false,
  interval: '5m' as const,
};

/** 150 000 book × 2 % = ₹3 000 risk. */
async function run(
  ltp: number,
  over: Record<string, unknown> = {},
  p: unknown = params,
): Promise<StrategyResult> {
  return openingRangeBreakoutStrategy.run(
    makeStrategyContext({
      params: p,
      def: DEF,
      book: makeDayTradeBook({ allocatedCapitalInr: 150_000 }),
      quotes: quoteMap([makeQuote({ ltp })]),
      instruments: instrumentMap([makeInstrument({ tickSize: 0.05 })]),
      candles: new Map([[symbolKey(RELIANCE), CANDLES]]),
      now: NOW_IST_1000,
      ...over,
    }),
  );
}

describe('openingRange', () => {
  it('uses only candles inside the window, on that IST date', () => {
    expect(openingRange(CANDLES, IST_DATE, 15)).toEqual({ high: 106, low: 98, candles: 3 });
  });

  it('excludes a candle at exactly the window end', () => {
    expect(openingRange(CANDLES, IST_DATE, 10)).toEqual({ high: 106, low: 99, candles: 2 });
  });

  it('ignores candles from another day', () => {
    expect(openingRange(CANDLES, '2026-01-14', 15)).toBeUndefined();
  });
});

describe('opening-range breakout', () => {
  it('buys above the range high, stopping at the range low', async () => {
    const result = await run(110);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.order).toMatchObject({
      side: 'BUY',
      orderType: 'LIMIT',
      product: 'INTRADAY',
      limitPrice: 110,
      quantity: 250, // ₹3 000 / (110 − 98)
    });
    expect(result.proposals[0]?.rationale.signals['stopPrice']).toBe(98);
    expect(result.proposals[0]?.horizon).toBe('day_trade');
  });

  it('does nothing at exactly the range high or low (strict comparison)', async () => {
    expect((await run(106)).proposals).toEqual([]);
    expect((await run(98, {}, { ...params, allowShort: true })).proposals).toEqual([]);
  });

  it('shorts below the range low only when allowShort is on', async () => {
    expect((await run(90)).proposals).toEqual([]);
    const short = await run(90, {}, { ...params, allowShort: true });
    expect(short.proposals[0]?.order).toMatchObject({
      side: 'SELL',
      product: 'INTRADAY',
      limitPrice: 90,
    });
    expect(short.proposals[0]?.rationale.signals['stopPrice']).toBe(106);
  });

  it('waits until the opening range is complete', async () => {
    // 09:20 IST = 03:50 UTC, still inside the 15-minute window.
    const result = await run(110, { now: '2026-01-13T03:50:00.000Z' });
    expect(result.proposals).toEqual([]);
    expect(result.notes).toContain('still forming');
  });

  it('honours the hard entry cutoff', async () => {
    const result = await run(110, {}, { ...params, entryCutoffMinuteIst: 9 * 60 + 30 });
    expect(result.proposals).toEqual([]);
    expect(result.notes).toContain('entry cutoff');
  });

  it('is MIS-only — a DELIVERY book proposes nothing', async () => {
    const result = await run(110, { book: makeBook() });
    expect(result.proposals).toEqual([]);
    expect(result.notes).toContain('MIS-only');
  });

  it('never adds to a position the book already holds', async () => {
    const result = await run(110, {
      ledger: [
        makeLedgerEntry({
          bookId: 'day_trade',
          product: 'INTRADAY',
          qty: 5,
          symbolKey: symbolKey(RELIANCE),
        }),
      ],
    });
    expect(result.proposals).toEqual([]);
  });

  it('caps the size at the book budget', async () => {
    const result = await run(110, {
      book: makeDayTradeBook({ allocatedCapitalInr: 150_000, deployedInr: 148_900 }),
    });
    expect(result.proposals[0]?.order.quantity).toBe(10); // ₹1 100 left / ₹110
  });

  it('rounds the size down to whole lots', async () => {
    const result = await run(110, {
      instruments: instrumentMap([makeInstrument({ lotSize: 100, tickSize: 0.05 })]),
    });
    expect(result.proposals[0]?.order.quantity).toBe(200);
  });

  it('proposes nothing without a quote or without candles', async () => {
    expect((await run(110, { quotes: quoteMap([]) })).proposals).toEqual([]);
    expect((await run(110, { candles: new Map() })).proposals).toEqual([]);
  });

  it('proposes nothing when the book cannot size a trade', async () => {
    const result = await run(110, {
      book: makeDayTradeBook({ allocatedCapitalInr: 0 }),
    });
    expect(result.notes).toContain('cannot size a trade');
  });

  it('honours a params-level risk override', async () => {
    const result = await run(110, {}, { ...params, perTradeRiskPct: 1 });
    expect(result.proposals[0]?.order.quantity).toBe(125);
  });
});
