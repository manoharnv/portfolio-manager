/**
 * The Firestore repos, exercised against an in-memory {@link FakeFirestore}.
 *
 * The point of these tests is not to re-test the Admin SDK — it is to pin the
 * two transactional behaviours the exactly-once guarantee rests on, and to prove
 * every document is re-validated on the way out.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  createAuditLog,
  createBookRepo,
  createConfigRepo,
  createIdempotencyStore,
  createLedgerRepo,
  createOrderRepo,
  createPortfolioCache,
  createProposalRepo,
  createSessionStore,
} from './repos.js';
import { DocumentShapeError } from './mappers.js';
import { FakeFirestore } from '../../test-utils/fake-firestore.js';
import {
  INFY,
  makeAuditEvent,
  makeBook,
  makeBrokerSession,
  makeConfig,
  makeFunds,
  makeHolding,
  makeLedgerEntry,
  makeOrderRecord,
  makePosition,
  makeProposal,
} from '../../test-utils/fixtures.js';

const NOW = new Date('2026-01-13T04:30:00.000Z');

let db: FakeFirestore;
beforeEach(() => {
  db = new FakeFirestore();
});

describe('proposal repo', () => {
  it('reads and validates a proposal', async () => {
    db.seed('proposals/p1', makeProposal());
    expect((await createProposalRepo(db).get('p1'))?.id).toBe('p1');
  });

  it('returns undefined for a missing proposal', async () => {
    expect(await createProposalRepo(db).get('nope')).toBeUndefined();
  });

  it('rejects a malformed proposal rather than trading on it', async () => {
    db.seed('proposals/p1', { id: 'p1', uid: 'u1' });
    await expect(createProposalRepo(db).get('p1')).rejects.toBeInstanceOf(DocumentShapeError);
  });

  it('applies a transition inside a transaction and merges the patch', async () => {
    db.seed('proposals/p1', makeProposal());
    const repo = createProposalRepo(db);

    const result = await repo.transition('p1', 'pending', 'approved', {
      decidedBy: 'u1',
      decidedAt: '2026-01-13T04:30:00.000Z',
    });

    expect(result).toMatchObject({ ok: true });
    expect(db.transactions).toBe(1);
    expect(db.docs.get('proposals/p1')).toMatchObject({
      status: 'approved',
      decidedBy: 'u1',
    });
  });

  it('drops undefined patch fields instead of writing them', async () => {
    db.seed('proposals/p1', makeProposal());
    await createProposalRepo(db).transition('p1', 'pending', 'approved', {
      decidedBy: 'u1',
      orderId: undefined,
    });
    expect('orderId' in (db.docs.get('proposals/p1') ?? {})).toBe(false);
  });

  it('refuses a transition when the stored status moved on', async () => {
    db.seed('proposals/p1', makeProposal({ status: 'placed' }));
    expect(await createProposalRepo(db).transition('p1', 'pending', 'approved')).toEqual({
      ok: false,
      reason: 'conflict',
      current: 'placed',
    });
    expect(db.docs.get('proposals/p1')).toMatchObject({ status: 'placed' });
  });

  it('reports a missing proposal', async () => {
    expect(await createProposalRepo(db).transition('p1', 'pending', 'approved')).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('lists only this user’s pending proposals', async () => {
    db.seed('proposals/p1', makeProposal());
    db.seed('proposals/p2', makeProposal({ id: 'p2', status: 'placed' }));
    db.seed('proposals/p3', makeProposal({ id: 'p3', uid: 'other' }));

    const listed = await createProposalRepo(db).listPending('u1');
    expect(listed.map((p) => p.id)).toEqual(['p1']);
  });
});

describe('order repo', () => {
  it('creates, reads and patches an order', async () => {
    const repo = createOrderRepo(db);
    await repo.create(makeOrderRecord());
    expect((await repo.get('ord_0001'))?.status).toBe('SUBMITTED');

    await repo.patch('ord_0001', { status: 'COMPLETE', filledQty: 10, avgFillPrice: 2949 });
    expect(await repo.get('ord_0001')).toMatchObject({ status: 'COMPLETE', filledQty: 10 });
    // A patch must merge, never replace.
    expect((await repo.get('ord_0001'))?.proposalId).toBe('p1');
  });

  it('lists only open orders for the user', async () => {
    const repo = createOrderRepo(db);
    await repo.create(makeOrderRecord({ id: 'a', status: 'OPEN' }));
    await repo.create(makeOrderRecord({ id: 'b', status: 'COMPLETE' }));
    await repo.create(makeOrderRecord({ id: 'c', status: 'OPEN', uid: 'other' }));

    expect((await repo.listOpen('u1')).map((o) => o.id)).toEqual(['a']);
  });

  it('lists orders approved inside a half-open window', async () => {
    const repo = createOrderRepo(db);
    await repo.create(makeOrderRecord({ id: 'a', approvedAt: '2026-01-13T04:00:00.000Z' }));
    await repo.create(makeOrderRecord({ id: 'b', approvedAt: '2026-01-12T18:30:00.000Z' }));
    await repo.create(makeOrderRecord({ id: 'c', approvedAt: '2026-01-13T18:30:00.000Z' }));

    const listed = await repo.listApprovedBetween(
      'u1',
      '2026-01-12T18:30:00.000Z',
      '2026-01-13T18:30:00.000Z',
    );
    expect(listed.map((o) => o.id).sort()).toEqual(['a', 'b']);
  });
});

describe('idempotency store', () => {
  it('acquires an unused key transactionally', async () => {
    const store = createIdempotencyStore(db);
    expect(await store.acquire('k1', 'p1', NOW)).toBe('acquired');
    expect(db.transactions).toBe(1);
    expect(db.docs.get('idempotency/k1')).toMatchObject({
      key: 'k1',
      proposalId: 'p1',
      status: 'in-progress',
      orderId: null,
    });
  });

  it('returns the existing record on a second acquire', async () => {
    const store = createIdempotencyStore(db);
    await store.acquire('k1', 'p1', NOW);
    const second = await store.acquire('k1', 'p1', NOW);

    expect(second).not.toBe('acquired');
    expect(second).toMatchObject({ key: 'k1', status: 'in-progress' });
  });

  it('records completion and failure without losing the original fields', async () => {
    const store = createIdempotencyStore(db);
    await store.acquire('k1', 'p1', NOW);

    await store.complete('k1', 'ord_1', { ok: true });
    expect(await store.get('k1')).toMatchObject({
      status: 'done',
      orderId: 'ord_1',
      proposalId: 'p1',
    });

    await store.fail('k1', { ok: false });
    expect((await store.get('k1'))?.status).toBe('failed');
  });

  it('returns undefined for an unknown key', async () => {
    expect(await createIdempotencyStore(db).get('nope')).toBeUndefined();
  });
});

describe('config repo', () => {
  it('reads and patches a config', async () => {
    db.seed('config/u1', makeConfig());
    const repo = createConfigRepo(db);

    const updated = await repo.patch('u1', { killSwitch: true });
    expect(updated.killSwitch).toBe(true);
    expect(updated.activeBroker).toBe('dhan');
  });

  it('returns undefined when there is no config (fail closed upstream)', async () => {
    expect(await createConfigRepo(db).get('u1')).toBeUndefined();
  });

  it('refuses to create a config it was only asked to patch', async () => {
    const repo = createConfigRepo(db);
    await expect(repo.patch('u1', { killSwitch: true })).rejects.toThrow(/refusing to create/);
    expect(db.docs.has('config/u1')).toBe(false);
  });
});

describe('audit log', () => {
  it('writes an event at its own id', async () => {
    await createAuditLog(db).append(makeAuditEvent());
    expect(db.docs.get('auditLog/aud_0001')).toMatchObject({ type: 'order.submitted' });
  });

  it('omits undefined optional fields', async () => {
    await createAuditLog(db).append(makeAuditEvent());
    expect('refId' in (db.docs.get('auditLog/aud_0001') ?? {})).toBe(false);
  });
});

describe('session store', () => {
  it('round-trips non-secret session metadata', async () => {
    const store = createSessionStore(db);
    await store.set('u1', makeBrokerSession());

    expect(db.docs.has('brokerSessions/u1/brokers/dhan')).toBe(true);
    expect(await store.get('u1', 'dhan')).toMatchObject({ connected: true });
    expect(await store.get('u1', 'kite')).toBeUndefined();
  });

  it('never stores a token', async () => {
    await createSessionStore(db).set('u1', makeBrokerSession());
    const raw = JSON.stringify(db.docs.get('brokerSessions/u1/brokers/dhan'));
    expect(raw).not.toMatch(/token|secret/i);
  });
});

describe('portfolio cache', () => {
  it('writes holdings, positions and funds under stable ids', async () => {
    await createPortfolioCache(db).write(
      'u1',
      {
        holdings: [makeHolding(), makeHolding({ symbol: INFY })],
        positions: [makePosition()],
        funds: makeFunds(),
      },
      NOW,
    );

    expect(db.docs.has('portfolio/u1/holdings/NSE:EQ:RELIANCE')).toBe(true);
    expect(db.docs.has('portfolio/u1/holdings/NSE:EQ:INFY')).toBe(true);
    expect(db.docs.has('portfolio/u1/positions/NSE:EQ:RELIANCE')).toBe(true);
    expect(db.docs.get('portfolio/u1/funds/current')).toMatchObject({
      availableMargin: 500_000,
      updatedAt: NOW.toISOString(),
    });
  });
});

describe('ledger repo', () => {
  it('upserts by entry id so a correction overwrites the provisional row', async () => {
    const repo = createLedgerRepo(db);
    await repo.append(makeLedgerEntry({ id: 'led_1', qty: 10, price: 100 }));
    await repo.append(makeLedgerEntry({ id: 'led_1', qty: 4, price: 101 }));

    const entries = await repo.list('u1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ qty: 4, price: 101 });
  });

  it('removes an entry and scopes the listing to the user', async () => {
    const repo = createLedgerRepo(db);
    await repo.append(makeLedgerEntry({ id: 'led_1' }));
    await repo.append(makeLedgerEntry({ id: 'led_2', uid: 'other' }));

    expect(await repo.list('u1')).toHaveLength(1);
    await repo.remove('u1', 'led_1');
    expect(await repo.list('u1')).toHaveLength(0);
    expect(db.deletes).toEqual(['ledger/u1/entries/led_1']);
  });
});

describe('book repo', () => {
  it('reads and patches a book', async () => {
    db.seed('books/u1/books/long_term', makeBook());
    const repo = createBookRepo(db);

    await repo.patch('u1', 'long_term', { deployedInr: 1_234 });
    expect(await repo.get('u1', 'long_term')).toMatchObject({
      deployedInr: 1_234,
      allocationPct: 50,
    });
  });

  it('returns undefined for a book that does not exist', async () => {
    expect(await createBookRepo(db).get('u1', 'scalp')).toBeUndefined();
  });
});
