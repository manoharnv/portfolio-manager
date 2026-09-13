import { describe, expect, it } from 'vitest';
import { symbolKey } from '@pm/core';
import {
  BacktestError,
  runBacktest,
  type BacktestDecide,
  type BacktestSignal,
} from './backtest.js';
import { INFY, RELIANCE, dailyCandles, flatBar } from './test-utils/index.js';

const KEY = symbolKey(RELIANCE);

/** opens 100, 106, 111, 116 — closes 105, 110, 115, 120. */
const RISING = dailyCandles('2026-01-05T04:00:00.000Z', [
  { o: 100, h: 110, l: 95, c: 105, v: 1000 },
  { o: 106, h: 115, l: 100, c: 110, v: 1000 },
  { o: 111, h: 120, l: 105, c: 115, v: 1000 },
  { o: 116, h: 125, l: 110, c: 120, v: 1000 },
]);

const series = (candles = RISING) => [{ symbol: RELIANCE, candles }];

/** Emit `signals` on bar `index` and nothing otherwise. */
function onBar(index: number, signals: BacktestSignal[]): BacktestDecide {
  return (bar) => (bar.index === index ? signals : []);
}

const NEVER: BacktestDecide = () => [];

describe('runBacktest — validation', () => {
  it('rejects an empty or capital-less setup', () => {
    expect(() => runBacktest({ series: [], decide: NEVER, initialCapitalInr: 1000 })).toThrow(
      BacktestError,
    );
    expect(() =>
      runBacktest({
        series: [{ symbol: RELIANCE, candles: [] }],
        decide: NEVER,
        initialCapitalInr: 1,
      }),
    ).toThrow(/at least one candle/);
    expect(() => runBacktest({ series: series(), decide: NEVER, initialCapitalInr: 0 })).toThrow(
      /initialCapitalInr/,
    );
    expect(() =>
      runBacktest({ series: series(), decide: NEVER, initialCapitalInr: 1000, commissionInr: -1 }),
    ).toThrow(/commissionInr/);
  });

  it('rejects series that do not share one timeline', () => {
    expect(() =>
      runBacktest({
        series: [
          { symbol: RELIANCE, candles: RISING },
          { symbol: INFY, candles: RISING.slice(0, 2) },
        ],
        decide: NEVER,
        initialCapitalInr: 1000,
      }),
    ).toThrow(/expected 4/);

    expect(() =>
      runBacktest({
        series: [
          { symbol: RELIANCE, candles: RISING },
          { symbol: INFY, candles: dailyCandles('2026-02-05T04:00:00.000Z', RISING.map(toBar)) },
        ],
        decide: NEVER,
        initialCapitalInr: 1000,
      }),
    ).toThrow(/diverges from the timeline/);
  });
});

function toBar(c: { open: number; high: number; low: number; close: number; volume: number }) {
  return { o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume };
}

describe('runBacktest — fills model', () => {
  it('fills a decision at the NEXT bar open, never the deciding bar', () => {
    const result = runBacktest({
      series: series(),
      decide: onBar(0, [{ symbolKey: KEY, side: 'BUY', quantity: 10 }]),
      initialCapitalInr: 10_000,
    });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      ts: RISING[1]?.ts,
      side: 'BUY',
      quantity: 10,
      priceInr: 106,
      realizedPnlInr: 0,
    });
    // Bar 0 is still all cash: the order had not been placed yet.
    expect(result.equityCurve[0]).toEqual({
      ts: RISING[0]?.ts,
      cashInr: 10_000,
      equityInr: 10_000,
    });
    expect(result.equityCurve[1]).toEqual({ ts: RISING[1]?.ts, cashInr: 8940, equityInr: 10_040 });
  });

  it('never fills the last bar’s decision', () => {
    const result = runBacktest({
      series: series(RISING.slice(0, 2)),
      decide: () => [{ symbolKey: KEY, side: 'BUY', quantity: 1 }],
      initialCapitalInr: 10_000,
    });
    expect(result.trades).toHaveLength(1);
  });

  it('realizes P&L on the reducing leg and charges commission both ways', () => {
    const result = runBacktest({
      series: series(),
      decide: (bar) =>
        bar.index === 0
          ? [{ symbolKey: KEY, side: 'BUY', quantity: 10 }]
          : bar.index === 1
            ? [{ symbolKey: KEY, side: 'SELL', quantity: 10 }]
            : [],
      initialCapitalInr: 10_000,
      commissionInr: 20,
    });
    expect(result.trades.map((t) => t.side)).toEqual(['BUY', 'SELL']);
    expect(result.trades[1]).toMatchObject({ priceInr: 111, realizedPnlInr: 30 });
    // 10 000 − (1060 + 20) + (1110 − 20) = 10 010
    expect(result.summary.finalEquityInr).toBe(10_010);
    expect(result.summary.wins).toBe(1);
    expect(result.summary.losses).toBe(0);
    expect(result.summary.winRate).toBe(1);
  });

  it('clamps a BUY to available cash and a SELL to the quantity held', () => {
    const buy = runBacktest({
      series: series(),
      decide: onBar(0, [{ symbolKey: KEY, side: 'BUY', quantity: 100 }]),
      initialCapitalInr: 500,
    });
    expect(buy.trades[0]?.quantity).toBe(4); // floor(500 / 106)

    const sell = runBacktest({
      series: series(),
      decide: (bar) =>
        bar.index === 0
          ? [{ symbolKey: KEY, side: 'BUY', quantity: 3 }]
          : bar.index === 1
            ? [{ symbolKey: KEY, side: 'SELL', quantity: 10 }]
            : [],
      initialCapitalInr: 10_000,
    });
    expect(sell.trades[1]?.quantity).toBe(3);
  });

  it('ignores unfillable signals', () => {
    const result = runBacktest({
      series: series(),
      decide: onBar(0, [
        { symbolKey: KEY, side: 'BUY', quantity: 0 },
        { symbolKey: KEY, side: 'SELL', quantity: 5 }, // nothing held
        { symbolKey: symbolKey(INFY), side: 'BUY', quantity: 5 }, // no such series
      ]),
      initialCapitalInr: 10_000,
    });
    expect(result.trades).toEqual([]);
    expect(result.summary.returnPct).toBe(0);
  });

  it('cannot afford anything when cash is below one unit', () => {
    const result = runBacktest({
      series: series(),
      decide: onBar(0, [{ symbolKey: KEY, side: 'BUY', quantity: 1 }]),
      initialCapitalInr: 50,
    });
    expect(result.trades).toEqual([]);
  });

  it('averages cost across two entries', () => {
    const result = runBacktest({
      series: series(),
      decide: (bar) =>
        bar.index === 0 || bar.index === 1 ? [{ symbolKey: KEY, side: 'BUY', quantity: 10 }] : [],
      initialCapitalInr: 10_000,
    });
    // 10 @ 106 + 10 @ 111 ⇒ average 108.5
    const state = result.equityCurve.at(-1);
    expect(result.trades).toHaveLength(2);
    expect(state?.cashInr).toBe(10_000 - 1060 - 1110);
  });
});

