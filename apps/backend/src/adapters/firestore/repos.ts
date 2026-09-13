/**
 * Firestore implementations of the ports — docs/03.
 *
 * Deliberately dumb: read, validate, write. Every decision lives in
 * `services/`; what is here is document paths, queries, and the two
 * transactions the exactly-once guarantee depends on (the idempotency lock and
 * the proposal compare-and-set).
 */

import {
  BookSchema,
  BrokerSessionSchema,
  ConfigSchema,
  FundsDocSchema,
  HoldingDocSchema,
  IdempotencyRecordSchema,
  LedgerEntrySchema,
  OrderRecordSchema,
  PositionDocSchema,
  ProposalSchema,
} from '@pm/core';
import type {
  AuditEvent,
  Book,
  BookId,
  Broker,
  BrokerSession,
  Config,
  IdempotencyRecord,
  LedgerEntry,
  OrderRecord,
  Proposal,
  ProposalStatus,
} from '@pm/core';
import type {
  AuditLog,
  BookRepo,
  ConfigRepo,
  IdempotencyStore,
  LedgerRepo,
  OrderRepo,
  PortfolioCache,
  PortfolioSnapshot,
  ProposalRepo,
  ProposalTransitionPatch,
  ProposalTransitionResult,
  SessionStore,
} from '../../ports/index.js';
import { stripUndefined, type FsDb } from './db.js';
import {
  bookPath,
  decodeAll,
  decodeDoc,
  fundsPath,
  ledgerCollection,
  portfolioCollection,
  portfolioDocId,
  sessionPath,
} from './mappers.js';

const OPEN_ORDER_STATUSES = ['SUBMITTED', 'OPEN', 'PARTIAL', 'UNKNOWN'];

const asData = (value: unknown): Record<string, unknown> =>
  stripUndefined(value as Record<string, unknown>);

// ---------------------------------------------------------------------------
// proposals/{id}
// ---------------------------------------------------------------------------

export function createProposalRepo(db: FsDb): ProposalRepo {
  const ref = (id: string): ReturnType<FsDb['doc']> => db.doc(`proposals/${id}`);

  return {
    async get(id: string): Promise<Proposal | undefined> {
      return decodeDoc('proposals', await ref(id).get(), ProposalSchema);
    },

    /**
     * Compare-and-set inside a transaction: the read of the document is what
     * makes Firestore re-run the transaction if someone else moved the proposal
     * first, which is what stops two taps from both reaching `placing`.
     */
    async transition(
      id: string,
      from: ProposalStatus,
      to: ProposalStatus,
      patch?: ProposalTransitionPatch,
    ): Promise<ProposalTransitionResult> {
      return db.runTransaction(async (txn) => {
        const docRef = ref(id);
        const snap = await txn.get(docRef);
        const current = decodeDoc('proposals', snap, ProposalSchema);
        if (current === undefined) return { ok: false, reason: 'not-found' };
        if (current.status !== from) {
          return { ok: false, reason: 'conflict', current: current.status };
        }
        const next: Proposal = {
          ...current,
          status: to,
          ...stripUndefined({ ...patch } as Record<string, unknown>),
        };
        txn.set(docRef, asData(next));
        return { ok: true, proposal: next };
      });
    },

    async listByStatus(uid: string, statuses: readonly ProposalStatus[]): Promise<Proposal[]> {
      if (statuses.length === 0) return [];
      const snap = await db
        .collection('proposals')
        .where('uid', '==', uid)
        .where('status', 'in', [...statuses])
        .get();
      return decodeAll('proposals', snap.docs, ProposalSchema);
    },
  };
}

// ---------------------------------------------------------------------------
// orders/{id}
// ---------------------------------------------------------------------------

export function createOrderRepo(db: FsDb): OrderRepo {
  const ref = (id: string): ReturnType<FsDb['doc']> => db.doc(`orders/${id}`);

  return {
    async create(record: OrderRecord): Promise<void> {
      await ref(record.id).set(asData(record));
    },

    async get(id: string): Promise<OrderRecord | undefined> {
      return decodeDoc('orders', await ref(id).get(), OrderRecordSchema);
    },

    async patch(id: string, patch: Partial<OrderRecord>): Promise<void> {
      await ref(id).set(asData(patch), { merge: true });
    },

    async listOpen(uid: string): Promise<OrderRecord[]> {
      const snap = await db
        .collection('orders')
        .where('uid', '==', uid)
        .where('status', 'in', OPEN_ORDER_STATUSES)
        .get();
      return decodeAll('orders', snap.docs, OrderRecordSchema);
    },

    async findByProposal(uid: string, proposalId: string): Promise<OrderRecord | undefined> {
      const snap = await db
        .collection('orders')
        .where('uid', '==', uid)
        .where('proposalId', '==', proposalId)
        .limit(1)
        .get();
      return decodeAll('orders', snap.docs, OrderRecordSchema)[0];
    },

    async listApprovedBetween(uid: string, fromIso: string, toIso: string): Promise<OrderRecord[]> {
      const snap = await db
        .collection('orders')
        .where('uid', '==', uid)
        .where('approvedAt', '>=', fromIso)
        .where('approvedAt', '<', toIso)
        .get();
      return decodeAll('orders', snap.docs, OrderRecordSchema);
    },
  };
}

// ---------------------------------------------------------------------------
// idempotency/{key}
// ---------------------------------------------------------------------------

