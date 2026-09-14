import { beforeEach, describe, expect, it } from 'vitest';
import { BrokerError } from '@pm/core';
import type { OrderStatus } from '@pm/core';
import { silentLogger } from '../logger.js';
import { createAuditWriter } from './audit.js';
import { createReconcileService, type ReconcileService } from './reconcile.js';
import {
  FakeAuditLog,
  FakeBookRepo,
  FakeBrokerAdapter,
  FakeBrokerGateway,
  FakeLedgerRepo,
  FakeOrderRepo,
  FakeProposalRepo,
  FixedClock,
  SeqIdGenerator,
} from '../test-utils/fakes.js';
import {
  MARKET_OPEN_NOW,
  makeBook,
  makeLedgerEntry,
  makeOrder,
  makeOrderRecord,
  makeProposal,
} from '../test-utils/fixtures.js';

const NOW = '2026-01-13T05:00:00.000Z';

function status(patch: Partial<OrderStatus>): OrderStatus {
  return {
    brokerOrderId: 'BRK-1',
    status: 'OPEN',
    filledQty: 0,
    pendingQty: 10,
    updatedAt: MARKET_OPEN_NOW,
    raw: null,
    ...patch,
  };
}

interface Harness {
  service: ReconcileService;
  clock: FixedClock;
  orders: FakeOrderRepo;
  proposals: FakeProposalRepo;
  ledger: FakeLedgerRepo;
  books: FakeBookRepo;
  auditLog: FakeAuditLog;
  adapter: FakeBrokerAdapter;
  broker: FakeBrokerGateway;
}

/**
 * One SUBMITTED order for 10 @ ₹2950.5, its proposal `placed`, and a book whose
 * ₹29,505 of `deployedInr` is entirely that order's reservation — no ledger row,
 * because nothing has filled yet.
 */
function harness(live: OrderStatus, opts?: { stuckAfterMs?: number }): Harness {
  const clock = new FixedClock(NOW);
  const ids = new SeqIdGenerator();
  const orders = new FakeOrderRepo([makeOrderRecord({ status: 'SUBMITTED' })]);
  const proposals = new FakeProposalRepo([makeProposal({ status: 'placed', orderId: 'ord_0001' })]);
  const ledger = new FakeLedgerRepo();
  const books = new FakeBookRepo([{ uid: 'u1', book: makeBook({ deployedInr: 29_505 }) }]);
  const auditLog = new FakeAuditLog();
  const adapter = new FakeBrokerAdapter({ orderStatuses: { 'BRK-1': live } });
  const broker = new FakeBrokerGateway(adapter);

  const service = createReconcileService({
    orders,
    proposals,
    ledger,
    books,
    broker,
    audit: createAuditWriter({ audit: auditLog, ids, clock, ip: '203.0.113.7' }),
    clock,
    ids,
    logger: silentLogger(),
    ...(opts?.stuckAfterMs === undefined ? {} : { stuckAfterMs: opts.stuckAfterMs }),
  });
  return { service, clock, orders, proposals, ledger, books, auditLog, adapter, broker };
}

let h: Harness;

describe('placed → filled', () => {
  beforeEach(() => {
    h = harness(status({ status: 'COMPLETE', filledQty: 10, pendingQty: 0, avgPrice: 2948.25 }));
  });

  it('updates the order, drives the proposal to filled and audits the fill', async () => {
    const summary = await h.service.reconcileUser('u1');
    expect(summary).toEqual({ checked: 1, updated: 1, errors: 0, stuck: 0 });

    expect(await h.orders.get('ord_0001')).toMatchObject({
      status: 'COMPLETE',
      filledQty: 10,
      avgFillPrice: 2948.25,
    });
    expect(h.proposals.statusOf('p1')).toBe('filled');
    expect(h.auditLog.types()).toEqual(['order.filled']);
  });

  it('creates the ledger row from the fill — the first row this order ever had', async () => {
    expect(await h.ledger.list('u1')).toHaveLength(0);
    await h.service.reconcileUser('u1');

    const entries = await h.ledger.list('u1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'led_ord_0001',
      bookId: 'long_term',
      strategyId: 'momentum-v1',
      side: 'BUY',
      qty: 10,
      price: 2948.25,
      orderId: 'ord_0001',
    });
  });

  it('replaces the reservation with the filled cost basis', async () => {
    await h.service.reconcileUser('u1');
    expect(h.books.docs.get('u1:long_term')?.deployedInr).toBeCloseTo(29_482.5, 6);
  });
});

