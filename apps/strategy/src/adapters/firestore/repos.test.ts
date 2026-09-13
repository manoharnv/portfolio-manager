import { describe, expect, it } from 'vitest';
import { symbolKey } from '@pm/core';
import {
  createFirestoreAggregatesSource,
  createFirestoreAuditLog,
  createFirestoreBookRepo,
  createFirestoreConfigRepo,
  createFirestoreLedgerRepo,
  createFirestorePortfolioSource,
  createFirestoreProposalRepo,
  createFirestoreSessionSource,
  createFirestoreStrategyDefsRepo,
} from './repos.js';
import { OPEN_PROPOSAL_STATUSES, istDayBounds } from './paths.js';
import type {
  CollectionLike,
  DocRefLike,
  DocSnapshotLike,
  FirestoreLike,
  QueryLike,
  QuerySnapshotLike,
} from './types.js';
import {
  IST_DATE,
  NOW_IST_1000,
  RELIANCE,
  TEST_UID,
  makeAuditEvent,
  makeBook,
  makeConfig,
  makeLedgerEntry,
  makeProposal,
} from '../../test-utils/index.js';

// ---------------------------------------------------------------------------
// An in-memory Firestore double — enough of the query surface for these repos.
// ---------------------------------------------------------------------------

interface FakeDoc {
  id: string;
  data: Record<string, unknown>;
}

interface Write {
  path: string;
  id: string;
  data: Record<string, unknown>;
}

function matches(doc: FakeDoc, field: string, op: string, value: unknown): boolean {
  const actual = doc.data[field];
  switch (op) {
    case '==':
      return actual === value;
    case 'in':
      return Array.isArray(value) && value.includes(actual);
    case '>=':
      return typeof actual === 'string' && typeof value === 'string' && actual >= value;
    case '<=':
      return typeof actual === 'string' && typeof value === 'string' && actual <= value;
    default:
      throw new Error(`fake Firestore does not implement operator '${op}'`);
  }
}

function fakeFirestore(seed: Record<string, FakeDoc[]> = {}): {
  db: FirestoreLike;
  writes: Write[];
  queries: string[];
} {
  const writes: Write[] = [];
  const queries: string[] = [];

  const makeQuery = (path: string, docs: FakeDoc[]): QueryLike => ({
    where: (field, op, value): QueryLike => {
      queries.push(`${path} ${field} ${op}`);
      return makeQuery(
        path,
        docs.filter((d) => matches(d, field, op, value)),
      );
    },
    get: (): Promise<QuerySnapshotLike> =>
      Promise.resolve({
        docs: docs.map((d): DocSnapshotLike => ({
          id: d.id,
          exists: true,
          data: () => d.data,
        })),
      }),
  });

  const collection = (path: string): CollectionLike => {
    const docs = seed[path] ?? [];
    const query = makeQuery(path, docs);
    return {
      where: query.where,
      get: query.get,
      doc: (id: string): DocRefLike => ({
        get: (): Promise<DocSnapshotLike> => {
          const found = docs.find((d) => d.id === id);
          return Promise.resolve({
            id,
            exists: found !== undefined,
            data: () => found?.data,
          });
        },
        set: (data: Record<string, unknown>): Promise<unknown> => {
          writes.push({ path, id, data });
          return Promise.resolve(undefined);
        },
      }),
    };
  };

  return { db: { collection }, writes, queries };
}

const doc = (id: string, data: object): FakeDoc => ({ id, data: { ...data } });

// ---------------------------------------------------------------------------

describe('createFirestoreConfigRepo', () => {
  it('reads config/{uid} and fills the uid from the doc id', async () => {
    const { uid: _uid, ...body } = makeConfig();
    const { db } = fakeFirestore({ config: [doc(TEST_UID, body)] });
    expect(await createFirestoreConfigRepo(db).get(TEST_UID)).toEqual(makeConfig());
  });

  it('returns undefined when there is no config document', async () => {
    const { db } = fakeFirestore();
    expect(await createFirestoreConfigRepo(db).get(TEST_UID)).toBeUndefined();
  });
});

