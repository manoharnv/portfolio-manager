/**
 * Backtest harness — docs/05-strategy-engine.md §5.8.
 *
 * A deterministic strategy is a pure decision function, so the same rule that
 * writes live proposals can be replayed over historical candles. This harness is
 * deliberately small but honest:
 *
 * - **fills at the next candle's open** — a decision made on bar *i* cannot
 *   transact at bar *i*'s close (that is look-ahead bias);
 * - **flat commission per executed trade**, charged to cash;
 * - a **virtual book + ledger**: cash, per-symbol average cost, realized P&L;
 * - no shorting and no leverage — a BUY is clamped to available cash and a SELL
 *   to the quantity actually held.
 *
 * Pure: no clock, no I/O, no randomness. Same input ⇒ same report.
 */

import type { Candle, CanonicalSymbol, Side } from '@pm/core';
import { symbolKey } from '@pm/core';
import { roundMoney } from './strategies/util.js';

export class BacktestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BacktestError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface BacktestSeries {
  symbol: CanonicalSymbol;
  /** Chronological; every series must share one timeline. */
  candles: readonly Candle[];
}

export interface BacktestPosition {
  qty: number;
  avgCostInr: number;
}

export interface BacktestState {
  cashInr: number;
  positions: ReadonlyMap<string, BacktestPosition>;
  /** Cash + mark-to-market of open positions at the current bar's close. */
  equityInr: number;
}

export interface BacktestBar {
  index: number;
  ts: string;
  /** `symbolKey` → this bar's candle. */
  candles: ReadonlyMap<string, Candle>;
  /** `symbolKey` → every candle up to and including this bar. */
  history: ReadonlyMap<string, readonly Candle[]>;
}

export interface BacktestSignal {
  symbolKey: string;
  side: Side;
  quantity: number;
}

export type BacktestDecide = (bar: BacktestBar, state: BacktestState) => readonly BacktestSignal[];

export interface BacktestInput {
  series: readonly BacktestSeries[];
  decide: BacktestDecide;
  initialCapitalInr: number;
  /** Flat rupees per executed trade (brokerage + taxes stand-in). */
  commissionInr?: number | undefined;
}

export interface BacktestTrade {
  ts: string;
  symbolKey: string;
  side: Side;
  quantity: number;
  priceInr: number;
  commissionInr: number;
  /** Non-zero only on the reducing leg. */
  realizedPnlInr: number;
}

export interface EquityPoint {
  ts: string;
  cashInr: number;
  equityInr: number;
}

export interface BacktestSummary {
  initialCapitalInr: number;
  finalEquityInr: number;
  returnPct: number;
  maxDrawdownPct: number;
  trades: number;
  wins: number;
  losses: number;
  /** wins / (wins + losses); 0 when nothing closed. */
  winRate: number;
}

export interface BacktestResult {
  equityCurve: EquityPoint[];
  trades: BacktestTrade[];
  summary: BacktestSummary;
}

interface MutablePosition {
  qty: number;
  avgCostInr: number;
}

function assertTimeline(series: readonly BacktestSeries[]): string[] {
  if (series.length === 0) throw new BacktestError('at least one series is required');
  const first = series[0];
  if (first === undefined || first.candles.length === 0) {
    throw new BacktestError('every series needs at least one candle');
  }
  const timeline = first.candles.map((c) => c.ts);
  for (const s of series) {
    if (s.candles.length !== timeline.length) {
      throw new BacktestError(
        `series ${symbolKey(s.symbol)} has ${s.candles.length} candles, expected ${timeline.length}`,
      );
    }
    for (let i = 0; i < timeline.length; i++) {
      if (s.candles[i]?.ts !== timeline[i]) {
        throw new BacktestError(
          `series ${symbolKey(s.symbol)} diverges from the timeline at index ${i}`,
        );
      }
    }
  }
  return timeline;
}

function markToMarket(
  cashInr: number,
  positions: ReadonlyMap<string, MutablePosition>,
  closes: ReadonlyMap<string, number>,
): number {
  let equity = cashInr;
  for (const [key, position] of positions) {
    if (position.qty === 0) continue;
    equity += position.qty * (closes.get(key) ?? position.avgCostInr);
  }
  return equity;
}

function maxDrawdownPct(curve: readonly EquityPoint[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equityInr);
    if (peak > 0) worst = Math.max(worst, ((peak - point.equityInr) / peak) * 100);
  }
  return worst;
}