describe('partial then complete', () => {
  it('creates one row on the partial and updates the same row on the fill', async () => {
    h = harness(status({ status: 'PARTIAL', filledQty: 4, pendingQty: 6, avgPrice: 2949 }));
    await h.service.reconcileUser('u1');

    let entries = await h.ledger.list('u1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'led_ord_0001', qty: 4, price: 2949 });
    // 4 filled @ 2949 + 6 still reserved @ 2950.5
    expect(h.books.docs.get('u1:long_term')?.deployedInr).toBeCloseTo(11_796 + 17_703, 6);
    // The proposal deliberately stays `placed` until terminal (docs/04 §4.10).
    expect(h.proposals.statusOf('p1')).toBe('placed');
    expect(h.auditLog.events).toHaveLength(0);

    // The rest fills: cumulative quantity, same row, no duplicate.
    h.adapter.script.orderStatuses = {
      'BRK-1': status({ status: 'COMPLETE', filledQty: 10, pendingQty: 0, avgPrice: 2949.6 }),
    };
    await h.service.reconcileUser('u1');

    entries = await h.ledger.list('u1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'led_ord_0001', qty: 10, price: 2949.6 });
    expect(h.books.docs.get('u1:long_term')?.deployedInr).toBeCloseTo(29_496, 6);
    expect(h.proposals.statusOf('p1')).toBe('filled');
  });
});

describe('placed → rejected', () => {
  beforeEach(() => {
    h = harness(status({ status: 'REJECTED', rejectionReason: 'insufficient margin' }));
  });

  it('marks the order and proposal rejected and audits it', async () => {
    await h.service.reconcileUser('u1');

    expect(await h.orders.get('ord_0001')).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'insufficient margin',
    });
    expect(h.proposals.statusOf('p1')).toBe('rejected');
    expect(h.auditLog.types()).toEqual(['order.rejected']);
  });

  it('writes no ledger row and releases the reservation exactly', async () => {
    await h.service.reconcileUser('u1');

    expect(await h.ledger.list('u1')).toHaveLength(0);
    expect(h.books.docs.get('u1:long_term')?.deployedInr).toBe(0);
  });

  it('releases only its own reservation, leaving other books and orders alone', async () => {
    await h.orders.create(
      makeOrderRecord({
        id: 'ord_0002',
        proposalId: 'p2',
        brokerOrderId: 'BRK-2',
        status: 'OPEN',
      }),
    );
    await h.ledger.append(
      makeLedgerEntry({ id: 'led_ord_0003', orderId: 'ord_0003', qty: 2, price: 100 }),
    );
    h.books.docs.set('u1:long_term', makeBook({ deployedInr: 29_505 + 29_505 + 200 }));
    h.adapter.script.orderStatuses = {
      'BRK-1': status({ status: 'REJECTED' }),
      'BRK-2': status({ status: 'OPEN' }),
    };

    await h.service.reconcileUser('u1');

    // 200 filled (ord_0003) + 29,505 still reserved (ord_0002). The rejected
    // order's 29,505 is gone, and nothing else moved.
    expect(h.books.docs.get('u1:long_term')?.deployedInr).toBeCloseTo(29_705, 6);
  });
});

describe('MARKET orders', () => {
  it('prices a still-open MARKET order’s reservation from its proposal LTP', async () => {
    h = harness(status({ status: 'REJECTED' }));
    h.proposals.put(
      makeProposal({
        id: 'p2',
        status: 'placed',
        order: makeOrder({ orderType: 'MARKET', limitPrice: undefined }),
        marketContext: { ltpAtProposal: 2_951 },
      }),
    );
    await h.orders.create(
      makeOrderRecord({
        id: 'ord_0002',
        proposalId: 'p2',
        brokerOrderId: 'BRK-2',
        status: 'OPEN',
        order: makeOrder({ orderType: 'MARKET', limitPrice: undefined }),
      }),
    );
    h.adapter.script.orderStatuses = {
      'BRK-1': status({ status: 'REJECTED' }),
      'BRK-2': status({ status: 'OPEN' }),
    };

    await h.service.reconcileUser('u1');

    // Only the MARKET order's reservation survives: 10 × ₹2,951.
    expect(h.books.docs.get('u1:long_term')?.deployedInr).toBeCloseTo(29_510, 6);
  });
});