describe('runBacktest — report', () => {
  it('gives a flat equity curve for a strategy that never trades', () => {
    const result = runBacktest({ series: series(), decide: NEVER, initialCapitalInr: 10_000 });
    expect(result.trades).toEqual([]);
    expect(result.equityCurve.map((p) => p.equityInr)).toEqual([10_000, 10_000, 10_000, 10_000]);
    expect(result.summary).toMatchObject({
      finalEquityInr: 10_000,
      returnPct: 0,
      maxDrawdownPct: 0,
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
    });
  });

  it('measures peak-to-trough drawdown', () => {
    const humped = dailyCandles('2026-01-05T04:00:00.000Z', [
      flatBar(100),
      { o: 100, h: 200, l: 100, c: 200, v: 10 },
      { o: 200, h: 200, l: 50, c: 50, v: 10 },
      flatBar(80),
    ]);
    const result = runBacktest({
      series: series(humped),
      decide: onBar(0, [{ symbolKey: KEY, side: 'BUY', quantity: 10 }]),
      initialCapitalInr: 10_000,
    });
    // equity: 10 000 → 9000+2000=11 000 → 9000+500=9500 → 9000+800=9800
    expect(result.equityCurve.map((p) => p.equityInr)).toEqual([10_000, 11_000, 9500, 9800]);
    expect(result.summary.maxDrawdownPct).toBeCloseTo(13.6364, 3);
    expect(result.summary.returnPct).toBeCloseTo(-2, 6);
  });

  it('counts a losing close', () => {
    const falling = dailyCandles('2026-01-05T04:00:00.000Z', [
      flatBar(100),
      flatBar(100),
      flatBar(50),
      flatBar(50),
    ]);
    const result = runBacktest({
      series: series(falling),
      decide: (bar) =>
        bar.index === 0
          ? [{ symbolKey: KEY, side: 'BUY', quantity: 10 }]
          : bar.index === 1
            ? [{ symbolKey: KEY, side: 'SELL', quantity: 10 }]
            : [],
      initialCapitalInr: 10_000,
    });
    expect(result.trades[1]?.realizedPnlInr).toBe(-500);
    expect(result.summary).toMatchObject({ wins: 0, losses: 1, winRate: 0 });
  });

  it('handles several symbols on one timeline', () => {
    const result = runBacktest({
      series: [
        { symbol: RELIANCE, candles: RISING },
        { symbol: INFY, candles: RISING },
      ],
      decide: onBar(0, [
        { symbolKey: KEY, side: 'BUY', quantity: 5 },
        { symbolKey: symbolKey(INFY), side: 'BUY', quantity: 5 },
      ]),
      initialCapitalInr: 10_000,
    });
    expect(result.trades).toHaveLength(2);
    expect(result.summary.finalEquityInr).toBe(10_000 - 2 * 530 + 2 * 5 * 120);
  });

  it('exposes the running state and history to the decision function', () => {
    const seen: number[] = [];
    runBacktest({
      series: series(),
      decide: (bar, state) => {
        seen.push(bar.history.get(KEY)?.length ?? 0);
        expect(state.cashInr).toBeGreaterThan(0);
        expect(bar.candles.get(KEY)?.close).toBe(RISING[bar.index]?.close);
        return [];
      },
      initialCapitalInr: 10_000,
    });
    expect(seen).toEqual([1, 2, 3, 4]);
  });
});
