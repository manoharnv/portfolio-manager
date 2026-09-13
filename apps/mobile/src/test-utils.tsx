/**
 * Fixture builders and render helpers (docs/00 §0.5 — prefer builders to inline
 * literals so a schema change is a one-file fix).
 *
 * Excluded from coverage in jest.config.js; never imported by app code.
 */
import type { ReactElement, ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react-native';
import type {
  AuditEvent,
  Book,
  BrokerSession,
  Config,
  FundsDoc,
  GuardrailCheck,
  HoldingDoc,
  OrderRecord,
  PositionDoc,
  Proposal,
} from '@pm/core';
import { AppContext, emptyAppState, type AppState } from './AppContext';
import type { ApiClient, SessionPayload } from './lib/api';

/** A fixed instant, deep inside NSE hours on a Tuesday. */
export const NOW = new Date('2026-02-03T05:00:00.000Z'); // 10:30 IST
export const NOW_ISO = NOW.toISOString();

export function isoPlus(seconds: number, from: Date = NOW): string {
  return new Date(from.getTime() + seconds * 1000).toISOString();
}

export const SYMBOL = { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'INFY' } as const;
export const SYMBOL_KEY = 'NSE:EQ:INFY';

export function buildGuardrailChecks(overrides: Partial<GuardrailCheck>[] = []): GuardrailCheck[] {
  const base: GuardrailCheck[] = [
    { name: 'killSwitch', ok: true, detail: 'kill switch off' },
    { name: 'maxOrderValue', ok: true, detail: 'within per-order cap' },
    { name: 'priceCollar', ok: true, detail: 'limit within collar' },
  ];
  return base.map((check, i) => ({ ...check, ...(overrides[i] ?? {}) }));
}

export function buildProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    uid: 'u1',
    createdAt: isoPlus(-60),
    createdBy: 'strategy-engine',
    strategyId: 'mean-reversion-v1',
    targetBroker: 'kite',
    bookId: 'swing',
    horizon: 'swing',
    status: 'pending',
    order: {
      symbol: { ...SYMBOL },
      side: 'BUY',
      quantity: 10,
      orderType: 'LIMIT',
      product: 'DELIVERY',
      validity: 'DAY',
      limitPrice: 1500,
    },
    rationale: {
      summary: 'RSI(14) at 24 with price back inside the lower band.',
      signals: { rsi: 24 },
      confidence: 'medium',
    },
    marketContext: {
      ltpAtProposal: 1500,
      estimatedValueInr: 15000,
      estimatedCharges: 25,
      capturedAt: isoPlus(-60),
    },
    guardrailPrecheck: { passed: true, checks: buildGuardrailChecks() },
    ttlExpiresAt: isoPlus(300),
    ...overrides,
  };
}

export function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    uid: 'u1',
    activeBroker: 'kite',
    environment: 'paper',
    killSwitch: false,
    tradingEnabled: true,
    guardrails: {
      maxOrderValueInr: 100_000,
      maxDailyNotionalInr: 500_000,
      maxOrdersPerDay: 10,
      allowedSegments: ['EQ'],
      allowedProducts: ['DELIVERY', 'INTRADAY'],
      symbolAllowlist: null,
      symbolBlocklist: [],
      priceCollarPct: 1,
      proposalTtlSeconds: 300,
      requireBiometric: true,
    },
    totalManagedCapitalInr: 1_000_000,
    reservePct: 10,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

export function buildSessionPayload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    activeBroker: 'kite',
    brokers: [
      {
        broker: 'kite',
        connected: true,
        expiresAt: isoPlus(3600),
        staticIpOk: true,
        needsLogin: false,
        reason: null,
      },
      {
        broker: 'dhan',
        connected: false,
        staticIpOk: false,
        needsLogin: true,
        reason: 'no session for today',
      },
    ],
    ...overrides,
  };
}

export function buildBrokerSession(overrides: Partial<BrokerSession> = {}): BrokerSession {
  return {
    broker: 'kite',
    connected: true,
    expiresAt: isoPlus(3600),
    staticIpOk: true,
    lastConnectedAt: isoPlus(-3600),
    ...overrides,
  };
}

