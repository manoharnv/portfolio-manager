/**
 * Fixture builders for this package's tests only — mirrors the pattern in
 * `packages/core/src/test-utils.ts`. Excluded from the build and from
 * coverage (vitest.config.ts, tsconfig.build.json).
 */
import type { AuditEvent, BrokerSession, Config, OrderRecord, Proposal } from '@pm/core';

export const UID = 'u1';

export function makeProposal(patch: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    uid: UID,
    createdAt: '2026-01-13T04:00:00.000Z',
    createdBy: 'strategy-engine',
    strategyId: 'momentum-v1',
    targetBroker: 'dhan',
    bookId: 'long_term',
    horizon: 'long_term',
    status: 'pending',
    order: {
      symbol: { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'INFY' },
      side: 'BUY',
      quantity: 10,
      orderType: 'LIMIT',
      product: 'DELIVERY',
      validity: 'DAY',
      limitPrice: 1500,
    },
    rationale: { summary: '20-DMA crossover', signals: {} },
    marketContext: {
      ltpAtProposal: 1500,
      estimatedValueInr: 15_000,
      capturedAt: '2026-01-13T04:00:00.000Z',
    },
    guardrailPrecheck: { passed: true, checks: [] },
    ttlExpiresAt: '2026-01-13T04:15:00.000Z',
    ...patch,
  };
}

export function makeOrderRecord(patch: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 'o1',
    uid: UID,
    proposalId: 'p1',
    broker: 'dhan',
    brokerOrderId: 'b-order-1',
    idempotencyKey: 'idem-1',
    bookId: 'long_term',
    horizon: 'long_term',
    order: {
      symbol: { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'TCS' },
      side: 'SELL',
      quantity: 5,
      orderType: 'MARKET',
      product: 'DELIVERY',
      validity: 'DAY',
    },
    status: 'OPEN',
    filledQty: 0,
    avgFillPrice: null,
    rejectionReason: null,
    approvedBy: UID,
    approvedAt: '2026-01-13T04:05:00.000Z',
    submittedAt: '2026-01-13T04:05:01.000Z',
    ipUsed: '203.0.113.10',
    environment: 'dry-run',
    brokerRawAck: null,
    updatedAt: '2026-01-13T04:05:01.000Z',
    ...patch,
  };
}

export function makeAuditEvent(patch: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'a1',
    uid: UID,
    ts: '2026-01-13T04:10:00.000Z',
    actor: 'backend',
    type: 'guardrail.blocked',
    detail: {},
    ...patch,
  };
}

export function makeConfig(patch: Partial<Config> = {}): Config {
  return {
    uid: UID,
    activeBroker: 'dhan',
    environment: 'dry-run',
    killSwitch: false,
    tradingEnabled: true,
    guardrails: {
      maxOrderValueInr: 100_000,
      maxDailyNotionalInr: 500_000,
      maxOrdersPerDay: 10,
      allowedSegments: ['EQ'],
      allowedProducts: ['DELIVERY'],
      symbolAllowlist: null,
      symbolBlocklist: [],
      priceCollarPct: 2,
      proposalTtlSeconds: 900,
      requireBiometric: true,
    },
    totalManagedCapitalInr: 1_000_000,
    reservePct: 10,
    updatedAt: '2026-01-13T00:00:00.000Z',
    ...patch,
  };
}

export function makeBrokerSession(patch: Partial<BrokerSession> = {}): BrokerSession {
  return {
    broker: 'dhan',
    connected: true,
    expiresAt: '2026-01-13T18:30:00.000Z',
    staticIpOk: true,
    lastConnectedAt: '2026-01-13T00:00:00.000Z',
    ...patch,
  };
}
