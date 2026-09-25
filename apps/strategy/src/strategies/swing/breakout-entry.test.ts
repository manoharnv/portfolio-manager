import { describe, expect, it } from 'vitest';
import { symbolKey } from '@pm/core';
import type { Candle } from '@pm/core';
import { breakoutEntryStrategy, evaluateBreakout } from './breakout-entry.js';
import {
  RELIANCE,
  dailyCandles,
  instrumentMap,
  makeDef,
  makeInstrument,
  makeLedgerEntry,
  makeQuote,
  makeStrategyContext,
  makeSwingBook,
  quoteMap,
} from '../../test-utils/index.js';
import type { StrategyResult } from '../../types.js';

const DEF = makeDef({ id: 'breakout_entry', bookId: 'swing', horizon: 'swing' });

/** Base of 3 candles with high 100 and volume 1000, then the decision candle. */
function series(close: number, volume: number): Candle[] {
  return dailyCandles('2026-01-06T04:00:00.000Z', [
    { o: 98, h: 100, l: 96, c: 99, v: 1000 },
    { o: 99, h: 100, l: 97, c: 99, v: 1000 },
    { o: 99, h: 100, l: 97, c: 99, v: 1000 },
    { o: 99, h: Math.max(100, close), l: 97, c: close, v: volume },
  ]);
}

const params = {
  instruments: [RELIANCE],
  lookbackCandles: 3,
  volumeMultiple: 1.5,
  stopPct: 10,
  interval: '1d' as const,
};

/** 250 000 book × 2 % risk = ₹5 000; entry 100, stop 90 ⇒ risk/unit 10 ⇒ 500 units. */
async function run(
  candles: Candle[],
  over: Record<string, unknown> = {},
  p: unknown = params,
): Promise<StrategyResult> {
  return breakoutEntryStrategy.run(
    makeStrategyContext({
      params: p,
      def: DEF,
      book: makeSwingBook({ allocatedCapitalInr: 250_000 }),
      quotes: quoteMap([makeQuote({ ltp: 100 })]),
      instruments: instrumentMap([makeInstrument({ tickSize: 0.05 })]),
      candles: new Map([[symbolKey(RELIANCE), candles]]),
      ...over,
    }),
  );
}

describe('evaluateBreakout', () => {
  it('needs lookback + 1 candles', () => {
    expect(evaluateBreakout(series(105, 5000).slice(0, 3), 3, 1.5)).toBeUndefined();
  });

  it('reads the base high and average volume from the prior candles only', () => {
    const signal = evaluateBreakout(series(105, 5000), 3, 1.5);
    expect(signal).toMatchObject({
      priorHigh: 100,
      avgVolume: 1000,
      close: 105,
      volume: 5000,
      breakout: true,
      volumeConfirmed: true,
    });
  });

  it('is strict at the boundary: close == priorHigh is not a breakout', () => {
    expect(evaluateBreakout(series(100, 5000), 3, 1.5)?.breakout).toBe(false);
  });

  it('is strict at the volume boundary', () => {
    expect(evaluateBreakout(series(105, 1500), 3, 1.5)?.volumeConfirmed).toBe(false);
    expect(evaluateBreakout(series(105, 1501), 3, 1.5)?.volumeConfirmed).toBe(true);
  });
});

describe('breakout-entry strategy', () => {
  it('sizes the position from per-trade risk', async () => {
    const result = await run(series(105, 5000));
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.order).toMatchObject({
      side: 'BUY',
      orderType: 'LIMIT',
      product: 'DELIVERY',
      limitPrice: 100,
      quantity: 500,
    });
    expect(result.proposals[0]?.intent).toBe('entry');
    expect(result.proposals[0]?.rationale.signals['stopPrice']).toBe(90);
  });

  it('caps the size at the book budget and maxPositionValueInr', async () => {
    const result = await run(series(105, 5000), {
      book: makeSwingBook({
        allocatedCapitalInr: 250_000,
        deployedInr: 0,
        risk: {
          maxPositions: 5,
          maxPositionValueInr: 20_000,
          dailyLossStopInr: 1,
          perTradeRiskPct: 2,
        },
      }),
    });
    expect(result.proposals[0]?.order.quantity).toBe(200); // ₹20 000 / ₹100
  });

  it('caps the size at the remaining book budget', async () => {
    const result = await run(series(105, 5000), {
      book: makeSwingBook({ allocatedCapitalInr: 250_000, deployedInr: 245_000 }),
    });
    expect(result.proposals[0]?.order.quantity).toBe(50); // ₹5 000 left
  });

  it('rounds the size down to whole lots', async () => {
    const result = await run(series(105, 5000), {
      instruments: instrumentMap([makeInstrument({ lotSize: 300, tickSize: 0.05 })]),
    });
    expect(result.proposals[0]?.order.quantity).toBe(300);
  });

  it('proposes nothing without a breakout', async () => {
    expect((await run(series(99, 5000))).proposals).toEqual([]);
  });

  it('proposes nothing without volume confirmation', async () => {
    expect((await run(series(105, 1000))).proposals).toEqual([]);
  });

  it('never adds to a position the book already holds', async () => {
    const result = await run(series(105, 5000), {
      ledger: [makeLedgerEntry({ bookId: 'swing', qty: 5, symbolKey: symbolKey(RELIANCE) })],
    });
    expect(result.proposals).toEqual([]);
  });

  it('skips a symbol with no quote — fail closed', async () => {
    expect((await run(series(105, 5000), { quotes: quoteMap([]) })).proposals).toEqual([]);
  });

  it('proposes nothing when there is no candle history', async () => {
    expect((await run([])).proposals).toEqual([]);
  });

  it('proposes nothing when the book has no capital or no risk budget', async () => {
    const noCapital = await run(series(105, 5000), {
      book: makeSwingBook({ allocatedCapitalInr: 0 }),
    });
    expect(noCapital.notes).toContain('no allocated capital');

    const noRisk = await run(series(105, 5000), {
      book: makeSwingBook({
        risk: {
          maxPositions: 5,
          maxPositionValueInr: 100,
          dailyLossStopInr: 1,
          perTradeRiskPct: 0,
        },
      }),
    });
    expect(noRisk.notes).toContain('perTradeRiskPct');
  });

  it('honours a params-level risk override', async () => {
    const result = await run(series(105, 5000), {}, { ...params, perTradeRiskPct: 1 });
    expect(result.proposals[0]?.order.quantity).toBe(250);
  });

  it('proposes nothing when the entry price rounds off the tick grid to zero', async () => {
    const result = await run(series(105, 5000), {
      quotes: quoteMap([makeQuote({ ltp: 0.01 })]),
      instruments: instrumentMap([makeInstrument({ tickSize: 0.05 })]),
    });
    expect(result.proposals).toEqual([]);
  });
});