export function buildBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'swing',
    label: 'Swing',
    enabled: true,
    allocationPct: 30,
    allocatedCapitalInr: 300_000,
    deployedInr: 120_000,
    realizedPnlInr: 4_500,
    product: 'DELIVERY',
    risk: {
      maxPositions: 8,
      maxPositionValueInr: 60_000,
      dailyLossStopInr: 10_000,
      perTradeRiskPct: 1,
    },
    ...overrides,
  };
}

export function buildHolding(overrides: Partial<HoldingDoc> = {}): HoldingDoc {
  return {
    symbol: { ...SYMBOL },
    symbolKey: SYMBOL_KEY,
    quantity: 25,
    avgCostPrice: 1400,
    lastPrice: 1500,
    pnl: 2500,
    raw: {},
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

export function buildPosition(overrides: Partial<PositionDoc> = {}): PositionDoc {
  return {
    symbol: { ...SYMBOL },
    symbolKey: SYMBOL_KEY,
    netQty: 5,
    product: 'INTRADAY',
    avgPrice: 1490,
    lastPrice: 1500,
    realizedPnl: 100,
    unrealizedPnl: 50,
    raw: {},
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

export function buildFunds(overrides: Partial<FundsDoc> = {}): FundsDoc {
  return {
    availableCash: 250_000,
    usedMargin: 50_000,
    availableMargin: 200_000,
    raw: {},
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

export function buildOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 'o1',
    uid: 'u1',
    proposalId: 'p1',
    broker: 'kite',
    brokerOrderId: 'BRK-1',
    idempotencyKey: 'pm-11111111-2222-4333-8444-555555555555',
    bookId: 'swing',
    horizon: 'swing',
    order: {
      symbol: { ...SYMBOL },
      side: 'BUY',
      quantity: 10,
      orderType: 'LIMIT',
      product: 'DELIVERY',
      validity: 'DAY',
      limitPrice: 1500,
    },
    status: 'OPEN',
    filledQty: 0,
    avgFillPrice: null,
    rejectionReason: null,
    approvedBy: 'u1',
    approvedAt: NOW_ISO,
    submittedAt: NOW_ISO,
    ipUsed: '203.0.113.7',
    environment: 'paper',
    brokerRawAck: {},
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

export function buildAuditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'a1',
    uid: 'u1',
    ts: NOW_ISO,
    actor: 'backend',
    type: 'order.submitted',
    refId: 'o1',
    detail: { orderId: 'o1', broker: 'kite' },
    ...overrides,
  };
}

/** Every method rejects loudly unless the test overrides it. */
export function fakeApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected api call: ${name}`);
  };
  return {
    health: unexpected('health'),
    session: unexpected('session'),
    loginUrl: unexpected('loginUrl'),
    completeLogin: unexpected('completeLogin'),
    holdings: unexpected('holdings'),
    positions: unexpected('positions'),
    funds: unexpected('funds'),
    executeProposal: unexpected('executeProposal'),
    cancelOrder: unexpected('cancelOrder'),
    order: unexpected('order'),
    setKillSwitch: unexpected('setKillSwitch'),
    ...overrides,
  } as ApiClient;
}

export function buildAppState(overrides: Partial<AppState> = {}): AppState {
  return emptyAppState({
    uid: 'u1',
    user: { uid: 'u1', email: 'you@example.com', displayName: 'You' } as AppState['user'],
    config: buildConfig(),
    effectiveConfig: buildConfig(),
    session: buildSessionPayload(),
    backendReachable: true,
    ...overrides,
  });
}

/**
 * Renders a screen inside a fixed `AppState`. `@testing-library/react-native`
 * v14 made `render`/`fireEvent`/`act` async, so every caller awaits.
 */
export function withApp(ui: ReactElement, state: Partial<AppState> = {}): Promise<RenderResult> {
  const value = buildAppState(state);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppContext.Provider value={value}>{children}</AppContext.Provider>
  );
  return render(ui, { wrapper });
}