describe('cancellation', () => {
  it('treats a cancel with no fill like a reject', async () => {
    h = harness(status({ status: 'CANCELLED' }));
    await h.service.reconcileUser('u1');

    expect(h.proposals.statusOf('p1')).toBe('rejected');
    expect(await h.ledger.list('u1')).toHaveLength(0);
    expect(h.books.docs.get('u1:long_term')?.deployedInr).toBe(0);
  });

  it('keeps the filled part of a partially-filled cancel', async () => {
    h = harness(status({ status: 'CANCELLED', filledQty: 4, avgPrice: 2949 }));
    await h.service.reconcileUser('u1');

    const entries = await h.ledger.list('u1');
    expect(entries[0]).toMatchObject({ qty: 4, price: 2949 });
    // Only the filled part remains deployed — the cancelled remainder is freed.
    expect(h.books.docs.get('u1:long_term')?.deployedInr).toBeCloseTo(11_796, 6);
  });
});

describe('statuses that are not news', () => {
  it('leaves an UNKNOWN status alone', async () => {
    h = harness(status({ status: 'UNKNOWN' }));
    const summary = await h.service.reconcileUser('u1');

    expect(summary).toEqual({ checked: 1, updated: 0, errors: 0, stuck: 0 });
    expect(await h.orders.get('ord_0001')).toMatchObject({ status: 'SUBMITTED' });
    expect(h.proposals.statusOf('p1')).toBe('placed');
    expect(h.auditLog.events).toHaveLength(0);
    expect(await h.ledger.list('u1')).toHaveLength(0);
  });

  it('leaves a still-open order alone', async () => {
    h = harness(status({ status: 'OPEN' }));
    expect(await h.service.reconcileUser('u1')).toEqual({
      checked: 1,
      updated: 0,
      errors: 0,
      stuck: 0,
    });
  });

  it('is idempotent — a second pass over a terminal order changes nothing', async () => {
    h = harness(status({ status: 'COMPLETE', filledQty: 10, avgPrice: 2948.25 }));
    await h.service.reconcileUser('u1');
    h.auditLog.events.length = 0;

    // The order is no longer "open", so it is not even re-polled.
    expect(await h.service.reconcileUser('u1')).toEqual({
      checked: 0,
      updated: 0,
      errors: 0,
      stuck: 0,
    });
    expect(h.auditLog.events).toHaveLength(0);
    expect(await h.ledger.list('u1')).toHaveLength(1);
  });
});

describe('failures', () => {
  it('counts a broker error without touching any state', async () => {
    h = harness(status({}));
    h.adapter.script.throwOn = { getOrder: new BrokerError('NETWORK', 'timeout') };

    expect(await h.service.reconcileUser('u1')).toEqual({
      checked: 1,
      updated: 0,
      errors: 1,
      stuck: 0,
    });
    expect(await h.orders.get('ord_0001')).toMatchObject({ status: 'SUBMITTED' });
  });

  it('skips an order that never reached the broker', async () => {
    h = harness(status({}));
    await h.orders.patch('ord_0001', { brokerOrderId: null });

    expect(await h.service.reconcileUser('u1')).toEqual({
      checked: 1,
      updated: 0,
      errors: 0,
      stuck: 0,
    });
  });

  it('recomputes a book that no longer exists without throwing', async () => {
    h = harness(status({ status: 'COMPLETE', filledQty: 10, avgPrice: 2948.25 }));
    h.books.docs.clear();

    expect((await h.service.reconcileUser('u1')).updated).toBe(1);
    expect(h.proposals.statusOf('p1')).toBe('filled');
  });
});

