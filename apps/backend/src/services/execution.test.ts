/**
 * One test per branch of the docs/04 §4.4 flowchart. This is the file that
 * guards real money: nearly every case asserts on what did **not** happen —
 * `placeOrderCalls` staying empty is the assertion that matters.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { BrokerError } from '@pm/core';
import type { Config, Proposal } from '@pm/core';
import { silentLogger } from '../logger.js';
import { SessionUnavailableError } from '../ports/index.js';
import { createAuditWriter } from './audit.js';
import { createExecutionService, stalenessRefusal } from './execution.js';
import type { ExecuteProposalInput, ExecutionService } from './execution.js';
import {
  FakeAuditLog,
  FakeBookRepo,
  FakeBrokerAdapter,
  FakeBrokerGateway,
  FakeConfigRepo,
  FakeDailyAggregates,
  FakeIdempotencyStore,
  FakeLedgerRepo,
  FakeOrderRepo,
  FakeProposalRepo,
  FakeSessionStore,
  FixedClock,
  SeqIdGenerator,
} from '../test-utils/fakes.js';
import {
  MARKET_CLOSED_NOW,
  MARKET_OPEN_NOW,
  makeBook,
  makeBrokerSession,
  makeConfig,
  makeLedgerEntry,
  makeOrder,
  makeProposal,
  makeQuote,
  makeSessionStatus,
} from '../test-utils/fixtures.js';

const STATIC_IP = '203.0.113.7';

interface Harness {
  service: ExecutionService;
  clock: FixedClock;
  proposals: FakeProposalRepo;
  orders: FakeOrderRepo;
  idempotency: FakeIdempotencyStore;
  configs: FakeConfigRepo;
  auditLog: FakeAuditLog;
  books: FakeBookRepo;
  ledger: FakeLedgerRepo;
  daily: FakeDailyAggregates;
  adapter: FakeBrokerAdapter;
  broker: FakeBrokerGateway;
  sessions: FakeSessionStore;
  run(patch?: Partial<ExecuteProposalInput>): ReturnType<ExecutionService['executeProposal']>;
}

function harness(opts?: { proposal?: Proposal; config?: Config; now?: string }): Harness {
  const clock = new FixedClock(opts?.now ?? MARKET_OPEN_NOW);
  const ids = new SeqIdGenerator();
  const proposals = new FakeProposalRepo([opts?.proposal ?? makeProposal()]);
  const orders = new FakeOrderRepo();
  const idempotency = new FakeIdempotencyStore();
  const configs = new FakeConfigRepo([opts?.config ?? makeConfig()]);
  const auditLog = new FakeAuditLog();
  const books = new FakeBookRepo([{ uid: 'u1', book: makeBook() }]);
  const ledger = new FakeLedgerRepo();
  const daily = new FakeDailyAggregates();
  const adapter = new FakeBrokerAdapter({ quotes: [makeQuote({ ltp: 2950 })] });
  const broker = new FakeBrokerGateway(adapter);
  const sessions = new FakeSessionStore([{ uid: 'u1', session: makeBrokerSession() }]);

  const service = createExecutionService({
    clock,
    ids,
    logger: silentLogger(),
    proposals,
    orders,
    idempotency,
    configs,
    books,
    ledger,
    daily,
    broker,
    sessions,
    audit: createAuditWriter({ audit: auditLog, ids, clock, ip: STATIC_IP }),
    environment: 'dry-run',
    staticIp: STATIC_IP,
    marketHolidays: [],
  });

  return {
    service,
    clock,
    proposals,
    orders,
    idempotency,
    configs,
    auditLog,
    books,
    ledger,
    daily,
    adapter,
    broker,
    sessions,
    run: (patch) =>
      service.executeProposal({
        uid: 'u1',
        proposalId: 'p1',
        idempotencyKey: 'idem-00000001',
        clientSeenLtp: 2950,
        ...patch,
      }),
  };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

// ---------------------------------------------------------------------------
// B — owner
// ---------------------------------------------------------------------------

describe('owner check (flowchart B)', () => {
  it('refuses a caller who does not own the proposal', async () => {
    const result = await h.run({ uid: 'intruder' });

    expect(result).toMatchObject({ ok: false, reason: 'UNAUTHORIZED' });
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
    expect(h.idempotency.docs.size).toBe(0);
    expect(h.auditLog.types()).toContain('guardrail.blocked');
  });

  it('does not burn the idempotency key on an ownership refusal', async () => {
    await h.run({ uid: 'intruder' });
    const retry = await h.run();
    expect(retry.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C/D — idempotency
// ---------------------------------------------------------------------------

describe('idempotency (flowchart C/D)', () => {
  it('returns the prior result on replay without placing a second order', async () => {
    const first = await h.run();
    expect(first.ok).toBe(true);
    expect(h.adapter.placeOrderCalls).toHaveLength(1);

    const replay = await h.run();
    expect(replay).toEqual(first);
    expect(h.adapter.placeOrderCalls).toHaveLength(1);
  });

  it('refuses a replay of an in-progress key', async () => {
    await h.idempotency.acquire('idem-00000001', 'p1', h.clock.now());
    const result = await h.run();

    expect(result).toMatchObject({ ok: false, reason: 'IDEMPOTENT_REPLAY' });
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });

  it('refuses a key already bound to another proposal', async () => {
    await h.idempotency.acquire('idem-00000001', 'p-other', h.clock.now());
    const result = await h.run();

    expect(result).toMatchObject({ ok: false, reason: 'IDEMPOTENT_REPLAY' });
    expect((result as { detail: string }).detail).toContain('p-other');
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });

  it('places exactly once for a concurrent double-tap of the same key', async () => {
    const [a, b] = await Promise.all([h.run(), h.run()]);

    expect(h.adapter.placeOrderCalls).toHaveLength(1);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(h.orders.docs.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// E — proposal state and TTL
// ---------------------------------------------------------------------------

describe('proposal state (flowchart E)', () => {
  it('refuses an unknown proposal without taking the lock', async () => {
    const result = await h.run({ proposalId: 'missing' });

    expect(result).toMatchObject({ ok: false, reason: 'STALE_PROPOSAL' });
    expect(h.idempotency.docs.size).toBe(0);
  });

  it.each(['filled', 'rejected', 'blocked', 'failed', 'expired', 'placed', 'placing'] as const)(
    'refuses a proposal in status %s',
    async (status) => {
      h.proposals.put(makeProposal({ status }));
      const result = await h.run();

      expect(result).toMatchObject({ ok: false, reason: 'STALE_PROPOSAL' });
      expect(h.adapter.placeOrderCalls).toHaveLength(0);
    },
  );

  it('marks an expired proposal expired and audits it', async () => {
    h.clock.set('2026-01-13T04:50:00.000Z');
    const result = await h.run();

    expect(result).toMatchObject({ ok: false, reason: 'STALE_PROPOSAL' });
    expect(h.proposals.statusOf('p1')).toBe('expired');
    expect(h.auditLog.types()).toContain('proposal.expired');
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });

  it('refuses a proposal with an unparseable ttl', async () => {
    h.proposals.put(makeProposal({ ttlExpiresAt: 'not-a-date' }));
    const result = await h.run();
    expect(result).toMatchObject({ ok: false, reason: 'STALE_PROPOSAL' });
  });
});

// ---------------------------------------------------------------------------
// F — kill switch / tradingEnabled
// ---------------------------------------------------------------------------

describe('halt conditions (flowchart F)', () => {
  it('refuses when the kill switch is on', async () => {
    h.configs.docs.set('u1', makeConfig({ killSwitch: true }));
    const result = await h.run();

    expect(result).toMatchObject({ ok: false, reason: 'HALTED' });
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
    expect(h.auditLog.types()).toContain('guardrail.blocked');
  });

  it('refuses when tradingEnabled is false', async () => {
    h.configs.docs.set('u1', makeConfig({ tradingEnabled: false }));
    expect(await h.run()).toMatchObject({ ok: false, reason: 'HALTED' });
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });

  it('refuses when the config cannot be read at all (fail closed)', async () => {
    h.configs.docs.delete('u1');
    expect(await h.run()).toMatchObject({ ok: false, reason: 'HALTED' });
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });

  it('refuses when a biometric assertion is required but absent', async () => {
    h.configs.docs.set('u1', makeConfig({ guardrails: { requireBiometric: true } }));
    expect(await h.run()).toMatchObject({ ok: false, reason: 'UNAUTHORIZED' });
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });

  it('proceeds when the required biometric assertion is supplied', async () => {
    h.configs.docs.set('u1', makeConfig({ guardrails: { requireBiometric: true } }));
    expect(await h.run({ biometricAssertion: 'attestation-blob' })).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// G — market hours
// ---------------------------------------------------------------------------

describe('market hours (flowchart G)', () => {
  it('refuses outside the session', async () => {
    h.clock.set(MARKET_CLOSED_NOW);
    // Keep the proposal itself fresh so this is unambiguously the hours check.
    h.proposals.put(makeProposal({ ttlExpiresAt: '2026-01-13T04:45:00.000Z' }));

    const result = await h.run();
    expect(result).toMatchObject({ ok: false, reason: 'MARKET_CLOSED' });
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// H — session
// ---------------------------------------------------------------------------

describe('broker session (flowchart H)', () => {
  it('refuses when no session can be built', async () => {
    h.broker.error = new SessionUnavailableError('dhan', 'secret not set');
    const result = await h.run();

    expect(result).toMatchObject({ ok: false, reason: 'SESSION_INVALID' });
    expect(h.auditLog.types()).toContain('session.expired');
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });

  it('refuses a disconnected session', async () => {
    h.broker.session = makeSessionStatus({ connected: false });
    expect(await h.run()).toMatchObject({ ok: false, reason: 'SESSION_INVALID' });
  });

  it('refuses a session already past its expiry', async () => {
    h.broker.session = makeSessionStatus({ expiresAt: '2026-01-13T04:00:00.000Z' });
    expect(await h.run()).toMatchObject({ ok: false, reason: 'SESSION_INVALID' });
  });

  it('refuses a session inside the expiry safety margin', async () => {
    // 60s of life left, inside core's 120s margin.
    h.broker.session = makeSessionStatus({ expiresAt: '2026-01-13T04:31:00.000Z' });
    const result = await h.run();

    expect(result).toMatchObject({ ok: false, reason: 'SESSION_INVALID' });
    expect((result as { detail: string }).detail).toMatch(/safety margin/);
  });

  it('refuses a session whose IP was rejected', async () => {
    h.broker.session = makeSessionStatus({ staticIpOk: false });
    expect(await h.run()).toMatchObject({ ok: false, reason: 'SESSION_INVALID' });
  });

  it('refuses a session for the wrong broker', async () => {
    h.broker.session = makeSessionStatus({ broker: 'kite' });
    expect(await h.run()).toMatchObject({ ok: false, reason: 'SESSION_INVALID' });
  });
});

// ---------------------------------------------------------------------------
// I — the guardrail suite on live data
// ---------------------------------------------------------------------------

describe('guardrail suite (flowchart I)', () => {
  it('blocks, reports the failing checks and marks the proposal blocked', async () => {
    h.configs.docs.set('u1', makeConfig({ guardrails: { maxOrderValueInr: 1_000 } }));
    const result = await h.run();

    expect(result).toMatchObject({ ok: false, reason: 'GUARDRAIL_BLOCKED' });
    const checks = (result as { failedChecks: { name: string }[] }).failedChecks;
    expect(checks.map((c) => c.name)).toContain('maxOrderValue');
    expect(h.proposals.statusOf('p1')).toBe('blocked');
    expect(h.auditLog.byType('guardrail.blocked').length).toBeGreaterThan(0);
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });

  it('records the approval before the verdict, so blocked is a legal transition', async () => {
    h.configs.docs.set('u1', makeConfig({ guardrails: { maxOrderValueInr: 1_000 } }));
    await h.run();

    expect(h.auditLog.types()).toContain('proposal.approved');
    expect(h.proposals.transitions).toEqual([
      { id: 'p1', from: 'pending', to: 'approved' },
      { id: 'p1', from: 'approved', to: 'blocked' },
    ]);
  });

  it('lets the code ceiling beat an over-generous config', async () => {
    // Config says ₹10,000,000 is fine; ABS_MAX_ORDER_VALUE_INR (₹500,000) is not.
    h.configs.docs.set(
      'u1',
      makeConfig({
        guardrails: { maxOrderValueInr: 10_000_000, maxDailyNotionalInr: 10_000_000 },
      }),
    );
    h.proposals.put(makeProposal({ order: makeOrder({ quantity: 200 }) }));

    const result = await h.run();
    expect(result).toMatchObject({ ok: false, reason: 'GUARDRAIL_BLOCKED' });
    const checks = (result as { failedChecks: { name: string; detail: string }[] }).failedChecks;
    const cap = checks.find((c) => c.name === 'maxOrderValue');
    expect(cap?.detail).toContain('500000');
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });

  it('fails closed when the live quote is missing', async () => {
    h.adapter.script.quotes = [];
    const result = await h.run();

    expect(result).toMatchObject({ ok: false, reason: 'GUARDRAIL_BLOCKED' });
    const names = (result as { failedChecks: { name: string }[] }).failedChecks.map((c) => c.name);
    expect(names).toContain('priceCollar');
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });

  it('blocks a blocklisted symbol', async () => {
    h.configs.docs.set('u1', makeConfig({ guardrails: { symbolBlocklist: ['RELIANCE'] } }));
    const result = await h.run();
    const names = (result as { failedChecks: { name: string }[] }).failedChecks.map((c) => c.name);
    expect(names).toContain('symbolAllowBlock');
  });

  it('blocks when the day already used its order budget', async () => {
    h.daily.value = { orderCount: 10, notionalInr: 0 };
    const result = await h.run();
    const names = (result as { failedChecks: { name: string }[] }).failedChecks.map((c) => c.name);
    expect(names).toContain('dailyOrderCount');
  });

  it('blocks when funds are insufficient', async () => {
    h.adapter.script.funds = {
      availableCash: 10,
      usedMargin: 0,
      availableMargin: 10,
      raw: null,
    };
    const result = await h.run();
    const names = (result as { failedChecks: { name: string }[] }).failedChecks.map((c) => c.name);
    expect(names).toContain('fundsSufficient');
  });
});

// ---------------------------------------------------------------------------
// J — clientSeenLtp collar
// ---------------------------------------------------------------------------

describe('staleness guard (flowchart J)', () => {
  it('refuses when the price moved beyond the collar since approval', async () => {
    const result = await h.run({ clientSeenLtp: 2_500 });

    expect(result).toMatchObject({ ok: false, reason: 'PRICE_MOVED' });
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
    // Not terminal: the human can re-confirm at the new price.
    expect(h.proposals.statusOf('p1')).toBe('approved');
    expect(h.auditLog.byType('guardrail.blocked')[0]?.detail['reason']).toBe('PRICE_MOVED');
  });

  it('refuses when no clientSeenLtp was supplied at all', async () => {
    const result = await h.run({ clientSeenLtp: undefined });
    expect(result).toMatchObject({ ok: false, reason: 'PRICE_MOVED' });
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });

  it('accepts a price inside the collar', async () => {
    expect(await h.run({ clientSeenLtp: 2_949 })).toMatchObject({ ok: true });
  });
});

describe('stalenessRefusal', () => {
  it('rejects absent, non-finite and non-positive inputs', () => {
    expect(stalenessRefusal(undefined, 100, 2)).toMatch(/no clientSeenLtp/);
    expect(stalenessRefusal(Number.NaN, 100, 2)).toMatch(/no clientSeenLtp/);
    expect(stalenessRefusal(0, 100, 2)).toMatch(/no clientSeenLtp/);
  });

  it('rejects an unusable live price', () => {
    expect(stalenessRefusal(100, 0, 2)).toMatch(/no usable live LTP/);
  });

  it('accepts a deviation exactly on the collar', () => {
    expect(stalenessRefusal(98, 100, 2)).toBeUndefined();
    expect(stalenessRefusal(97, 100, 2)).toMatch(/price moved/);
  });
});

// ---------------------------------------------------------------------------
// Book budget (docs/10 §10.3) and ledger canExit (§10.4)
// ---------------------------------------------------------------------------

describe('book budget and ledger ownership', () => {
  it('refuses when the book has no budget left', async () => {
    h.books.docs.set('u1:long_term', makeBook({ deployedInr: 500_000 }));
    const result = await h.run();

    expect(result).toMatchObject({ ok: false, reason: 'BUDGET_EXCEEDED' });
    expect(h.proposals.statusOf('p1')).toBe('blocked');
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });

  it('refuses when the book is disabled', async () => {
    h.books.docs.set('u1:long_term', makeBook({ enabled: false }));
    expect(await h.run()).toMatchObject({ ok: false, reason: 'BUDGET_EXCEEDED' });
  });

  it('refuses when the book does not exist (fail closed)', async () => {
    h.books.docs.clear();
    const result = await h.run();

    expect(result).toMatchObject({ ok: false, reason: 'BUDGET_EXCEEDED' });
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });

  it('refuses an exit of quantity the book does not own', async () => {
    h.proposals.put(
      makeProposal({ order: makeOrder({ side: 'SELL', quantity: 5, limitPrice: 2950.5 }) }),
    );
    const result = await h.run();

    expect(result).toMatchObject({ ok: false, reason: 'OWNERSHIP' });
    expect(h.proposals.statusOf('p1')).toBe('blocked');
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });

  it('refuses an exit larger than the book owns', async () => {
    await h.ledger.append(makeLedgerEntry({ qty: 3 }));
    h.proposals.put(
      makeProposal({ order: makeOrder({ side: 'SELL', quantity: 5, limitPrice: 2950.5 }) }),
    );
    expect(await h.run()).toMatchObject({ ok: false, reason: 'OWNERSHIP' });
  });

  it('allows an exit of owned quantity without re-deploying capital', async () => {
    await h.ledger.append(makeLedgerEntry({ qty: 10 }));
    h.books.docs.set('u1:long_term', makeBook({ deployedInr: 29_000 }));
    h.proposals.put(
      makeProposal({ order: makeOrder({ side: 'SELL', quantity: 5, limitPrice: 2950.5 }) }),
    );

    const result = await h.run();
    expect(result).toMatchObject({ ok: true });
    expect(h.books.docs.get('u1:long_term')?.deployedInr).toBe(29_000);
  });

  /**
   * The bug this model exists to prevent: a submitted-but-unfilled BUY must not
   * make the book look like it owns anything. Otherwise a day-trade book's EOD
   * square-off would "close" shares that never arrived and open a real short.
   */
  it('does not let an unfilled BUY satisfy a later SELL', async () => {
    const buy = await h.run();
    expect(buy).toMatchObject({ ok: true });
    // The order is SUBMITTED, nothing has filled, so the ledger is still empty.
    expect(await h.ledger.list('u1')).toHaveLength(0);

    h.proposals.put(
      makeProposal({
        id: 'p2',
        order: makeOrder({ side: 'SELL', quantity: 10, limitPrice: 2950.5 }),
      }),
    );
    const sell = await h.run({ proposalId: 'p2', idempotencyKey: 'idem-00000002' });

    expect(sell).toMatchObject({ ok: false, reason: 'OWNERSHIP' });
    expect(h.proposals.statusOf('p2')).toBe('blocked');
    // Exactly one order ever reached the broker: the BUY.
    expect(h.adapter.placeOrderCalls).toHaveLength(1);
    expect(h.adapter.placeOrderCalls[0]?.order.side).toBe('BUY');
  });

  it('still holds the sleeve’s capital while the BUY is unfilled', async () => {
    await h.run();
    expect(h.books.docs.get('u1:long_term')?.deployedInr).toBeCloseTo(29_505, 6);
  });

  it('reserves a MARKET order at the proposal-time LTP', async () => {
    h.proposals.put(
      makeProposal({
        order: makeOrder({ orderType: 'MARKET', limitPrice: undefined }),
        marketContext: { ltpAtProposal: 2_951 },
      }),
    );
    const result = await h.run();

    expect(result).toMatchObject({ ok: true });
    expect(h.books.docs.get('u1:long_term')?.deployedInr).toBeCloseTo(29_510, 6);
  });

  it('checks the budget against the reservation, not the live quote', async () => {
    // Budget leaves room for the ordered value (₹29,505) but not much more.
    h.books.docs.set('u1:long_term', makeBook({ allocatedCapitalInr: 29_600 }));
    expect(await h.run()).toMatchObject({ ok: true });

    h.books.docs.set('u1:long_term', makeBook({ allocatedCapitalInr: 29_000 }));
    h.proposals.put(makeProposal({ id: 'p2' }));
    expect(await h.run({ proposalId: 'p2', idempotencyKey: 'idem-00000002' })).toMatchObject({
      ok: false,
      reason: 'BUDGET_EXCEEDED',
    });
  });
});