export function createIdempotencyStore(db: FsDb): IdempotencyStore {
  const ref = (key: string): ReturnType<FsDb['doc']> => db.doc(`idempotency/${key}`);

  return {
    /** The lock (docs/04 §4.4): read-then-create inside one transaction. */
    async acquire(
      key: string,
      proposalId: string,
      now: Date,
    ): Promise<'acquired' | IdempotencyRecord> {
      return db.runTransaction(async (txn) => {
        const docRef = ref(key);
        const existing = decodeDoc('idempotency', await txn.get(docRef), IdempotencyRecordSchema);
        if (existing !== undefined) return existing;
        const record: IdempotencyRecord = {
          key,
          proposalId,
          orderId: null,
          status: 'in-progress',
          createdAt: now.toISOString(),
          result: null,
        };
        txn.set(docRef, asData(record));
        return 'acquired';
      });
    },

    async complete(key: string, orderId: string, result: unknown): Promise<void> {
      await ref(key).set({ status: 'done', orderId, result }, { merge: true });
    },

    async fail(key: string, result: unknown): Promise<void> {
      await ref(key).set({ status: 'failed', result }, { merge: true });
    },

    async get(key: string): Promise<IdempotencyRecord | undefined> {
      return decodeDoc('idempotency', await ref(key).get(), IdempotencyRecordSchema);
    },
  };
}

// ---------------------------------------------------------------------------
// config/{uid}
// ---------------------------------------------------------------------------

export function createConfigRepo(db: FsDb): ConfigRepo {
  const ref = (uid: string): ReturnType<FsDb['doc']> => db.doc(`config/${uid}`);

  return {
    async get(uid: string): Promise<Config | undefined> {
      return decodeDoc('config', await ref(uid).get(), ConfigSchema);
    },

    /**
     * Never *creates* a config: a merge-write onto a missing document would
     * invent a half-formed control panel, and a config the backend cannot read
     * in full must keep meaning "refuse everything" (docs/07 §7.8).
     */
    async patch(uid: string, patch: Partial<Config>): Promise<Config> {
      const before = decodeDoc('config', await ref(uid).get(), ConfigSchema);
      if (before === undefined)
        throw new Error(`config/${uid} does not exist — refusing to create`);
      await ref(uid).set(asData(patch), { merge: true });
      const updated = decodeDoc('config', await ref(uid).get(), ConfigSchema);
      if (updated === undefined) throw new Error(`config/${uid} disappeared during patch`);
      return updated;
    },
  };
}

// ---------------------------------------------------------------------------
// auditLog/{eventId} — append only
// ---------------------------------------------------------------------------

export function createAuditLog(db: FsDb): AuditLog {
  return {
    async append(event: AuditEvent): Promise<void> {
      await db.doc(`auditLog/${event.id}`).set(asData(event));
    },
  };
}

// ---------------------------------------------------------------------------
// brokerSessions/{uid}/brokers/{broker}
// ---------------------------------------------------------------------------

export function createSessionStore(db: FsDb): SessionStore {
  return {
    async get(uid: string, broker: Broker): Promise<BrokerSession | undefined> {
      return decodeDoc(
        'brokerSessions',
        await db.doc(sessionPath(uid, broker)).get(),
        BrokerSessionSchema,
      );
    },

    async set(uid: string, session: BrokerSession): Promise<void> {
      await db.doc(sessionPath(uid, session.broker)).set(asData(session));
    },
  };
}

// ---------------------------------------------------------------------------
// portfolio/{uid}/...
// ---------------------------------------------------------------------------

export function createPortfolioCache(db: FsDb): PortfolioCache {
  return {
    async write(uid: string, snapshot: PortfolioSnapshot, now: Date): Promise<void> {
      const updatedAt = now.toISOString();
      for (const holding of snapshot.holdings) {
        const doc = HoldingDocSchema.parse({
          ...holding,
          symbolKey: portfolioDocId(holding.symbol),
          updatedAt,
        });
        await db
          .collection(portfolioCollection(uid, 'holdings'))
          .doc(doc.symbolKey)
          .set(asData(doc));
      }
      for (const position of snapshot.positions) {
        const doc = PositionDocSchema.parse({
          ...position,
          symbolKey: portfolioDocId(position.symbol),
          updatedAt,
        });
        await db
          .collection(portfolioCollection(uid, 'positions'))
          .doc(doc.symbolKey)
          .set(asData(doc));
      }
      const funds = FundsDocSchema.parse({ ...snapshot.funds, updatedAt });
      await db.doc(fundsPath(uid)).set(asData(funds));
    },
  };
}

// ---------------------------------------------------------------------------
// ledger/{uid}/entries/{entryId}
// ---------------------------------------------------------------------------

export function createLedgerRepo(db: FsDb): LedgerRepo {
  return {
    async append(entry: LedgerEntry): Promise<void> {
      await db.collection(ledgerCollection(entry.uid)).doc(entry.id).set(asData(entry));
    },

    async remove(uid: string, entryId: string): Promise<void> {
      await db.collection(ledgerCollection(uid)).doc(entryId).delete();
    },

    async list(uid: string): Promise<LedgerEntry[]> {
      const snap = await db.collection(ledgerCollection(uid)).get();
      return decodeAll('ledger', snap.docs, LedgerEntrySchema);
    },
  };
}

// ---------------------------------------------------------------------------
// books/{uid}/books/{bookId}
// ---------------------------------------------------------------------------

export function createBookRepo(db: FsDb): BookRepo {
  return {
    async get(uid: string, bookId: BookId): Promise<Book | undefined> {
      return decodeDoc('books', await db.doc(bookPath(uid, bookId)).get(), BookSchema);
    },

    async patch(uid: string, bookId: BookId, patch: Partial<Book>): Promise<void> {
      await db.doc(bookPath(uid, bookId)).set(asData(patch), { merge: true });
    },
  };
}