/** Replay `decide` over the series and report what it would have done. */
export function runBacktest(input: BacktestInput): BacktestResult {
  if (!Number.isFinite(input.initialCapitalInr) || input.initialCapitalInr <= 0) {
    throw new BacktestError(`initialCapitalInr must be positive, got ${input.initialCapitalInr}`);
  }
  const timeline = assertTimeline(input.series);
  const commissionInr = input.commissionInr ?? 0;
  if (!Number.isFinite(commissionInr) || commissionInr < 0) {
    throw new BacktestError(`commissionInr must be ≥ 0, got ${commissionInr}`);
  }

  const keys = input.series.map((s) => symbolKey(s.symbol));
  const positions = new Map<string, MutablePosition>();
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  let cashInr = input.initialCapitalInr;
  let pending: readonly BacktestSignal[] = [];

  for (let i = 0; i < timeline.length; i++) {
    const ts = timeline[i] ?? '';
    const bars = new Map<string, Candle>();
    const history = new Map<string, readonly Candle[]>();
    const closes = new Map<string, number>();

    for (let s = 0; s < input.series.length; s++) {
      const key = keys[s];
      const entry = input.series[s];
      if (key === undefined || entry === undefined) continue;
      const candle = entry.candles[i];
      if (candle === undefined) continue;
      bars.set(key, candle);
      history.set(key, entry.candles.slice(0, i + 1));
      closes.set(key, candle.close);
    }

    // 1. Fill what the previous bar decided, at this bar's OPEN.
    for (const signal of pending) {
      const candle = bars.get(signal.symbolKey);
      if (candle === undefined || !(candle.open > 0)) continue;
      const price = candle.open;
      const position = positions.get(signal.symbolKey) ?? { qty: 0, avgCostInr: 0 };

      let quantity = Math.floor(signal.quantity);
      if (quantity <= 0) continue;

      if (signal.side === 'BUY') {
        const affordable = Math.floor(Math.max(0, cashInr - commissionInr) / price);
        quantity = Math.min(quantity, affordable);
        if (quantity <= 0) continue;
        const cost = quantity * price;
        position.avgCostInr =
          (position.qty * position.avgCostInr + cost) / Math.max(1, position.qty + quantity);
        position.qty += quantity;
        cashInr -= cost + commissionInr;
        positions.set(signal.symbolKey, position);
        trades.push({
          ts,
          symbolKey: signal.symbolKey,
          side: 'BUY',
          quantity,
          priceInr: price,
          commissionInr,
          realizedPnlInr: 0,
        });
        continue;
      }

      quantity = Math.min(quantity, position.qty);
      if (quantity <= 0) continue;
      const proceeds = quantity * price;
      const realizedPnlInr = roundMoney(
        quantity * (price - position.avgCostInr) - commissionInr,
        2,
      );
      position.qty -= quantity;
      if (position.qty === 0) position.avgCostInr = 0;
      cashInr += proceeds - commissionInr;
      positions.set(signal.symbolKey, position);
      trades.push({
        ts,
        symbolKey: signal.symbolKey,
        side: 'SELL',
        quantity,
        priceInr: price,
        commissionInr,
        realizedPnlInr,
      });
    }

    // 2. Mark to market at this bar's close.
    const equityInr = roundMoney(markToMarket(cashInr, positions, closes), 2);
    equityCurve.push({ ts, cashInr: roundMoney(cashInr, 2), equityInr });

    // 3. Decide for the next bar.
    const snapshot: BacktestState = {
      cashInr,
      positions: new Map([...positions].map(([k, p]) => [k, { ...p }])),
      equityInr,
    };
    pending = input.decide({ index: i, ts, candles: bars, history }, snapshot);
  }

  const finalEquityInr = equityCurve.at(-1)?.equityInr ?? input.initialCapitalInr;
  const closed = trades.filter((t) => t.side === 'SELL');
  const wins = closed.filter((t) => t.realizedPnlInr > 0).length;
  const losses = closed.filter((t) => t.realizedPnlInr < 0).length;

  return {
    equityCurve,
    trades,
    summary: {
      initialCapitalInr: input.initialCapitalInr,
      finalEquityInr,
      returnPct: roundMoney(
        ((finalEquityInr - input.initialCapitalInr) / input.initialCapitalInr) * 100,
        4,
      ),
      maxDrawdownPct: roundMoney(maxDrawdownPct(equityCurve), 4),
      trades: trades.length,
      wins,
      losses,
      winRate: wins + losses === 0 ? 0 : roundMoney(wins / (wins + losses), 4),
    },
  };
}
