import { describe, expect, it } from 'vitest';
import { symbolKey } from '@pm/core';
import { RebalanceDriftParamsSchema, rebalanceDriftStrategy } from './rebalance-drift.js';
import {
  INFY,
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

const DEF = makeDef({ id: 'rebalance_drift', bookId: 'long_term', horizon: 'long_term' });

/** 100 000 capital, one 50 % target at ₹1000 ⇒ target value ₹50 000 = 50 units. */
const BOOK = makeBook({ allocatedCapitalInr: 100_000, deployedInr: 0 });

const params = {
  targets: [{ symbol: RELIANCE, weightPct: 50 }],
  bandPct: 5,
  minTradeValueInr: 0,
};

async function run(
  over: Record<string, unknown> = {},
  p: unknown = params,
): Promise<StrategyResult> {
  return rebalanceDriftStrategy.run(
    makeStrategyContext({
      params: p,
      def: DEF,
      book: BOOK,
      quotes: quoteMap([makeQuote({ ltp: 1000 })]),
      instruments: instrumentMap([makeInstrument({ tickSize: 0.05 })]),
      ...over,
    }),
  );
}

const own = (qty: number, bookId = 'long_term') =>
  makeLedgerEntry({ bookId, qty, price: 1000, symbolKey: symbolKey(RELIANCE) });

describe('RebalanceDriftParamsSchema', () => {
  it('rejects weights summing above 100', () => {
    expect(() =>
      RebalanceDriftParamsSchema.parse({
        targets: [
          { symbol: RELIANCE, weightPct: 60 },
          { symbol: INFY, weightPct: 50 },
        ],
        bandPct: 5,
      }),
    ).toThrowError(/≤ 100/);
  });

  it('defaults minTradeValueInr to ₹1000', () => {
    expect(
      RebalanceDriftParamsSchema.parse({
        targets: [{ symbol: RELIANCE, weightPct: 50 }],
        bandPct: 5,
      }).minTradeValueInr,
    ).toBe(1000);
  });
});

describe('rebalance-drift strategy', () => {
  it('does nothing inside the band', async () => {
    // 48 units = ₹48 000 vs target ₹50 000 ⇒ 2pp drift, band 5pp.
    const result = await run({ ledger: [own(48)] });
    expect(result.proposals).toEqual([]);
  });

  it('does nothing at exactly the band edge', async () => {
    // 45 units = ₹45 000 ⇒ drift −5pp, which is not *outside* ±5pp.
    const result = await run({ ledger: [own(45)] });
    expect(result.proposals).toEqual([]);
  });

  it('buys back to target when underweight beyond the band', async () => {
    const result = await run({ ledger: [own(40)] });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.order).toMatchObject({
      side: 'BUY',
      quantity: 10, // (50 000 − 40 000) / 1000
      orderType: 'LIMIT',
      product: 'DELIVERY',
      limitPrice: 1000,
    });
    expect(result.proposals[0]?.intent).toBe('rebalance');
  });

  it('sells back to target when overweight beyond the band', async () => {
    const result = await run({ ledger: [own(60)] });
    expect(result.proposals[0]?.order).toMatchObject({ side: 'SELL', quantity: 10 });
  });

  it('never sells more than the ledger says this book owns', async () => {
    // The swing book owns 100; this book owns 60 but the target is 0.
    const result = await run(
      { ledger: [own(60), own(100, 'swing')] },
      { targets: [{ symbol: RELIANCE, weightPct: 0 }], bandPct: 1, minTradeValueInr: 0 },
    );
    expect(result.proposals[0]?.order.quantity).toBe(60);
  });

  it('respects the book budget when buying', async () => {
    const result = await run({
      ledger: [own(40)],
      book: makeBook({ allocatedCapitalInr: 100_000, deployedInr: 96_000 }),
    });
    // Only ₹4 000 of budget left ⇒ 4 units, not 10.
    expect(result.proposals[0]?.order.quantity).toBe(4);
  });

  it('rounds to whole lots', async () => {
    const result = await run({
      ledger: [own(40)],
      instruments: instrumentMap([makeInstrument({ lotSize: 4 })]),
    });
    expect(result.proposals[0]?.order.quantity).toBe(8);
  });

  it('ignores corrections below minTradeValueInr', async () => {
    const result = await run({ ledger: [own(40)] }, { ...params, minTradeValueInr: 50_000 });
    expect(result.proposals).toEqual([]);
  });

  it('is DELIVERY-only', async () => {
    const result = await run({ book: makeDayTradeBook(), ledger: [own(40, 'day_trade')] });
    expect(result.proposals).toEqual([]);
    expect(result.notes).toContain('DELIVERY-only');
  });

  it('does nothing when the book has no capital', async () => {
    const result = await run({ book: makeBook({ allocatedCapitalInr: 0 }) });
    expect(result.proposals).toEqual([]);
    expect(result.notes).toContain('no allocated capital');
  });

  it('skips a target with no quote — fail closed', async () => {
    const result = await run(
      { ledger: [own(40)] },
      {
        targets: [
          { symbol: RELIANCE, weightPct: 50 },
          { symbol: INFY, weightPct: 25 },
        ],
        bandPct: 5,
        minTradeValueInr: 0,
      },
    );
    expect(result.proposals.map((p) => p.order.symbol.tradingSymbol)).toEqual(['RELIANCE']);
  });

  it('skips a target whose tick-snapped price would be zero', async () => {
    const result = await run({
      ledger: [own(40)],
      quotes: quoteMap([makeQuote({ ltp: 0.01 })]),
      instruments: instrumentMap([makeInstrument({ tickSize: 1 })]),
    });
    expect(result.proposals).toEqual([]);
  });
});
