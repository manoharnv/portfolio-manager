/**
 * Ports for live market / portfolio / session evidence.
 *
 * Every one of these is an interface, never a concrete client: the harness and
 * the strategies are handed fakes in tests (docs/00 §0.5 — no network, ever) and
 * thin `BrokerReadAdapter` / Firestore implementations in production.
 *
 * The broker-backed implementations are built from a **`BrokerReadAdapter`**
 * only (docs/05 §5.1); nothing in this package can reach an order endpoint.
 */

import type {
  Broker,
  Candle,
  CanonicalSymbol,
  Funds,
  HistoricalRequest,
  Holding,
  InstrumentRef,
  Position,
  Quote,
  SessionStatus,
  TodayAggregates,
} from '@pm/core';

/** The portfolio half of a `StrategyContext` (docs/05 §5.3). */
export interface PortfolioSnapshot {
  holdings: Holding[];
  positions: Position[];
  funds: Funds;
}

export interface PortfolioSource {
  snapshot(uid: string): Promise<PortfolioSnapshot>;
}

export interface MarketData {
  /** Keyed by `symbolKey(sym)`. A symbol with no quote is simply absent — the
   *  caller must fail closed, never assume a price. */
  quotes(symbols: readonly CanonicalSymbol[]): Promise<Map<string, Quote>>;
  historical(req: HistoricalRequest): Promise<Candle[]>;
  /** `undefined` when the instrument cannot be resolved ⇒ `tickLotValidity` fails. */
  instrument(symbol: CanonicalSymbol): Promise<InstrumentRef | undefined>;
}

export interface SessionStatusSource {
  /** `undefined` when nothing is known ⇒ the `sessionValid` guardrail fails. */
  status(uid: string, broker: Broker): Promise<SessionStatus | undefined>;
}

/** Today's (IST) order count + notional, for the daily-cap guardrails. */
export interface AggregatesSource {
  today(uid: string, istDateKey: string): Promise<TodayAggregates>;
}
