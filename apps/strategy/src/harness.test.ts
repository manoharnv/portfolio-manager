import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProposalSchema, symbolKey } from '@pm/core';
import type { AuditEvent, Horizon, Proposal } from '@pm/core';
import {
  draftDedupeKey,
  proposalDedupeKey,
  riskVeto,
  runTick,
  summariseExposure,
  type TickSummary,
} from './harness.js';
import { defineStrategy, type ProposalDraft, type Strategy, type Tick } from './types.js';
import { limitOrder, makeDraft } from './strategies/util.js';
import {
  INFY,
  NOW_IST_1000,
  NOW_IST_1545,
  RELIANCE,
  TEST_UID,
  createTestHarness,
  instrumentMap,
  makeBook,
  makeDef,
  makeHolding,
  makeInstrument,
  makeLedgerEntry,
  makePosition,
  makeProposal,
  makeQuote,
  makeSwingBook,
  quoteMap,
  type TestHarnessOptions,
} from './test-utils/index.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

interface DraftOptions {
  strategyId?: string;
  bookId?: 'long_term' | 'swing' | 'day_trade';
  horizon?: Horizon;
  side?: 'BUY' | 'SELL';
  quantity?: number;
  limitPrice?: number;
  symbol?: typeof RELIANCE;
  intent?: ProposalDraft['intent'];
  summary?: string;
  ltp?: number;
}

function draft(options: DraftOptions = {}): ProposalDraft {
  const ltp = options.ltp ?? 2950;
  const price = options.limitPrice ?? ltp;
  return makeDraft({
    strategyId: options.strategyId ?? 'stub',
    bookId: options.bookId ?? 'long_term',
    horizon: options.horizon ?? 'long_term',
    intent: options.intent ?? 'entry',
    order: limitOrder({
      symbol: options.symbol ?? RELIANCE,
      side: options.side ?? 'BUY',
      quantity: options.quantity ?? 10,
      product: 'DELIVERY',
      limitPrice: price,
    }),
    rationale: { summary: options.summary ?? 'stub rationale', signals: { rule: 'stub' } },
    ltp,
    capturedAt: NOW_IST_1000,
  });
}

/** A second symbol whose quote is ₹1500 — used to fill a book with two orders. */
const infyDraft = (options: DraftOptions = {}): ProposalDraft =>
  draft({ symbol: INFY, ltp: 1500, ...options });

interface StubOptions {
  horizon?: Horizon;
  schedule?: readonly Tick[];
  drafts?: ProposalDraft[];
  fail?: string;
}

function stub(id: string, options: StubOptions = {}): Strategy {
  return defineStrategy({
    id,
    horizon: options.horizon ?? 'long_term',
    schedule: options.schedule ?? ['intraday'],
    paramsSchema: z.record(z.string(), z.unknown()),
    run: () => {
      if (options.fail !== undefined) throw new Error(options.fail);
      return Promise.resolve({ proposals: options.drafts ?? [] });
    },
  });
}

const BASE_QUOTES = quoteMap([makeQuote({ ltp: 2950 }), makeQuote({ symbol: INFY, ltp: 1500 })]);
const BASE_INSTRUMENTS = instrumentMap([
  makeInstrument(),
  makeInstrument({ canonical: INFY, brokerInstrumentId: '1594' }),
]);

function harness(
  strategies: readonly Strategy[],
  options: TestHarnessOptions = {},
): ReturnType<typeof createTestHarness> {
  return createTestHarness({
    ...options,
    registry: new Map(strategies.map((s) => [s.id, s])),
    state: {
      books: [makeBook()],
      defs: strategies.map((s) =>
        makeDef({
          id: s.id,
          horizon: s.horizon,
          bookId:
            s.horizon === 'swing' ? 'swing' : s.horizon === 'day_trade' ? 'day_trade' : 'long_term',
        }),
      ),
      quotes: BASE_QUOTES,
      instruments: BASE_INSTRUMENTS,
      ...options.state,
    },
  });
}

