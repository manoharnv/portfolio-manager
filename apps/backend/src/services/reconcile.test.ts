import { beforeEach, describe, expect, it } from 'vitest';
import { BrokerError } from '@pm/core';
import type { OrderStatus } from '@pm/core';
import { silentLogger } from '../logger.js';
import { createAuditWriter } from './audit.js';
import { createReconcileService, deployedFromLedger, type ReconcileService } from './reconcile.js';
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
  makeOrderRecord,
  makeProposal,
} from '../test-utils/fixtures.js';

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
  orders: FakeOrderRepo;
  proposals: FakeProposalRepo;
  ledger: FakeLedgerRepo;
  books: FakeBookRepo;
  auditLog: FakeAuditLog;
  adapter: FakeBrokerAdapter;
  broker: FakeBrokerGateway;
}

function harness(live: OrderStatus): Harness {
  const clock = new FixedClock('2026-01-13T05:00:00.000Z');
  const ids = new SeqIdGenerator();
  const orders = new FakeOrderRepo([makeOrderRecord({ status: 'SUBMITTED' })]);
  const proposals = new FakeProposalRepo([makeProposal({ status: 'placed', orderId: 'ord_0001' })]);
  const ledger = new FakeLedgerRepo([
    makeLedgerEntry({ id: 'led_ord_0001', orderId: 'ord_0001', qty: 10, price: 2950.5 }),
  ]);
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
  });
  return { service, orders, proposals, ledger, books, auditLog, adapter, broker };
}

let h: Harness;

describe('placed → filled', () => {
  beforeEach(() => {
    h = harness(status({ status: 'COMPLETE', filledQty: 10, pendingQty: 0, avgPrice: 2948.25 }));
  });

  it('updates the order, drives the proposal to filled and audits the fill', async () => {
    const summary = await h.service.reconcileUser('u1');
    expect(summary).toEqual({ checked: 1, updated: 1, errors: 0 });

    expect(await h.orders.get('ord_0001')).toMatchObject({
      status: 'COMPLETE',
      filledQty: 10,
      avgFillPrice: 2948.25,
    });
    expect(h.proposals.statusOf('p1')).toBe('filled');
    expect(h.auditLog.types()).toEqual(['order.filled']);
  });

  it('rewrites the provisional ledger entry with the real fill', async () => {
    await h.service.reconcileUser('u1');

    const entries = await h.ledger.list('u1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'led_ord_0001', qty: 10, price: 2948.25 });
  });

  it('recomputes the book deployment from the ledger', async () => {
    await h.service.reconcileUser('u1');
    expect(h.books.docs.get('u1:long_term')?.deployedInr).toBeCloseTo(29_482.5, 6);
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

  it('removes the provisional ledger entry and releases the sleeve', async () => {
    await h.service.reconcileUser('u1');

    expect(await h.ledger.list('u1')).toHaveLength(0);
    expect(h.books.docs.get('u1:long_term')?.deployedInr).toBe(0);
  });
});

describe('cancellation', () => {
  it('treats a cancel with no fill like a reject', async () => {
    h = harness(status({ status: 'CANCELLED' }));
    await h.service.reconcileUser('u1');

    expect(h.proposals.statusOf('p1')).toBe('rejected');
    expect(await h.ledger.list('u1')).toHaveLength(0);
  });

  it('keeps the filled part of a partially-filled cancel', async () => {
    h = harness(status({ status: 'CANCELLED', filledQty: 4, avgPrice: 2949 }));
    await h.service.reconcileUser('u1');

    const entries = await h.ledger.list('u1');
    expect(entries[0]).toMatchObject({ qty: 4, price: 2949 });
    expect(h.books.docs.get('u1:long_term')?.deployedInr).toBeCloseTo(11_796, 6);
  });
});

describe('partial fills', () => {
  beforeEach(() => {
    h = harness(status({ status: 'PARTIAL', filledQty: 4, pendingQty: 6, avgPrice: 2949 }));
  });

  it('records the filled quantity but leaves the proposal placed', async () => {
    await h.service.reconcileUser('u1');

    expect(await h.orders.get('ord_0001')).toMatchObject({ status: 'PARTIAL', filledQty: 4 });
    expect(h.proposals.statusOf('p1')).toBe('placed');
    expect(h.auditLog.events).toHaveLength(0);
  });

  it('attributes only the filled quantity to the ledger', async () => {
    await h.service.reconcileUser('u1');
    expect((await h.ledger.list('u1'))[0]).toMatchObject({ qty: 4, price: 2949 });
  });
});

describe('statuses that are not news', () => {
  it('leaves an UNKNOWN status alone', async () => {
    h = harness(status({ status: 'UNKNOWN' }));
    const summary = await h.service.reconcileUser('u1');

    expect(summary).toEqual({ checked: 1, updated: 0, errors: 0 });
    expect(await h.orders.get('ord_0001')).toMatchObject({ status: 'SUBMITTED' });
    expect(h.proposals.statusOf('p1')).toBe('placed');
    expect(h.auditLog.events).toHaveLength(0);
  });

  it('leaves a still-open order alone', async () => {
    h = harness(status({ status: 'OPEN' }));
    expect(await h.service.reconcileUser('u1')).toEqual({ checked: 1, updated: 0, errors: 0 });
  });

  it('is idempotent — a second pass over a terminal order changes nothing', async () => {
    h = harness(status({ status: 'COMPLETE', filledQty: 10, avgPrice: 2948.25 }));
    await h.service.reconcileUser('u1');
    h.auditLog.events.length = 0;

    // The order is no longer "open", so it is not even re-polled.
    expect(await h.service.reconcileUser('u1')).toEqual({ checked: 0, updated: 0, errors: 0 });
    expect(h.auditLog.events).toHaveLength(0);
  });
});

describe('failures', () => {
  it('counts a broker error without touching any state', async () => {
    h = harness(status({}));
    h.adapter.script.throwOn = { getOrder: new BrokerError('NETWORK', 'timeout') };

    expect(await h.service.reconcileUser('u1')).toEqual({ checked: 1, updated: 0, errors: 1 });
    expect(await h.orders.get('ord_0001')).toMatchObject({ status: 'SUBMITTED' });
  });

  it('skips an order that never reached the broker', async () => {
    h = harness(status({}));
    await h.orders.patch('ord_0001', { brokerOrderId: null });

    expect(await h.service.reconcileUser('u1')).toEqual({ checked: 1, updated: 0, errors: 0 });
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
});

describe('deployedFromLedger', () => {
  it('sums the open cost basis of one book only', () => {
    const entries = [
      makeLedgerEntry({ bookId: 'long_term', qty: 10, price: 100 }),
      makeLedgerEntry({ bookId: 'swing', qty: 5, price: 200 }),
    ];
    expect(deployedFromLedger(entries, 'long_term')).toBe(1_000);
    expect(deployedFromLedger(entries, 'swing')).toBe(1_000);
    expect(deployedFromLedger(entries, 'scalp')).toBe(0);
  });

  it('ignores positions the book has closed out', () => {
    const entries = [
      makeLedgerEntry({ bookId: 'long_term', side: 'BUY', qty: 10, price: 100 }),
      makeLedgerEntry({ bookId: 'long_term', side: 'SELL', qty: 10, price: 110 }),
    ];
    expect(deployedFromLedger(entries, 'long_term')).toBe(0);
  });
});