// ---------------------------------------------------------------------------
// L/M — broker failures
// ---------------------------------------------------------------------------

describe('broker failures (flowchart M)', () => {
  it('marks the proposal failed and never retries after a rejection', async () => {
    h.adapter.script.throwOn = {
      placeOrder: new BrokerError('RISK_REJECTED', 'RMS blocked the order'),
    };
    const result = await h.run();

    expect(result).toMatchObject({
      ok: false,
      reason: 'BROKER_ERROR',
      brokerErrorKind: 'RISK_REJECTED',
    });
    expect(h.proposals.statusOf('p1')).toBe('failed');
    expect(h.idempotency.docs.get('idem-00000001')?.status).toBe('failed');
    expect(h.adapter.placeOrderCalls).toHaveLength(1);
    expect(h.auditLog.types()).toContain('order.failed');
    expect(h.orders.docs.size).toBe(0);
  });

  it('treats a network error the same way — one attempt, no retry', async () => {
    h.adapter.script.throwOn = { placeOrder: new BrokerError('NETWORK', 'socket hang up') };
    await h.run();

    expect(h.adapter.placeOrderCalls).toHaveLength(1);
    expect(h.proposals.statusOf('p1')).toBe('failed');
  });

  it('maps AUTH_EXPIRED to a re-login refusal', async () => {
    h.adapter.script.throwOn = { placeOrder: new BrokerError('AUTH_EXPIRED', 'token dead') };
    const result = await h.run();

    expect(result).toMatchObject({ ok: false, reason: 'SESSION_INVALID' });
    expect(h.auditLog.types()).toContain('session.expired');
  });

  it('flips staticIpOk off and audits on an IP rejection', async () => {
    h.adapter.script.throwOn = {
      placeOrder: new BrokerError('IP_NOT_WHITELISTED', 'IP 1.2.3.4 not allowed'),
    };
    const result = await h.run();

    expect(result).toMatchObject({ ok: false, reason: 'BROKER_ERROR' });
    expect(h.auditLog.types()).toContain('ip.changed');
    expect((await h.sessions.get('u1', 'dhan'))?.staticIpOk).toBe(false);
  });

  it('refuses without placing when live market data cannot be fetched', async () => {
    h.adapter.script.throwOn = { getFunds: new BrokerError('NETWORK', 'funds endpoint down') };
    const result = await h.run();

    expect(result).toMatchObject({ ok: false, reason: 'BROKER_ERROR' });
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
    // The proposal stays retryable — nothing was attempted at the broker.
    expect(h.proposals.statusOf('p1')).toBe('pending');
    expect(h.idempotency.docs.get('idem-00000001')?.status).toBe('failed');
  });

  it('maps an AUTH_EXPIRED during market data to SESSION_INVALID', async () => {
    h.adapter.script.throwOn = { getQuote: new BrokerError('AUTH_EXPIRED', 'token dead') };
    expect(await h.run()).toMatchObject({ ok: false, reason: 'SESSION_INVALID' });
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });

  it('maps a plain Error to an UNKNOWN broker error', async () => {
    h.adapter.script.throwOn = { placeOrder: new Error('kaboom') };
    const result = await h.run();
    expect(result).toMatchObject({ reason: 'BROKER_ERROR', brokerErrorKind: 'UNKNOWN' });
  });
});