const tick = (deps: ReturnType<typeof createTestHarness>['deps']): Promise<TickSummary> =>
  runTick({ uid: TEST_UID, tick: 'intraday', deps });

const types = (audits: readonly AuditEvent[]): string[] => audits.map((a) => a.type);
const reasons = (audits: readonly AuditEvent[]): unknown[] => audits.map((a) => a.detail['reason']);

// ---------------------------------------------------------------------------

describe('runTick — gates (docs/05 §5.5)', () => {
  it('no-ops when the user has no config at all — fail closed', async () => {
    const h = harness([stub('a', { drafts: [draft()] })], { state: { config: undefined } });
    const summary = await tick(h.deps);
    expect(summary.skippedReason).toBe('config_missing');
    expect(h.written).toEqual([]);
    expect(types(h.audits)).toEqual(['guardrail.blocked']);
  });

  it('no-ops when tradingEnabled is false', async () => {
    const h = harness([stub('a', { drafts: [draft()] })]);
    h.state.config = { ...h.state.config!, tradingEnabled: false };
    const summary = await tick(h.deps);
    expect(summary.skippedReason).toBe('trading_disabled');
    expect(h.written).toEqual([]);
    expect(types(h.audits)).toEqual(['guardrail.blocked']);
    expect(reasons(h.audits)).toEqual(['trading_disabled']);
  });

  it('no-ops when the kill switch is on', async () => {
    const h = harness([stub('a', { drafts: [draft()] })]);
    h.state.config = { ...h.state.config!, killSwitch: true };
    const summary = await tick(h.deps);
    expect(summary.skippedReason).toBe('kill_switch');
    expect(h.written).toEqual([]);
  });

  it('no-ops when there is no broker session', async () => {
    const h = harness([stub('a', { drafts: [draft()] })], { state: { session: undefined } });
    expect((await tick(h.deps)).skippedReason).toBe('no_broker_session');
  });

  it('no-ops when the broker session is disconnected', async () => {
    const h = harness([stub('a', { drafts: [draft()] })]);
    h.state.session = { ...h.state.session!, connected: false };
    const summary = await tick(h.deps);
    expect(summary.skippedReason).toBe('no_broker_session');
    expect(h.audits[0]?.detail['broker']).toBe('dhan');
  });
});

describe('runTick — strategy selection and isolation', () => {
  it('runs only the strategies scheduled for this tick', async () => {
    const h = harness([
      stub('now', { drafts: [draft({ strategyId: 'now' })], schedule: ['intraday'] }),
      stub('later', {
        drafts: [draft({ strategyId: 'later', symbol: INFY })],
        schedule: ['eod'],
      }),
    ]);
    const summary = await tick(h.deps);
    expect(summary.written.map((p) => p.strategyId)).toEqual(['now']);
  });

  it('one strategy throwing never aborts the others', async () => {
    const h = harness([
      stub('boom', { fail: 'index out of range' }),
      stub('fine', { drafts: [draft({ strategyId: 'fine' })] }),
    ]);
    const summary = await tick(h.deps);
    expect(summary.written.map((p) => p.strategyId)).toEqual(['fine']);
    const errorAudit = h.audits.find((a) => a.detail['reason'] === 'strategy_error');
    expect(errorAudit?.detail['message']).toBe('index out of range');
    expect(errorAudit?.detail['strategyId']).toBe('boom');
  });

  it('audits a def naming a strategy this build does not have', async () => {
    const h = harness([stub('a')]);
    h.state.defs = [...h.state.defs, makeDef({ id: 'ghost' })];
    await tick(h.deps);
    expect(reasons(h.audits)).toContain('unknown_strategy');
  });

  it('audits a def pointing at a book that does not exist', async () => {
    const h = harness([stub('a', { drafts: [draft()] })], { state: { books: [] } });
    const summary = await tick(h.deps);
    expect(summary.written).toEqual([]);
    expect(reasons(h.audits)).toContain('unknown_book');
  });

  it('audits a disabled book', async () => {
    const h = harness([stub('a', { drafts: [draft()] })], {
      state: { books: [makeBook({ enabled: false })] },
    });
    await tick(h.deps);
    expect(reasons(h.audits)).toContain('book_disabled');
  });

  it('audits a def whose horizon disagrees with the implementation', async () => {
    const h = harness([stub('a', { drafts: [draft()] })]);
    h.state.defs = [makeDef({ id: 'a', horizon: 'swing', bookId: 'long_term' })];
    await tick(h.deps);
    expect(reasons(h.audits)).toContain('horizon_mismatch');
  });

  it('returns early when no strategy produced a draft', async () => {
    const h = harness([stub('a')]);
    const summary = await tick(h.deps);
    expect(summary).toEqual({ uid: TEST_UID, tick: 'intraday', written: [], dropped: [] });
    expect(h.audits).toEqual([]);
  });
});

