/**
 * Fixture builders. Excluded from the build and from coverage — nothing in
 * `dist/` imports this directory (docs/00 §0.5).
 */

import type {
  AuditEvent,
  Book,
  Candle,
  CanonicalSymbol,
  Config,
  Funds,
  Holding,
  InstrumentRef,
  LedgerEntry,
  Position,
  Proposal,
  Quote,
  SessionStatus,
} from '@pm/core';
import { symbolKey } from '@pm/core';
import type { StrategyDef, Tick } from '../types.js';
import { istInstantIso } from '../strategies/util.js';

export const TEST_UID = 'u1';

export const RELIANCE: CanonicalSymbol = {
  exchange: 'NSE',
  segment: 'EQ',
  tradingSymbol: 'RELIANCE',
};
export const INFY: CanonicalSymbol = { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'INFY' };
export const TCS: CanonicalSymbol = { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'TCS' };

/** Tuesday 13 Jan 2026, 10:00 IST (04:30 UTC) — inside the NSE session. */
export const NOW_IST_1000 = '2026-01-13T04:30:00.000Z';
/** Tuesday 13 Jan 2026, 15:20 IST — inside the square-off window. */
export const NOW_IST_1520 = '2026-01-13T09:50:00.000Z';
/** Tuesday 13 Jan 2026, 15:45 IST — the eod tick, market already closed. */
export const NOW_IST_1545 = '2026-01-13T10:15:00.000Z';
/** Saturday 17 Jan 2026, 10:00 IST. */
export const NOW_SATURDAY = '2026-01-17T04:30:00.000Z';

export const IST_DATE = '2026-01-13';

type Deep<T> = { [K in keyof T]?: T[K] extends object ? Deep<T[K]> : T[K] };

function merge<T extends object>(base: T, patch?: Deep<T> | undefined): T {
  if (patch === undefined) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k];
    out[k] =
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      prev !== null &&
      typeof prev === 'object' &&
      !Array.isArray(prev)
        ? merge(prev as object, v as Deep<object>)
        : v;
  }
  return out as T;
}

export function makeConfig(patch?: Deep<Config> | undefined): Config {
  return merge<Config>(
    {
      uid: TEST_UID,
      activeBroker: 'dhan',
      environment: 'dry-run',
      killSwitch: false,
      tradingEnabled: true,
      guardrails: {
        maxOrderValueInr: 100_000,
        maxDailyNotionalInr: 500_000,
        maxOrdersPerDay: 10,
        allowedSegments: ['EQ', 'FNO'],
        allowedProducts: ['DELIVERY', 'INTRADAY'],
        symbolAllowlist: null,
        symbolBlocklist: [],
        priceCollarPct: 2,
        proposalTtlSeconds: 900,
        requireBiometric: true,
      },
      totalManagedCapitalInr: 1_000_000,
      reservePct: 10,
      updatedAt: '2026-01-13T03:00:00.000Z',
    },
    patch,
  );
}

export function makeBook(patch?: Deep<Book> | undefined): Book {
  return merge<Book>(
    {
      id: 'long_term',
      label: 'Long term',
      enabled: true,
      allocationPct: 50,
      allocatedCapitalInr: 500_000,
      deployedInr: 0,
      realizedPnlInr: 0,
      product: 'DELIVERY',
      risk: {
        maxPositions: 20,
        maxPositionValueInr: 100_000,
        dailyLossStopInr: 10_000,
        perTradeRiskPct: 2,
      },
    },
    patch,
  );
}

export function makeSwingBook(patch?: Deep<Book> | undefined): Book {
  return makeBook({
    id: 'swing',
    label: 'Swing',
    allocationPct: 25,
    allocatedCapitalInr: 250_000,
    product: 'DELIVERY',
    ...patch,
  });
}

export function makeDayTradeBook(patch?: Deep<Book> | undefined): Book {
  return makeBook({
    id: 'day_trade',
    label: 'Day trade',
    allocationPct: 15,
    allocatedCapitalInr: 150_000,
    product: 'INTRADAY',
    ...patch,
  });
}

export function makeQuote(patch?: Partial<Quote> | undefined): Quote {
  return {
    symbol: RELIANCE,
    ltp: 2950,
    open: 2940,
    high: 2960,
    low: 2930,
    close: 2945,
    volume: 1_000_000,
    ts: NOW_IST_1000,
    ...patch,
  };
}

export function makeFunds(patch?: Partial<Funds> | undefined): Funds {
  return {
    availableCash: 500_000,
    usedMargin: 0,
    availableMargin: 500_000,
    raw: null,
    ...patch,
  };
}