// ---------------------------------------------------------------------------
// Losing the compare-and-set race — the last line of defence against a
// double-execute. Simulated by moving the proposal from under the transition.
// ---------------------------------------------------------------------------

describe('concurrent state changes', () => {
  /** Rewrites the stored proposal just before the Nth transition is attempted. */
  function sabotage(nth: number, status: Proposal['status']): void {
    const real = h.proposals.transition.bind(h.proposals);
    let seen = 0;
    h.proposals.transition = (id, from, to, patch) => {
      seen += 1;
      if (seen === nth) h.proposals.put(makeProposal({ status }));
      return real(id, from, to, patch);
    };
  }

  it('refuses when the proposal is approved by someone else first', async () => {
    sabotage(1, 'placed');
    const result = await h.run();

    expect(result).toMatchObject({ ok: false, reason: 'STALE_PROPOSAL' });
    expect((result as { detail: string }).detail).toContain('concurrently');
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });

  it('refuses when the proposal vanishes before the approval', async () => {
    const real = h.proposals.transition.bind(h.proposals);
    h.proposals.transition = (id, from, to, patch) => {
      h.proposals.docs.delete('p1');
      return real(id, from, to, patch);
    };

    const result = await h.run();
    expect(result).toMatchObject({ ok: false, reason: 'STALE_PROPOSAL' });
    expect((result as { detail: string }).detail).toContain('disappeared');
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
  });

  it('refuses at the placing hand-off if the proposal moved', async () => {
    // 1st transition is pending → approved; sabotage the 2nd (approved → placing).
    sabotage(2, 'placed');
    const result = await h.run();

    expect(result).toMatchObject({ ok: false, reason: 'STALE_PROPOSAL' });
    expect(h.adapter.placeOrderCalls).toHaveLength(0);
    expect(h.orders.docs.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// N — the success path
// ---------------------------------------------------------------------------

describe('success path (flowchart N)', () => {
  it('writes the order, reservation, audit and proposal state — but no ledger row', async () => {
    const result = await h.run();
    expect(result).toEqual({
      ok: true,
      orderId: 'ord_0001',
      brokerOrderId: 'BRK-0001',
      status: 'SUBMITTED',
    });

    const order = await h.orders.get('ord_0001');
    expect(order).toMatchObject({
      uid: 'u1',
      proposalId: 'p1',
      broker: 'dhan',
      bookId: 'long_term',
      horizon: 'long_term',
      idempotencyKey: 'idem-00000001',
      status: 'SUBMITTED',
      filledQty: 0,
      avgFillPrice: null,
      approvedBy: 'u1',
      ipUsed: STATIC_IP,
      environment: 'dry-run',
    });
    expect(order?.brokerRawAck).toBeDefined();

    // Nothing is owned until something fills — reconciliation writes the row.
    expect(await h.ledger.list('u1')).toHaveLength(0);
    // The sleeve's capital is reserved in the meantime.
    expect(h.books.docs.get('u1:long_term')?.deployedInr).toBeCloseTo(29_505, 6);
    expect(h.auditLog.byType('order.submitted')[0]?.detail['reservedInr']).toBeCloseTo(29_505, 6);
    expect(h.proposals.statusOf('p1')).toBe('placed');
    expect(h.proposals.docs.get('p1')?.orderId).toBe('ord_0001');
    expect(h.idempotency.docs.get('idem-00000001')).toMatchObject({
      status: 'done',
      orderId: 'ord_0001',
    });
    expect(h.auditLog.types()).toEqual(['proposal.approved', 'order.submitted']);
    expect(h.auditLog.byType('order.submitted')[0]?.ip).toBe(STATIC_IP);
  });

  it('passes the idempotency key through to the broker for correlation', async () => {
    await h.run();
    expect(h.adapter.placeOrderCalls[0]?.idempotencyKey).toBe('idem-00000001');
  });

  it('executes an already-approved proposal without re-approving it', async () => {
    h.proposals.put(
      makeProposal({ status: 'approved', decidedBy: 'u1', decidedAt: MARKET_OPEN_NOW }),
    );
    const result = await h.run();

    expect(result).toMatchObject({ ok: true });
    expect(h.auditLog.types()).toEqual(['order.submitted']);
  });
});