describe('runTick — the written proposal', () => {
  it('is a schema-valid pending proposal with every attribution field', async () => {
    const h = harness([stub('alpha', { drafts: [draft({ strategyId: 'alpha' })] })]);
    const summary = await tick(h.deps);

    expect(summary.written).toHaveLength(1);
    const proposal = summary.written[0] as Proposal;
    expect(ProposalSchema.safeParse(proposal).success).toBe(true);
    expect(proposal).toMatchObject({
      uid: TEST_UID,
      createdAt: NOW_IST_1000,
      createdBy: 'strategy-engine',
      strategyId: 'alpha',
      targetBroker: 'dhan',
      bookId: 'long_term',
      horizon: 'long_term',
      status: 'pending',
    });
    // ttl = now + config.guardrails.proposalTtlSeconds (900 s)
    expect(proposal.ttlExpiresAt).toBe('2026-01-13T04:45:00.000Z');
    expect(proposal.guardrailPrecheck.passed).toBe(true);
    expect(proposal.guardrailPrecheck.checks.every((c) => c.ok)).toBe(true);
    expect(proposal.marketContext).toEqual({
      ltpAtProposal: 2950,
      estimatedValueInr: 29_500,
      capturedAt: NOW_IST_1000,
    });
    expect(proposal.rationale.signals['intent']).toBe('entry');
    expect(proposal.coordinator?.decision).toBe('accepted');
    expect(h.written).toEqual(summary.written);
  });

  it('audits proposal.created once per write, with the proposal id as refId', async () => {
    const h = harness([
      stub('alpha', {
        drafts: [draft({ strategyId: 'alpha' }), infyDraft({ strategyId: 'alpha' })],
      }),
    ]);
    const summary = await tick(h.deps);
    const created = h.audits.filter((a) => a.type === 'proposal.created');
    expect(created).toHaveLength(2);
    expect(created.map((a) => a.refId).sort()).toEqual(summary.written.map((p) => p.id).sort());
    expect(created[0]?.actor).toBe('strategy-engine');
    expect(created[0]?.detail['estimatedValueInr']).toBe(29_500);
  });
});