export function makeInstrument(patch?: Partial<InstrumentRef> | undefined): InstrumentRef {
  return {
    broker: 'dhan',
    canonical: RELIANCE,
    brokerInstrumentId: '11536',
    exchangeSegmentCode: 'NSE_EQ',
    lotSize: 1,
    tickSize: 0.05,
    ...patch,
  };
}

export function makeSession(patch?: Partial<SessionStatus> | undefined): SessionStatus {
  return {
    broker: 'dhan',
    connected: true,
    expiresAt: '2026-01-13T18:30:00.000Z',
    staticIpOk: true,
    ...patch,
  };
}

export function makeHolding(patch?: Partial<Holding> | undefined): Holding {
  return {
    symbol: RELIANCE,
    quantity: 10,
    avgCostPrice: 2900,
    lastPrice: 2950,
    pnl: 500,
    raw: null,
    ...patch,
  };
}

export function makePosition(patch?: Partial<Position> | undefined): Position {
  return {
    symbol: RELIANCE,
    netQty: 10,
    product: 'DELIVERY',
    avgPrice: 2900,
    lastPrice: 2950,
    realizedPnl: 0,
    unrealizedPnl: 500,
    raw: null,
    ...patch,
  };
}

let ledgerSeq = 0;

export function makeLedgerEntry(patch?: Partial<LedgerEntry> | undefined): LedgerEntry {
  ledgerSeq += 1;
  return {
    id: `l${String(ledgerSeq).padStart(4, '0')}`,
    uid: TEST_UID,
    bookId: 'long_term',
    strategyId: 'dca',
    symbolKey: symbolKey(RELIANCE),
    product: 'DELIVERY',
    side: 'BUY',
    qty: 10,
    price: 2900,
    orderId: 'o1',
    ts: NOW_IST_1000,
    ...patch,
  };
}

export function makeProposal(patch?: Deep<Proposal> | undefined): Proposal {
  return merge<Proposal>(
    {
      id: 'p1',
      uid: TEST_UID,
      createdAt: NOW_IST_1000,
      createdBy: 'strategy-engine',
      strategyId: 'dca',
      targetBroker: 'dhan',
      bookId: 'long_term',
      horizon: 'long_term',
      status: 'pending',
      order: {
        symbol: RELIANCE,
        side: 'BUY',
        quantity: 10,
        orderType: 'LIMIT',
        product: 'DELIVERY',
        validity: 'DAY',
        limitPrice: 2950,
      },
      rationale: { summary: 'fixture', signals: { intent: 'dca' } },
      marketContext: {
        ltpAtProposal: 2950,
        estimatedValueInr: 29_500,
        capturedAt: NOW_IST_1000,
      },
      guardrailPrecheck: { passed: true, checks: [] },
      ttlExpiresAt: '2026-01-13T04:45:00.000Z',
    },
    patch,
  );
}

export function makeAuditEvent(patch?: Deep<AuditEvent> | undefined): AuditEvent {
  return merge<AuditEvent>(
    {
      id: 'a1',
      uid: TEST_UID,
      ts: NOW_IST_1000,
      actor: 'strategy-engine',
      type: 'proposal.created',
      detail: {},
    },
    patch,
  );
}

export function makeDef(patch?: Partial<StrategyDef> | undefined): StrategyDef {
  return {
    id: 'dca',
    bookId: 'long_term',
    horizon: 'long_term',
    enabled: true,
    params: {},
    ...patch,
  };
}

export const ALL_TICKS: readonly Tick[] = ['pre-open', 'intraday', 'eod'];

// ---------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------

export interface Bar {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Daily candles starting at `startIso`, one calendar day apart. */
export function dailyCandles(startIso: string, bars: readonly Bar[]): Candle[] {
  const start = new Date(startIso).getTime();
  return bars.map((b, i) => ({
    ts: new Date(start + i * 86_400_000).toISOString(),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  }));
}

/** Intraday candles on `dateKey`, starting at IST `startMinute`, every `stepMinutes`. */
export function intradayCandles(
  dateKey: string,
  startMinute: number,
  stepMinutes: number,
  bars: readonly Bar[],
): Candle[] {
  return bars.map((b, i) => ({
    ts: istInstantIso(dateKey, startMinute + i * stepMinutes),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  }));
}

/** A flat bar — handy for "nothing happens" series. */
export function flatBar(price: number, volume = 1000): Bar {
  return { o: price, h: price, l: price, c: price, v: volume };
}