describe('createFirestoreStrategyDefsRepo', () => {
  it('queries only enabled defs and takes the id from the path', async () => {
    const { db, queries } = fakeFirestore({
      [`strategies/${TEST_UID}/defs`]: [
        doc('dca', { bookId: 'long_term', horizon: 'long_term', enabled: true, params: {} }),
        doc('rebalance_drift', {
          bookId: 'long_term',
          horizon: 'long_term',
          enabled: false,
          params: {},
        }),
      ],
    });
    const defs = await createFirestoreStrategyDefsRepo(db).listEnabled(TEST_UID);
    expect(defs.map((d) => d.id)).toEqual(['dca']);
    expect(queries).toContain(`strategies/${TEST_UID}/defs enabled ==`);
  });
});

describe('createFirestoreProposalRepo', () => {
  it('lists only this user’s still-open proposals', async () => {
    const { db, queries } = fakeFirestore({
      proposals: [
        doc('p1', makeProposal({ id: 'p1', status: 'pending' })),
        doc('p2', makeProposal({ id: 'p2', status: 'rejected' })),
        doc('p3', { ...makeProposal({ id: 'p3' }), uid: 'someone-else' }),
      ],
    });
    const open = await createFirestoreProposalRepo(db).listOpen(TEST_UID);
    expect(open.map((p) => p.id)).toEqual(['p1']);
    expect(queries).toEqual(['proposals uid ==', 'proposals status in']);
  });

  it('writes the proposal at its own id, validated', async () => {
    const { db, writes } = fakeFirestore();
    await createFirestoreProposalRepo(db).create(makeProposal({ id: 'p9' }));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: 'proposals', id: 'p9' });
    expect(writes[0]?.data['status']).toBe('pending');
  });

  it('treats every non-terminal status as open', () => {
    expect([...OPEN_PROPOSAL_STATUSES]).toEqual(['pending', 'approved', 'placing', 'placed']);
  });
});

describe('createFirestoreAuditLog', () => {
  it('appends at the event id', async () => {
    const { db, writes } = fakeFirestore();
    await createFirestoreAuditLog(db).append(makeAuditEvent({ id: 'a7' }));
    expect(writes[0]).toMatchObject({ path: 'auditLog', id: 'a7' });
  });
});

describe('createFirestoreLedgerRepo / BookRepo', () => {
  it('map every document in the collection', async () => {
    const entry = makeLedgerEntry();
    const { db } = fakeFirestore({
      [`ledger/${TEST_UID}/entries`]: [doc(entry.id, entry)],
      [`books/${TEST_UID}/books`]: [doc('long_term', makeBook())],
    });
    expect(await createFirestoreLedgerRepo(db).listEntries(TEST_UID)).toEqual([entry]);
    expect(await createFirestoreBookRepo(db).listBooks(TEST_UID)).toEqual([makeBook()]);
  });
});

describe('createFirestoreSessionSource', () => {
  it('reads brokerSessions/{uid}/brokers/{broker}', async () => {
    const { db } = fakeFirestore({
      [`brokerSessions/${TEST_UID}/brokers`]: [
        doc('dhan', {
          connected: true,
          expiresAt: '2026-01-13T18:30:00.000Z',
          staticIpOk: true,
          lastConnectedAt: null,
        }),
      ],
    });
    expect(await createFirestoreSessionSource(db).status(TEST_UID, 'dhan')).toEqual({
      broker: 'dhan',
      connected: true,
      expiresAt: '2026-01-13T18:30:00.000Z',
      staticIpOk: true,
    });
  });

  it('returns undefined when the broker has never connected', async () => {
    const { db } = fakeFirestore();
    expect(await createFirestoreSessionSource(db).status(TEST_UID, 'kite')).toBeUndefined();
  });
});