describe('runTick — coordinator (docs/10 §10.5)', () => {
  it('blocks a wash trade across two books and audits coordinator.blocked', async () => {
    const h = harness(
      [
        stub('longer', { drafts: [draft({ strategyId: 'longer', bookId: 'long_term' })] }),
        stub('shorter', {
          horizon: 'swing',
          drafts: [
            draft({
              strategyId: 'shorter',
              bookId: 'swing',
              horizon: 'swing',
              side: 'SELL',
              intent: 'exit',
            }),
          ],
        }),
      ],
      {
        state: {
          books: [makeBook(), makeSwingBook()],
          ledger: [makeLedgerEntry({ bookId: 'swing', qty: 10, symbolKey: symbolKey(RELIANCE) })],
        },
      },
    );

    const summary = await tick(h.deps);
    expect(summary.written).toEqual([]);
    expect(summary.dropped).toHaveLength(2);
    expect(summary.dropped.every((d) => d.reason.startsWith('wash_trade'))).toBe(true);
    expect(types(h.audits)).toEqual(['coordinator.blocked', 'coordinator.blocked']);
  });

  it('blocks a duplicate of an already-open proposal at the coordinator', async () => {
    const open = makeProposal({ strategyId: 'alpha', id: 'open-1' });
    const h = harness([stub('alpha', { drafts: [draft({ strategyId: 'alpha' })] })], {
      state: { openProposals: [open] },
    });
    const summary = await tick(h.deps);
    expect(summary.written).toEqual([]);
    expect(summary.dropped[0]?.reason).toContain('duplicate_intent');
    expect(types(h.audits)).toEqual(['coordinator.blocked']);
  });

  it('defers a draft the account has no margin for', async () => {
    const h = harness([stub('alpha', { drafts: [draft({ strategyId: 'alpha' })] })], {
      state: {
        portfolio: {
          holdings: [],
          positions: [],
          funds: { availableCash: 0, usedMargin: 0, availableMargin: 100, raw: null },
        },
      },
    });
    const summary = await tick(h.deps);
    expect(summary.dropped[0]?.reason).toContain('capital_arbitration');
    expect(types(h.audits)).toEqual(['coordinator.deferred']);
  });

  it('blocks a SELL of quantity the book does not own', async () => {
    const h = harness([
      stub('alpha', { drafts: [draft({ strategyId: 'alpha', side: 'SELL', intent: 'exit' })] }),
    ]);
    const summary = await tick(h.deps);
    expect(summary.dropped[0]?.reason).toContain('ownership');
    expect(types(h.audits)).toEqual(['coordinator.blocked']);
  });
});

describe('runTick — portfolio risk manager (docs/10 §10.6)', () => {
  it('drops everything when the portfolio daily-loss stop is breached', async () => {
    const h = harness([stub('alpha', { drafts: [draft({ strategyId: 'alpha' })] })], {
      state: { books: [makeBook({ realizedPnlInr: -20_000 })] },
    });
    const summary = await tick(h.deps);
    expect(summary.written).toEqual([]);
    expect(summary.dropped[0]?.reason).toContain('portfolio daily-loss stop');
    expect(types(h.audits)).toEqual(['guardrail.blocked']);
  });

  it('honours an explicit risk-limit override', async () => {
    const h = harness([stub('alpha', { drafts: [draft({ strategyId: 'alpha' })] })], {
      riskLimits: { maxGrossExposureInr: 0 },
    });
    const summary = await tick(h.deps);
    expect(summary.dropped[0]?.reason).toContain('gross exposure cap');
  });
});

describe('runTick — guardrail pre-filter (docs/04 §4.5)', () => {
  it('drops an order above maxOrderValueInr', async () => {
    const h = harness([stub('alpha', { drafts: [draft({ strategyId: 'alpha', quantity: 100 })] })]);
    const summary = await tick(h.deps);
    expect(summary.written).toEqual([]);
    expect(summary.dropped[0]?.reason).toContain('maxOrderValue');
    expect(types(h.audits)).toEqual(['guardrail.blocked']);
  });

  it('drops a limit price outside the collar', async () => {
    const h = harness([
      stub('alpha', { drafts: [draft({ strategyId: 'alpha', limitPrice: 3200 })] }),
    ]);
    expect((await tick(h.deps)).dropped[0]?.reason).toContain('priceCollar');
  });

  it('drops everything when the market is closed', async () => {
    const h = harness([stub('alpha', { drafts: [draft({ strategyId: 'alpha' })] })], {
      now: NOW_IST_1545,
    });
    expect((await tick(h.deps)).dropped[0]?.reason).toContain('marketHours');
  });

  it('drops everything on an injected exchange holiday', async () => {
    const h = harness([stub('alpha', { drafts: [draft({ strategyId: 'alpha' })] })], {
      holidays: ['2026-01-13'],
    });
    expect((await tick(h.deps)).dropped[0]?.reason).toContain('exchange holiday');
  });

  it('drops when the instrument cannot be resolved — fail closed', async () => {
    const h = harness([stub('alpha', { drafts: [draft({ strategyId: 'alpha' })] })], {
      state: { unresolvableInstruments: new Set([symbolKey(RELIANCE)]) },
    });
    expect((await tick(h.deps)).dropped[0]?.reason).toContain('tickLotValidity');
  });

  it('drops when there is no live quote — fail closed', async () => {
    const h = harness([stub('alpha', { drafts: [draft({ strategyId: 'alpha' })] })], {
      state: { quotes: new Map() },
    });
    expect((await tick(h.deps)).dropped[0]?.reason).toContain('priceCollar');
  });

  it('drops a duplicate of an open proposal via the idempotency key', async () => {
    // Same strategy/symbol/side/intent but a different book, so the coordinator's
    // own intent key does not match — the dedupe key still does.
    const open = makeProposal({
      id: 'open-1',
      strategyId: 'alpha',
      bookId: 'swing',
      horizon: 'swing',
      rationale: { summary: 'open', signals: { intent: 'entry' } },
    });
    const h = harness([stub('alpha', { drafts: [draft({ strategyId: 'alpha' })] })], {
      state: { openProposals: [open] },
    });
    const summary = await tick(h.deps);
    expect(summary.written).toEqual([]);
    expect(summary.dropped[0]?.reason).toContain('idempotencyUnused');
    expect(summary.dropped[0]?.reason).toContain('already used');
  });
});

