import { describe, expect, it } from 'vitest';
import { symbolKey } from '@pm/core';
import { DcaParamsSchema, dcaStrategy, isContributionDay } from './dca.js';
import {
  INFY,
  NOW_IST_1000,
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

const DEF = makeDef({ id: 'dca', bookId: 'long_term', horizon: 'long_term' });

const weekly = {
  instruments: [RELIANCE],
  amountInrPerInstrument: 10_000,
  frequency: 'weekly' as const,
  weekdayIst: 2, // Tuesday — NOW_IST_1000 is a Tuesday
};

function ctx(params: unknown, over: Record<string, unknown> = {}) {
  return makeStrategyContext({
    params,
    def: DEF,
    book: makeBook(),
    quotes: quoteMap([makeQuote({ ltp: 2950 })]),
    instruments: instrumentMap([makeInstrument()]),
    ...over,
  });
}

async function run(params: unknown, over: Record<string, unknown> = {}): Promise<StrategyResult> {
  return dcaStrategy.run(ctx(params, over));
}

describe('DcaParamsSchema', () => {
  it('requires weekdayIst for a weekly plan', () => {
    expect(() => DcaParamsSchema.parse({ ...weekly, weekdayIst: undefined })).toThrowError(
      /weekdayIst/,
    );
  });

  it('requires dayOfMonthIst for a monthly plan', () => {
    expect(() =>
      DcaParamsSchema.parse({ ...weekly, frequency: 'monthly', weekdayIst: undefined }),
    ).toThrowError(/dayOfMonthIst/);
  });

  it('rejects a non-positive amount', () => {
    expect(() => DcaParamsSchema.parse({ ...weekly, amountInrPerInstrument: 0 })).toThrow();
  });
});

describe('isContributionDay', () => {
  it('matches the IST weekday for a weekly plan', () => {
    expect(isContributionDay(NOW_IST_1000, DcaParamsSchema.parse(weekly))).toBe(true);
    expect(
      isContributionDay(NOW_IST_1000, DcaParamsSchema.parse({ ...weekly, weekdayIst: 3 })),
    ).toBe(false);
  });

  it('matches the IST day-of-month for a monthly plan', () => {
    const monthly = DcaParamsSchema.parse({
      instruments: [RELIANCE],
      amountInrPerInstrument: 10_000,
      frequency: 'monthly',
      dayOfMonthIst: 13,
    });
    expect(isContributionDay(NOW_IST_1000, monthly)).toBe(true);
  });
});

describe('dca strategy', () => {
  it('buys whole units of the fixed rupee amount at the LTP', async () => {
    const result = await run(weekly);
    expect(result.proposals).toHaveLength(1);
    const draft = result.proposals[0];
    expect(draft?.order).toMatchObject({
      side: 'BUY',
      quantity: 3, // floor(10000 / 2950)
      orderType: 'LIMIT',
      product: 'DELIVERY',
      limitPrice: 2950,
    });
    expect(draft?.intent).toBe('dca');
    expect(draft?.bookId).toBe('long_term');
    expect(draft?.horizon).toBe('long_term');
    expect(draft?.marketContext.estimatedValueInr).toBe(8850);
  });

  it('snaps the limit price onto the tick grid so the collar cannot reject it', async () => {
    const result = await run(weekly, {
      quotes: quoteMap([makeQuote({ ltp: 2950.37 })]),
    });
    expect(result.proposals[0]?.order.limitPrice).toBe(2950.35);
  });

  it('rounds the quantity down to a whole lot', async () => {
    const result = await run(weekly, {
      instruments: instrumentMap([makeInstrument({ lotSize: 5 })]),
    });
    // floor(10000/2950) = 3, which is below one lot of 5 → nothing.
    expect(result.proposals).toEqual([]);

    const bigger = await run(
      { ...weekly, amountInrPerInstrument: 20_000 },
      { instruments: instrumentMap([makeInstrument({ lotSize: 5 })]) },
    );
    expect(bigger.proposals[0]?.order.quantity).toBe(5);
  });

  it('proposes nothing when today is not a contribution day', async () => {
    const result = await run({ ...weekly, weekdayIst: 3 });
    expect(result.proposals).toEqual([]);
    expect(result.notes).toContain('not a weekly contribution day');
  });

  it('is DELIVERY-only — an INTRADAY book proposes nothing', async () => {
    const result = await run(weekly, { book: makeDayTradeBook() });
    expect(result.proposals).toEqual([]);
    expect(result.notes).toContain('INTRADAY');
  });

  it('does not re-buy what the ledger says it already bought today', async () => {
    const result = await run(weekly, {
      ledger: [
        makeLedgerEntry({
          bookId: 'long_term',
          strategyId: 'dca',
          side: 'BUY',
          symbolKey: symbolKey(RELIANCE),
          ts: NOW_IST_1000,
        }),
      ],
    });
    expect(result.proposals).toEqual([]);
  });

  it('still buys when yesterday is the only ledger entry', async () => {
    const result = await run(weekly, {
      ledger: [makeLedgerEntry({ ts: '2026-01-12T04:30:00.000Z' })],
    });
    expect(result.proposals).toHaveLength(1);
  });

  it('skips an instrument with no live quote — fail closed', async () => {
    const result = await run({ ...weekly, instruments: [RELIANCE, INFY] });
    expect(result.proposals.map((p) => p.order.symbol.tradingSymbol)).toEqual(['RELIANCE']);
  });

  it('skips a quote whose LTP is unusable', async () => {
    const result = await run(weekly, { quotes: quoteMap([makeQuote({ ltp: 0 })]) });
    expect(result.proposals).toEqual([]);
  });

  it('proposes nothing when the amount buys less than one unit', async () => {
    const result = await run({ ...weekly, amountInrPerInstrument: 100 });
    expect(result.proposals).toEqual([]);
  });

  it('runs on the intraday tick only', () => {
    expect(dcaStrategy.schedule).toEqual(['intraday']);
    expect(dcaStrategy.horizon).toBe('long_term');
  });

  it('throws on invalid persisted params — fail closed', async () => {
    await expect(run({ instruments: [] })).rejects.toThrow();
  });
});