describe('stuck-proposal sweep', () => {
  /** A proposal parked in `status` since 04:30 IST-UTC, with no order record. */
  function parked(status: 'approved' | 'placing'): void {
    h.proposals.docs.clear();
    h.orders.docs.clear();
    h.proposals.put(
      makeProposal({ id: 'p9', status, decidedBy: 'u1', decidedAt: MARKET_OPEN_NOW }),
    );
  }

  beforeEach(() => {
    h = harness(status({}), { stuckAfterMs: 5 * 60 * 1000 });
  });

  it('leaves a proposal alone before the deadline', async () => {
    parked('approved');
    // decidedAt 04:30, clock 04:34 — four minutes is not yet stuck.
    h.clock.set('2026-01-13T04:34:00.000Z');

    expect((await h.service.reconcileUser('u1')).stuck).toBe(0);
    expect(h.proposals.statusOf('p9')).toBe('approved');
  });

  it('moves a stuck approved proposal to blocked with a stuck audit', async () => {
    parked('approved');
    h.clock.set('2026-01-13T04:36:00.000Z');

    expect((await h.service.reconcileUser('u1')).stuck).toBe(1);
    expect(h.proposals.statusOf('p9')).toBe('blocked');
    expect(h.proposals.docs.get('p9')?.failureReason).toBe('stuck');

    const event = h.auditLog.byType('guardrail.blocked')[0];
    expect(event).toMatchObject({ refId: 'p9' });
    expect(event?.detail).toMatchObject({ reason: 'stuck', from: 'approved', to: 'blocked' });
  });

  it('moves a stuck placing proposal to failed with a stuck audit', async () => {
    parked('placing');
    h.clock.set('2026-01-13T04:36:00.000Z');

    expect((await h.service.reconcileUser('u1')).stuck).toBe(1);
    expect(h.proposals.statusOf('p9')).toBe('failed');
    expect(h.auditLog.byType('order.failed')[0]?.detail).toMatchObject({
      reason: 'stuck',
      from: 'placing',
      to: 'failed',
    });
  });

  it('never touches a proposal that produced an order', async () => {
    // ord_0001 belongs to p1; park p1 itself in `placing`.
    h.proposals.put(makeProposal({ status: 'placing', decidedAt: MARKET_OPEN_NOW }));
    h.clock.set('2026-01-13T06:00:00.000Z');

    expect((await h.service.reconcileUser('u1')).stuck).toBe(0);
    expect(h.proposals.statusOf('p1')).toBe('placing');
  });

  it('frees the stuck proposal’s reservation', async () => {
    parked('approved');
    h.clock.set('2026-01-13T04:36:00.000Z');
    await h.service.reconcileUser('u1');

    expect(h.books.docs.get('u1:long_term')?.deployedInr).toBe(0);
  });

  it('falls back to createdAt when the proposal was never decided', async () => {
    h.proposals.docs.clear();
    h.orders.docs.clear();
    h.proposals.put(makeProposal({ id: 'p9', status: 'approved', createdAt: MARKET_OPEN_NOW }));
    h.clock.set('2026-01-13T04:36:00.000Z');

    expect((await h.service.reconcileUser('u1')).stuck).toBe(1);
  });

  it('skips a proposal whose timestamp cannot be parsed', async () => {
    h.proposals.docs.clear();
    h.orders.docs.clear();
    h.proposals.put(
      makeProposal({ id: 'p9', status: 'approved', decidedBy: 'u1', decidedAt: 'whenever' }),
    );
    h.clock.set('2026-01-13T06:00:00.000Z');

    expect((await h.service.reconcileUser('u1')).stuck).toBe(0);
    expect(h.proposals.statusOf('p9')).toBe('approved');
  });

  it('skips a proposal that moved on between the read and the write', async () => {
    parked('approved');
    h.clock.set('2026-01-13T04:36:00.000Z');
    const real = h.proposals.transition.bind(h.proposals);
    h.proposals.transition = (id, from, to, patch) => {
      h.proposals.put(makeProposal({ id: 'p9', status: 'placed' }));
      return real(id, from, to, patch);
    };

    expect((await h.service.reconcileUser('u1')).stuck).toBe(0);
    expect(h.auditLog.events).toHaveLength(0);
  });

  it('uses a five-minute default when none is injected', async () => {
    h = harness(status({}));
    parked('approved');
    h.clock.set('2026-01-13T04:34:00.000Z');
    expect((await h.service.reconcileUser('u1')).stuck).toBe(0);

    h.clock.set('2026-01-13T04:36:00.000Z');
    expect((await h.service.reconcileUser('u1')).stuck).toBe(1);
  });
});

describe('syncOrder', () => {
  beforeEach(() => {
    h = harness(status({ status: 'COMPLETE', filledQty: 10, avgPrice: 2948.25 }));
  });

  it('re-syncs one order and reports the change', async () => {
    const result = await h.service.syncOrder('u1', 'ord_0001');

    expect(result).toMatchObject({ ok: true, changed: true });
    expect((result as { order: { status: string } }).order.status).toBe('COMPLETE');
  });

  it('refuses an order owned by someone else', async () => {
    expect(await h.service.syncOrder('intruder', 'ord_0001')).toMatchObject({
      ok: false,
      reason: 'UNAUTHORIZED',
    });
  });

  it('reports a missing order', async () => {
    expect(await h.service.syncOrder('u1', 'nope')).toMatchObject({
      ok: false,
      reason: 'NOT_FOUND',
    });
  });

  it('surfaces a broker failure', async () => {
    h.adapter.script.throwOn = { getOrder: new BrokerError('NETWORK', 'timeout') };
    expect(await h.service.syncOrder('u1', 'ord_0001')).toMatchObject({
      ok: false,
      reason: 'BROKER_ERROR',
    });
  });
});