describe('runTick — book budget and dedupe', () => {
  it('drops a draft that would exceed the book budget', async () => {
    const h = harness([stub('alpha', { drafts: [draft({ strategyId: 'alpha' })] })], {
      state: { books: [makeBook({ allocatedCapitalInr: 20_000 })] },
    });
    const summary = await tick(h.deps);
    expect(summary.written).toEqual([]);
    expect(summary.dropped[0]?.reason).toContain('book_budget');
  });

  it('drops a draft above the book per-position cap', async () => {
    const h = harness([stub('alpha', { drafts: [draft({ strategyId: 'alpha' })] })], {
      state: {
        books: [
          makeBook({
            risk: {
              maxPositions: 5,
              maxPositionValueInr: 10_000,
              dailyLossStopInr: 100_000,
              perTradeRiskPct: 2,
            },
          }),
        ],
      },
    });
    expect((await tick(h.deps)).dropped[0]?.reason).toContain('book_position_cap');
  });

  it('spends the budget across drafts within one tick', async () => {
    const h = harness(
      [
        stub('alpha', {
          drafts: [
            draft({ strategyId: 'alpha' }),
            infyDraft({ strategyId: 'alpha', intent: 'rebalance' }),
          ],
        }),
      ],
      { state: { books: [makeBook({ allocatedCapitalInr: 35_000 })] } },
    );
    const summary = await tick(h.deps);
    expect(summary.written).toHaveLength(1);
    expect(summary.dropped[0]?.reason).toContain('book_budget');
  });

  it('dedupes two drafts with the same intent inside one tick', async () => {
    const h = harness(
      [
        stub('alpha', {
          drafts: [
            draft({ strategyId: 'alpha', bookId: 'long_term' }),
            draft({ strategyId: 'alpha', bookId: 'swing', horizon: 'swing' }),
          ],
        }),
      ],
      { state: { books: [makeBook(), makeSwingBook()] } },
    );
    const summary = await tick(h.deps);
    expect(summary.written).toHaveLength(1);
    expect(summary.dropped[0]?.reason).toContain('dedupe');
    expect(types(h.audits).filter((t) => t === 'guardrail.blocked')).toHaveLength(1);
  });

  it('drops a draft that fails the proposal schema on the way out', async () => {
    const h = harness([stub('alpha', { drafts: [draft({ strategyId: 'alpha', summary: '' })] })]);
    const summary = await tick(h.deps);
    expect(summary.written).toEqual([]);
    expect(summary.dropped[0]?.reason).toContain('schema:');
  });

  it('propagates a Firestore write failure rather than pretending it wrote', async () => {
    const h = harness([stub('alpha', { drafts: [draft({ strategyId: 'alpha' })] })], {
      createError: 'permission denied',
    });
    await expect(tick(h.deps)).rejects.toThrowError('permission denied');
  });
});

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