describe('createFirestorePortfolioSource', () => {
  const holding = {
    symbolKey: symbolKey(RELIANCE),
    updatedAt: NOW_IST_1000,
    symbol: RELIANCE,
    quantity: 10,
    avgCostPrice: 2900,
    lastPrice: 2950,
    pnl: 500,
    raw: null,
  };
  const funds = { updatedAt: NOW_IST_1000, availableCash: 1, usedMargin: 2, availableMargin: 3 };

  it('reads the cached read model', async () => {
    const { db } = fakeFirestore({
      [`portfolio/${TEST_UID}/holdings`]: [doc(symbolKey(RELIANCE), holding)],
      [`portfolio/${TEST_UID}/positions`]: [],
      [`portfolio/${TEST_UID}/funds`]: [doc('current', funds)],
    });
    const snapshot = await createFirestorePortfolioSource(db).snapshot(TEST_UID);
    expect(snapshot.holdings).toHaveLength(1);
    expect(snapshot.positions).toEqual([]);
    expect(snapshot.funds.availableMargin).toBe(3);
  });

  it('refuses to size orders with no cached funds — fail closed', async () => {
    const { db } = fakeFirestore({
      [`portfolio/${TEST_UID}/holdings`]: [],
      [`portfolio/${TEST_UID}/positions`]: [],
    });
    await expect(createFirestorePortfolioSource(db).snapshot(TEST_UID)).rejects.toThrow(
      /No cached funds/,
    );
  });
});

describe('createFirestoreAggregatesSource', () => {
  const bounds = istDayBounds(IST_DATE);

  it('counts and sums today’s submitted orders', async () => {
    const { db, queries } = fakeFirestore({
      auditLog: [
        doc('a1', {
          uid: TEST_UID,
          type: 'order.submitted',
          ts: bounds.from,
          detail: { notionalInr: 1000 },
        }),
        doc('a2', {
          uid: TEST_UID,
          type: 'order.submitted',
          ts: bounds.to,
          detail: { notionalInr: 2500.5 },
        }),
        doc('a3', { uid: TEST_UID, type: 'order.submitted', ts: bounds.to, detail: {} }),
        doc('a4', { uid: TEST_UID, type: 'proposal.created', ts: bounds.to, detail: {} }),
        doc('a5', { uid: TEST_UID, type: 'order.submitted', ts: '2026-01-12T04:00:00.000Z' }),
      ],
    });
    expect(await createFirestoreAggregatesSource(db).today(TEST_UID, IST_DATE)).toEqual({
      orderCount: 3,
      notionalInr: 3500.5,
    });
    expect(queries).toEqual([
      'auditLog uid ==',
      'auditLog type ==',
      'auditLog ts >=',
      'auditLog ts <=',
    ]);
  });

  it('is zero when nothing was submitted', async () => {
    const { db } = fakeFirestore({ auditLog: [] });
    expect(await createFirestoreAggregatesSource(db).today(TEST_UID, IST_DATE)).toEqual({
      orderCount: 0,
      notionalInr: 0,
    });
  });

  it('ignores a non-numeric or non-object detail', async () => {
    const { db } = fakeFirestore({
      auditLog: [
        doc('a1', { uid: TEST_UID, type: 'order.submitted', ts: bounds.from, detail: null }),
        doc('a2', {
          uid: TEST_UID,
          type: 'order.submitted',
          ts: bounds.from,
          detail: { notionalInr: 'lots' },
        }),
      ],
    });
    expect(await createFirestoreAggregatesSource(db).today(TEST_UID, IST_DATE)).toEqual({
      orderCount: 2,
      notionalInr: 0,
    });
  });
});

describe('istDayBounds', () => {
  it('brackets the IST calendar day', () => {
    expect(istDayBounds('2026-01-13')).toEqual({
      from: '2026-01-13T00:00:00.000+05:30',
      to: '2026-01-13T23:59:59.999+05:30',
    });
  });
});
