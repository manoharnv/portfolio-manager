/**
 * Fixture builders for tests only. Excluded from the build (`tsconfig.build.json`)
 * and from coverage — nothing in `dist/` imports this file.
 */

import type {
  CanonicalSymbol,
  Funds,
  InstrumentRef,
  NormalizedOrder,
  Position,
  Quote,
  SessionStatus,
} from './domain.js';
import { symbolKey } from './domain.js';
import type { Book, Config, LedgerEntry, Proposal } from './schemas.js';

export const RELIANCE: CanonicalSymbol = {
  exchange: 'NSE',
  segment: 'EQ',
  tradingSymbol: 'RELIANCE',
};
export const INFY: CanonicalSymbol = { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'INFY' };

/** A Tuesday, 10:00 IST (04:30 UTC) — inside the NSE session. */
export const MARKET_OPEN_NOW = '2026-01-13T04:30:00.000Z';

type Deep<T> = { [K in keyof T]?: T[K] extends object ? Deep<T[K]> : T[K] };

function merge<T extends object>(base: T, patch?: Deep<T>): T {
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

export function makeOrder(patch?: Partial<NormalizedOrder>): NormalizedOrder {
  return {
    symbol: RELIANCE,
    side: 'BUY',
    quantity: 10,
    orderType: 'LIMIT',
    product: 'DELIVERY',
    validity: 'DAY',
    limitPrice: 2950.5,
    ...patch,
  };
}

export function makeConfig(patch?: Deep<Config>): Config {
  return merge<Config>(
    {
      uid: 'u1',
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

export function makeQuote(patch?: Partial<Quote>): Quote {
  return {
    symbol: RELIANCE,
    ltp: 2950,
    open: 2940,
    high: 2960,
    low: 2930,
    close: 2945,
    volume: 1_000_000,
    ts: MARKET_OPEN_NOW,
    ...patch,
  };
}

export function makeFunds(patch?: Partial<Funds>): Funds {
  return {
    availableCash: 500_000,
    usedMargin: 0,
    availableMargin: 500_000,
    raw: null,
    ...patch,
  };
}

export function makeInstrument(patch?: Partial<InstrumentRef>): InstrumentRef {
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

export function makeSession(patch?: Partial<SessionStatus>): SessionStatus {
  return {
    broker: 'dhan',
    connected: true,
    expiresAt: '2026-01-13T18:30:00.000Z',
    staticIpOk: true,
    ...patch,
  };
}

export function makePosition(patch?: Partial<Position>): Position {
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

export function makeProposal(patch?: Deep<Proposal>): Proposal {
  return merge<Proposal>(
    {
      id: 'p1',
      uid: 'u1',
      createdAt: MARKET_OPEN_NOW,
      createdBy: 'strategy-engine',
      strategyId: 'momentum-v1',
      targetBroker: 'dhan',
      bookId: 'long_term',
      horizon: 'long_term',
      status: 'pending',
      order: makeOrder(),
      rationale: { summary: '20-DMA crossover', signals: { dma20: 2900 } },
      marketContext: {
        ltpAtProposal: 2950,
        estimatedValueInr: 29_505,
        capturedAt: MARKET_OPEN_NOW,
      },
      guardrailPrecheck: { passed: true, checks: [] },
      ttlExpiresAt: '2026-01-13T04:45:00.000Z',
    },
    patch,
  );
}

let ledgerSeq = 0;

export function makeLedgerEntry(patch?: Partial<LedgerEntry>): LedgerEntry {
  ledgerSeq += 1;
  return {
    id: `l${String(ledgerSeq).padStart(4, '0')}`,
    uid: 'u1',
    bookId: 'long_term',
    strategyId: 'momentum-v1',
    symbolKey: symbolKey(RELIANCE),
    product: 'DELIVERY',
    side: 'BUY',
    qty: 10,
    price: 2900,
    orderId: 'o1',
    ts: MARKET_OPEN_NOW,
    ...patch,
  };
}

export function makeBook(patch?: Deep<Book>): Book {
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