describe('dedupe keys', () => {
  it('round-trips a draft through a written proposal', () => {
    const d = draft({ strategyId: 'alpha', intent: 'stop' });
    const proposal = makeProposal({
      strategyId: 'alpha',
      order: d.order,
      rationale: d.rationale,
    });
    expect(proposalDedupeKey(proposal)).toBe(draftDedupeKey(d));
  });

  it('falls back to the product when a proposal carries no intent signal', () => {
    const proposal: Proposal = { ...makeProposal(), rationale: { summary: 'x', signals: {} } };
    expect(proposalDedupeKey(proposal)).toContain('DELIVERY');
  });

  it('separates a stop from a target on the same holding', () => {
    expect(draftDedupeKey(draft({ intent: 'stop', side: 'SELL' }))).not.toBe(
      draftDedupeKey(draft({ intent: 'target', side: 'SELL' })),
    );
  });
});

describe('summariseExposure', () => {
  it('sums holdings and positions and isolates the intraday requirement', () => {
    const exposure = summariseExposure({
      holdings: [makeHolding({ quantity: 10, lastPrice: 100 })],
      positions: [
        makePosition({ netQty: -5, lastPrice: 200, product: 'INTRADAY' }),
        makePosition({ symbol: INFY, netQty: 2, lastPrice: 1500, product: 'DELIVERY' }),
      ],
      funds: { availableCash: 0, usedMargin: 0, availableMargin: 0, raw: null },
    });
    expect(exposure.grossInr).toBe(1000 + 1000 + 3000);
    expect(exposure.intradayRequiredInr).toBe(1000);
    expect(exposure.bySymbolInr[symbolKey(RELIANCE)]).toBe(2000);
    expect(exposure.bySymbolInr[symbolKey(INFY)]).toBe(3000);
  });

  it('ignores zero-value rows', () => {
    const exposure = summariseExposure({
      holdings: [makeHolding({ quantity: 0 })],
      positions: [],
      funds: { availableCash: 0, usedMargin: 0, availableMargin: 0, raw: null },
    });
    expect(exposure.grossInr).toBe(0);
    expect(exposure.bySymbolInr).toEqual({});
  });
});

describe('riskVeto', () => {
  const proposal = makeProposal({ bookId: 'day_trade', horizon: 'day_trade' });
  const base = {
    ok: true,
    tripKillSwitch: false,
    pauseBooks: [] as string[],
    blockNewExposure: false,
    blockedSymbols: [] as string[],
    throttleBooks: [] as string[],
    squareOffDue: [],
    checks: [],
  };

  it('lets a clean proposal through', () => {
    expect(riskVeto(base, proposal, false)).toBeUndefined();
  });

  it('vetoes on the kill switch, a paused book, exposure, concentration and throttle', () => {
    expect(riskVeto({ ...base, tripKillSwitch: true }, proposal, true)).toContain('kill switch');
    expect(riskVeto({ ...base, pauseBooks: ['day_trade'] }, proposal, true)).toContain('paused');
    expect(riskVeto({ ...base, blockNewExposure: true }, proposal, false)).toContain(
      'gross exposure',
    );
    expect(riskVeto({ ...base, blockedSymbols: [symbolKey(RELIANCE)] }, proposal, false)).toContain(
      'concentration cap',
    );
    expect(riskVeto({ ...base, throttleBooks: ['day_trade'] }, proposal, false)).toContain(
      'throttled',
    );
  });

  it('lets an exit through every control that only blocks new exposure', () => {
    expect(riskVeto({ ...base, blockNewExposure: true }, proposal, true)).toBeUndefined();
    expect(
      riskVeto({ ...base, blockedSymbols: [symbolKey(RELIANCE)] }, proposal, true),
    ).toBeUndefined();
    expect(riskVeto({ ...base, throttleBooks: ['day_trade'] }, proposal, true)).toBeUndefined();
  });
});
