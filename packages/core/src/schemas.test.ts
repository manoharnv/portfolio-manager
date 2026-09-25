import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { Broker, NormalizedOrder } from './domain.js';
import {
  AuditEventSchema,
  BookSchema,
  BrokerSchema,
  BrokerSessionSchema,
  CanonicalSymbolSchema,
  ConfigSchema,
  CoordinatorConfigSchema,
  FundsDocSchema,
  GuardrailConfigSchema,
  GuardrailResultSchema,
  HORIZONS,
  HoldingDocSchema,
  IdempotencyRecordSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  LedgerEntrySchema,
  MandateSchema,
  NormalizedOrderSchema,
  OrderRecordSchema,
  PROPOSAL_STATUSES,
  PositionDocSchema,
  ProposalSchema,
  ProposalStatusSchema,
} from './schemas.js';
import {
  MARKET_OPEN_NOW,
  RELIANCE,
  makeBook,
  makeConfig,
  makeLedgerEntry,
  makeOrder,
  makeProposal,
} from './test-utils.js';

describe('IsoDateTimeSchema', () => {
  it.each([
    '2026-01-13T04:30:00Z',
    '2026-01-13T04:30:00.000Z',
    '2026-01-13T10:00:00+05:30',
    '2026-01-13T04:30:00.123456Z',
  ])('accepts %s', (value) => {
    expect(IsoDateTimeSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    '2026-01-13', // no time
    '2026-01-13T04:30:00', // no timezone
    '2026-01-13 04:30:00Z', // space separator
    '13/01/2026', // not ISO
    '2026-02-30T04:30:00Z', // not a real calendar date
    '2026-13-01T04:30:00Z', // month out of range
    '',
  ])('rejects %j', (value) => {
    expect(IsoDateTimeSchema.safeParse(value).success).toBe(false);
  });
});

describe('IsoDateSchema', () => {
  it('accepts YYYY-MM-DD and rejects anything else', () => {
    expect(IsoDateSchema.safeParse('2026-01-13').success).toBe(true);
    expect(IsoDateSchema.safeParse('2026-1-13').success).toBe(false);
    expect(IsoDateSchema.safeParse('2026-01-13T00:00:00Z').success).toBe(false);
  });
});

describe('CanonicalSymbolSchema', () => {
  it('accepts a valid symbol', () => {
    expect(CanonicalSymbolSchema.safeParse(RELIANCE).success).toBe(true);
  });

  it.each([
    { exchange: 'NASDAQ', segment: 'EQ', tradingSymbol: 'AAPL' },
    { exchange: 'NSE', segment: 'CRYPTO', tradingSymbol: 'BTC' },
    { exchange: 'NSE', segment: 'EQ', tradingSymbol: '' },
    { exchange: 'NSE', segment: 'EQ' },
  ])('rejects %j', (value) => {
    expect(CanonicalSymbolSchema.safeParse(value).success).toBe(false);
  });
});

describe('NormalizedOrderSchema', () => {
  it('accepts each order type with its required prices', () => {
    expect(NormalizedOrderSchema.safeParse(makeOrder()).success).toBe(true);
    expect(
      NormalizedOrderSchema.safeParse(makeOrder({ orderType: 'MARKET', limitPrice: undefined }))
        .success,
    ).toBe(true);
    expect(
      NormalizedOrderSchema.safeParse(makeOrder({ orderType: 'SL', triggerPrice: 2900 })).success,
    ).toBe(true);
    expect(
      NormalizedOrderSchema.safeParse(
        makeOrder({ orderType: 'SL-M', limitPrice: undefined, triggerPrice: 2900 }),
      ).success,
    ).toBe(true);
  });

  it('requires limitPrice for LIMIT and SL', () => {
    for (const orderType of ['LIMIT', 'SL'] as const) {
      const result = NormalizedOrderSchema.safeParse(
        makeOrder({ orderType, limitPrice: undefined, triggerPrice: 2900 }),
      );
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('limitPrice is required');
    }
  });

  it('forbids limitPrice on MARKET and SL-M', () => {
    const result = NormalizedOrderSchema.safeParse(makeOrder({ orderType: 'MARKET' }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('limitPrice must not be set');
  });

  it('requires triggerPrice for SL and SL-M', () => {
    const result = NormalizedOrderSchema.safeParse(makeOrder({ orderType: 'SL' }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('triggerPrice is required');
  });

  it('forbids triggerPrice on MARKET and LIMIT', () => {
    const result = NormalizedOrderSchema.safeParse(makeOrder({ triggerPrice: 2900 }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('triggerPrice must not be set');
  });

  it.each([
    ['zero quantity', makeOrder({ quantity: 0 })],
    ['negative quantity', makeOrder({ quantity: -5 })],
    ['fractional quantity', makeOrder({ quantity: 1.5 })],
    ['negative limit price', makeOrder({ limitPrice: -1 })],
    ['non-finite limit price', makeOrder({ limitPrice: Number.POSITIVE_INFINITY })],
  ])('rejects %s', (_label, order) => {
    expect(NormalizedOrderSchema.safeParse(order).success).toBe(false);
  });

  it('rejects a disclosed quantity larger than the order quantity', () => {
    const result = NormalizedOrderSchema.safeParse(
      makeOrder({ quantity: 10, disclosedQuantity: 11 }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('disclosedQuantity cannot exceed');
  });

  it('accepts a disclosed quantity within the order quantity', () => {
    expect(
      NormalizedOrderSchema.safeParse(makeOrder({ quantity: 10, disclosedQuantity: 5 })).success,
    ).toBe(true);
  });

  it('infers a type interchangeable with the domain NormalizedOrder', () => {
    const fromSchema: z.infer<typeof NormalizedOrderSchema> = makeOrder();
    const asDomain: NormalizedOrder = fromSchema;
    const backAgain: z.infer<typeof NormalizedOrderSchema> = asDomain;
    expect(backAgain).toEqual(fromSchema);

    const broker: Broker = BrokerSchema.parse('dhan');
    expect(broker).toBe('dhan');
  });
});

describe('ConfigSchema', () => {
  it('accepts a full config', () => {
    expect(ConfigSchema.safeParse(makeConfig()).success).toBe(true);
  });

  it('accepts a config with the optional coordinator block', () => {
    expect(
      ConfigSchema.safeParse(
        makeConfig({
          coordinator: { nettingEnabled: true, washWindowSeconds: 30, precedence: [...HORIZONS] },
        }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ['unknown broker', { activeBroker: 'upstox' }],
    ['unknown environment', { environment: 'staging' }],
    ['negative capital', { totalManagedCapitalInr: -1 }],
    ['reserve over 100', { reservePct: 101 }],
    ['non-ISO updatedAt', { updatedAt: 'yesterday' }],
    ['empty uid', { uid: '' }],
  ])('rejects %s', (_label, patch) => {
    expect(ConfigSchema.safeParse({ ...makeConfig(), ...patch }).success).toBe(false);
  });

  it('rejects invalid guardrail values', () => {
    const g = makeConfig().guardrails;
    expect(GuardrailConfigSchema.safeParse(g).success).toBe(true);
    expect(GuardrailConfigSchema.safeParse({ ...g, maxOrderValueInr: -1 }).success).toBe(false);
    expect(GuardrailConfigSchema.safeParse({ ...g, maxOrdersPerDay: 2.5 }).success).toBe(false);
    expect(GuardrailConfigSchema.safeParse({ ...g, priceCollarPct: -0.1 }).success).toBe(false);
    expect(GuardrailConfigSchema.safeParse({ ...g, proposalTtlSeconds: 0 }).success).toBe(false);
    expect(GuardrailConfigSchema.safeParse({ ...g, allowedSegments: ['CRYPTO'] }).success).toBe(
      false,
    );
    expect(GuardrailConfigSchema.safeParse({ ...g, symbolBlocklist: null }).success).toBe(false);
  });

  it('allows a null symbol allowlist (no allowlist filter)', () => {
    const g = makeConfig().guardrails;
    expect(GuardrailConfigSchema.safeParse({ ...g, symbolAllowlist: null }).success).toBe(true);
    expect(GuardrailConfigSchema.safeParse({ ...g, symbolAllowlist: ['RELIANCE'] }).success).toBe(
      true,
    );
  });

  it('validates the coordinator block', () => {
    expect(
      CoordinatorConfigSchema.safeParse({
        nettingEnabled: false,
        washWindowSeconds: 60,
        precedence: [...HORIZONS],
      }).success,
    ).toBe(true);
    expect(
      CoordinatorConfigSchema.safeParse({
        nettingEnabled: false,
        washWindowSeconds: -1,
        precedence: [...HORIZONS],
      }).success,
    ).toBe(false);
    expect(
      CoordinatorConfigSchema.safeParse({
        nettingEnabled: false,
        washWindowSeconds: 60,
        precedence: ['scalping'],
      }).success,
    ).toBe(false);
  });
});

describe('ProposalStatusSchema', () => {
  it('has exactly the nine documented statuses', () => {
    expect([...PROPOSAL_STATUSES]).toEqual([
      'pending',
      'approved',
      'placing',
      'placed',
      'filled',
      'rejected',
      'expired',
      'failed',
      'blocked',
    ]);
  });

  it.each(PROPOSAL_STATUSES)('accepts %s', (status) => {
    expect(ProposalStatusSchema.safeParse(status).success).toBe(true);
  });

  it('rejects anything else', () => {
    expect(ProposalStatusSchema.safeParse('cancelled').success).toBe(false);
    expect(ProposalStatusSchema.safeParse('PENDING').success).toBe(false);
  });
});

describe('ProposalSchema', () => {
  it('accepts a complete proposal', () => {
    expect(ProposalSchema.safeParse(makeProposal()).success).toBe(true);
  });

  it('accepts the optional decision/execution trail', () => {
    expect(
      ProposalSchema.safeParse(
        makeProposal({
          status: 'placed',
          decidedBy: 'u1',
          decidedAt: MARKET_OPEN_NOW,
          orderId: 'o1',
          coordinator: { decision: 'accepted', reason: 'ok', evaluatedAt: MARKET_OPEN_NOW },
        }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ['a missing bookId', { bookId: undefined }],
    ['a missing horizon', { horizon: undefined }],
    ['an unknown horizon', { horizon: 'intraday' }],
    ['createdBy other than strategy-engine', { createdBy: 'app-user' }],
    ['a non-ISO ttl', { ttlExpiresAt: 'soon' }],
    ['an unknown status', { status: 'queued' }],
    ['an empty rationale summary', { rationale: { summary: '', signals: {} } }],
    ['a zero ltpAtProposal', { marketContext: { ltpAtProposal: 0 } }],
  ])('rejects %s', (_label, patch) => {
    const proposal: Record<string, unknown> = { ...makeProposal() };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete proposal[k];
      else if (typeof v === 'object' && v !== null)
        proposal[k] = { ...(proposal[k] as object), ...v };
      else proposal[k] = v;
    }
    expect(ProposalSchema.safeParse(proposal).success).toBe(false);
  });

  it('rejects an invalid embedded order', () => {
    expect(ProposalSchema.safeParse(makeProposal({ order: { quantity: 0 } })).success).toBe(false);
  });

  it('validates the guardrail precheck block', () => {
    expect(
      GuardrailResultSchema.safeParse({
        passed: false,
        checks: [{ name: 'maxOrderValue', ok: false, detail: 'too big' }],
      }).success,
    ).toBe(true);
    expect(GuardrailResultSchema.safeParse({ passed: false }).success).toBe(false);
    expect(
      GuardrailResultSchema.safeParse({
        passed: true,
        checks: [{ name: '', ok: true, detail: '' }],
      }).success,
    ).toBe(false);
  });
});

describe('OrderRecordSchema', () => {
  const base = {
    id: 'o1',
    uid: 'u1',
    proposalId: 'p1',
    broker: 'dhan',
    brokerOrderId: '112111182198',
    idempotencyKey: 'idem-1',
    bookId: 'long_term',
    horizon: 'long_term',
    order: makeOrder(),
    status: 'SUBMITTED',
    filledQty: 0,
    avgFillPrice: null,
    rejectionReason: null,
    approvedBy: 'u1',
    approvedAt: MARKET_OPEN_NOW,
    submittedAt: MARKET_OPEN_NOW,
    ipUsed: '34.100.1.1',
    environment: 'prod',
    brokerRawAck: { orderId: '112111182198' },
    updatedAt: MARKET_OPEN_NOW,
  };

  it('accepts a valid order record', () => {
    expect(OrderRecordSchema.safeParse(base).success).toBe(true);
  });

  it('accepts null brokerOrderId and submittedAt before submission', () => {
    expect(
      OrderRecordSchema.safeParse({ ...base, brokerOrderId: null, submittedAt: null }).success,
    ).toBe(true);
  });

  it.each([
    ['an unknown status', { status: 'SENT' }],
    ['a fractional filledQty', { filledQty: 1.5 }],
    ['a missing bookId', { bookId: undefined }],
    ['a missing horizon', { horizon: undefined }],
    ['a missing idempotencyKey', { idempotencyKey: '' }],
    ['an unknown environment', { environment: 'live' }],
  ])('rejects %s', (_label, patch) => {
    const record: Record<string, unknown> = { ...base, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete record[k];
    expect(OrderRecordSchema.safeParse(record).success).toBe(false);
  });
});

describe('BrokerSessionSchema', () => {
  it('accepts non-secret session metadata', () => {
    expect(
      BrokerSessionSchema.safeParse({
        broker: 'dhan',
        connected: true,
        expiresAt: MARKET_OPEN_NOW,
        staticIpOk: true,
        lastConnectedAt: MARKET_OPEN_NOW,
      }).success,
    ).toBe(true);
  });

  it('accepts a disconnected session with null timestamps', () => {
    expect(
      BrokerSessionSchema.safeParse({
        broker: 'kite',
        connected: false,
        expiresAt: null,
        staticIpOk: false,
        lastConnectedAt: null,
      }).success,
    ).toBe(true);
  });

  it('rejects a missing staticIpOk', () => {
    expect(
      BrokerSessionSchema.safeParse({
        broker: 'dhan',
        connected: true,
        expiresAt: null,
        lastConnectedAt: null,
      }).success,
    ).toBe(false);
  });
});

describe('portfolio read-model docs', () => {
  it('accepts holding, position and funds docs', () => {
    expect(
      HoldingDocSchema.safeParse({
        symbol: RELIANCE,
        quantity: 10,
        avgCostPrice: 2900,
        lastPrice: 2950,
        pnl: 500,
        raw: null,
        symbolKey: 'NSE:EQ:RELIANCE',
        updatedAt: MARKET_OPEN_NOW,
      }).success,
    ).toBe(true);

    expect(
      PositionDocSchema.safeParse({
        symbol: RELIANCE,
        netQty: -5,
        product: 'INTRADAY',
        avgPrice: 2950,
        lastPrice: 2940,
        realizedPnl: 0,
        unrealizedPnl: 50,
        raw: null,
        symbolKey: 'NSE:EQ:RELIANCE',
        updatedAt: MARKET_OPEN_NOW,
      }).success,
    ).toBe(true);

    expect(
      FundsDocSchema.safeParse({
        availableCash: 100,
        usedMargin: 0,
        availableMargin: 100,
        raw: null,
        updatedAt: MARKET_OPEN_NOW,
      }).success,
    ).toBe(true);
  });

  it('rejects a doc without its symbolKey or updatedAt', () => {
    expect(
      HoldingDocSchema.safeParse({
        symbol: RELIANCE,
        quantity: 10,
        avgCostPrice: 2900,
        lastPrice: 2950,
        pnl: 500,
        raw: null,
      }).success,
    ).toBe(false);
    expect(
      FundsDocSchema.safeParse({ availableCash: 1, usedMargin: 0, availableMargin: 1, raw: null })
        .success,
    ).toBe(false);
  });
});

describe('AuditEventSchema', () => {
  const base = {
    id: 'e1',
    uid: 'u1',
    ts: MARKET_OPEN_NOW,
    actor: 'backend',
    type: 'order.submitted',
    refId: 'o1',
    detail: { brokerOrderId: '1121' },
    ip: '34.100.1.1',
  };

  it('accepts a valid event, and one without the optional fields', () => {
    expect(AuditEventSchema.safeParse(base).success).toBe(true);
    const { refId: _refId, ip: _ip, ...minimal } = base;
    expect(AuditEventSchema.safeParse(minimal).success).toBe(true);
  });

  it.each(['guardrail.blocked', 'killswitch.toggled', 'coordinator.blocked'])(
    'accepts the %s type',
    (type) => {
      expect(AuditEventSchema.safeParse({ ...base, type }).success).toBe(true);
    },
  );

  it.each([
    ['an unknown actor', { actor: 'claude' }],
    ['an unknown type', { type: 'order.cancelled' }],
    ['a non-object detail', { detail: 'stuff' }],
    ['a non-ISO ts', { ts: 'now' }],
  ])('rejects %s', (_label, patch) => {
    expect(AuditEventSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });
});

describe('IdempotencyRecordSchema', () => {
  const base = {
    key: 'idem-1',
    proposalId: 'p1',
    orderId: null,
    status: 'in-progress',
    createdAt: MARKET_OPEN_NOW,
    result: null,
  };

  it('accepts each lifecycle state', () => {
    for (const status of ['in-progress', 'done', 'failed']) {
      expect(IdempotencyRecordSchema.safeParse({ ...base, status }).success).toBe(true);
    }
    expect(
      IdempotencyRecordSchema.safeParse({
        ...base,
        status: 'done',
        orderId: 'o1',
        result: { ok: true },
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown status or an empty key', () => {
    expect(IdempotencyRecordSchema.safeParse({ ...base, status: 'pending' }).success).toBe(false);
    expect(IdempotencyRecordSchema.safeParse({ ...base, key: '' }).success).toBe(false);
  });
});

describe('BookSchema', () => {
  it('accepts a valid book', () => {
    expect(BookSchema.safeParse(makeBook()).success).toBe(true);
  });

  it.each([
    ['an unknown book id', { id: 'options' }],
    ['an allocation over 100', { allocationPct: 101 }],
    ['a negative allocation', { allocationPct: -1 }],
    ['a negative deployed amount', { deployedInr: -1 }],
    ['an unknown product', { product: 'FUTURES' }],
  ])('rejects %s', (_label, patch) => {
    expect(BookSchema.safeParse({ ...makeBook(), ...patch }).success).toBe(false);
  });

  it('rejects invalid per-book risk settings', () => {
    expect(BookSchema.safeParse(makeBook({ risk: { maxPositions: -1 } })).success).toBe(false);
    expect(BookSchema.safeParse(makeBook({ risk: { dailyLossStopInr: -1 } })).success).toBe(false);
    expect(BookSchema.safeParse(makeBook({ risk: { perTradeRiskPct: 101 } })).success).toBe(false);
  });
});

describe('LedgerEntrySchema', () => {
  it('accepts a valid entry', () => {
    expect(LedgerEntrySchema.safeParse(makeLedgerEntry()).success).toBe(true);
  });

  it('accepts the unmanaged pseudo-book for manual trades', () => {
    expect(LedgerEntrySchema.safeParse(makeLedgerEntry({ bookId: 'unmanaged' })).success).toBe(
      true,
    );
  });

  it.each([
    ['a zero quantity', { qty: 0 }],
    ['a fractional quantity', { qty: 1.5 }],
    ['a negative price', { price: -1 }],
    ['an unknown side', { side: 'SHORT' }],
    ['an empty symbolKey', { symbolKey: '' }],
    ['a non-ISO ts', { ts: '2026-01-13' }],
  ])('rejects %s', (_label, patch) => {
    expect(LedgerEntrySchema.safeParse({ ...makeLedgerEntry(), ...patch }).success).toBe(false);
  });
});

describe('MandateSchema', () => {
  const base = {
    id: 'm1',
    uid: 'u1',
    bookId: 'scalp',
    instruments: ['NSE:FNO:NIFTYFUT'],
    activatedAt: MARKET_OPEN_NOW,
    expiresAt: '2026-01-13T05:30:00.000Z',
    maxCapitalInr: 50_000,
    maxTrades: 20,
    perTradeSizeInr: 5_000,
    dailyLossStopInr: 5_000,
    ruleSetId: 'orb-v1',
    status: 'active',
    tradesPlaced: 0,
    realizedPnlInr: 0,
    activatedBy: 'u1',
  };

  it('accepts a valid mandate', () => {
    expect(MandateSchema.safeParse(base).success).toBe(true);
  });

  it('is restricted to the scalp book', () => {
    expect(MandateSchema.safeParse({ ...base, bookId: 'day_trade' }).success).toBe(false);
  });

  it.each([
    ['no instruments', { instruments: [] }],
    ['a zero capital cap', { maxCapitalInr: 0 }],
    ['a zero trade cap', { maxTrades: 0 }],
    ['an unknown status', { status: 'paused' }],
    ['a missing ruleSetId', { ruleSetId: '' }],
  ])('rejects %s', (_label, patch) => {
    expect(MandateSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  it.each(['active', 'expired', 'stopped', 'exhausted'])('accepts status %s', (status) => {
    expect(MandateSchema.safeParse({ ...base, status }).success).toBe(true);
  });
});
