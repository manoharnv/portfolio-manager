/**
 * Thin Firestore repositories — map + query only, no business logic.
 *
 * Reads are validated by `mappers.ts`; the only writes anywhere in this package
 * are `proposals/{id}` and `auditLog/{id}` (docs/05 §5.1).
 */

import type { Broker, TodayAggregates } from '@pm/core';
import type {
  AggregatesSource,
  AuditLog,
  BookRepo,
  ConfigRepo,
  LedgerRepo,
  PortfolioSource,
  ProposalRepo,
  SessionStatusSource,
  StrategyDefsRepo,
} from '../../ports/index.js';
import {
  AUDIT_LOG_COLLECTION,
  CONFIG_COLLECTION,
  FUNDS_DOC_ID,
  OPEN_PROPOSAL_STATUSES,
  PROPOSALS_COLLECTION,
  booksPath,
  brokerSessionsPath,
  fundsPath,
  holdingsPath,
  istDayBounds,
  ledgerEntriesPath,
  positionsPath,
  strategyDefsPath,
} from './paths.js';
import {
  fromAuditEvent,
  fromProposal,
  toBook,
  toConfig,
  toFunds,
  toHolding,
  toLedgerEntry,
  toPosition,
  toProposal,
  toSessionStatus,
  toStrategyDef,
} from './mappers.js';
import type { DocSnapshotLike, FirestoreLike } from './types.js';

function payload(snap: DocSnapshotLike): Record<string, unknown> | undefined {
  if (!snap.exists) return undefined;
  return snap.data();
}

export function createFirestoreConfigRepo(db: FirestoreLike): ConfigRepo {
  return {
    async get(uid) {
      const data = payload(await db.collection(CONFIG_COLLECTION).doc(uid).get());
      if (data === undefined) return undefined;
      // The doc id is the uid; a doc that omits the field is still valid.
      return toConfig({ uid, ...data });
    },
  };
}

export function createFirestoreStrategyDefsRepo(db: FirestoreLike): StrategyDefsRepo {
  return {
    async listEnabled(uid) {
      const snap = await db.collection(strategyDefsPath(uid)).where('enabled', '==', true).get();
      return snap.docs.map((d) => toStrategyDef(d.id, d.data() ?? {}));
    },
  };
}

export function createFirestoreProposalRepo(db: FirestoreLike): ProposalRepo {
  return {
    async listOpen(uid) {
      const snap = await db
        .collection(PROPOSALS_COLLECTION)
        .where('uid', '==', uid)
        .where('status', 'in', [...OPEN_PROPOSAL_STATUSES])
        .get();
      return snap.docs.map((d) => toProposal(d.data() ?? {}));
    },
    async create(proposal) {
      await db.collection(PROPOSALS_COLLECTION).doc(proposal.id).set(fromProposal(proposal));
    },
  };
}

export function createFirestoreAuditLog(db: FirestoreLike): AuditLog {
  return {
    async append(event) {
      await db.collection(AUDIT_LOG_COLLECTION).doc(event.id).set(fromAuditEvent(event));
    },
  };
}

export function createFirestoreLedgerRepo(db: FirestoreLike): LedgerRepo {
  return {
    async listEntries(uid) {
      const snap = await db.collection(ledgerEntriesPath(uid)).get();
      return snap.docs.map((d) => toLedgerEntry(d.data() ?? {}));
    },
  };
}

export function createFirestoreBookRepo(db: FirestoreLike): BookRepo {
  return {
    async listBooks(uid) {
      const snap = await db.collection(booksPath(uid)).get();
      return snap.docs.map((d) => toBook(d.data() ?? {}));
    },
  };
}

export function createFirestoreSessionSource(db: FirestoreLike): SessionStatusSource {
  return {
    async status(uid: string, broker: Broker) {
      const data = payload(await db.collection(brokerSessionsPath(uid)).doc(broker).get());
      if (data === undefined) return undefined;
      return toSessionStatus({ broker, ...data });
    },
  };
}

/** The cached portfolio read model (docs/03 §3.6), as an alternative to the broker. */
export function createFirestorePortfolioSource(db: FirestoreLike): PortfolioSource {
  return {
    async snapshot(uid) {
      const [holdingDocs, positionDocs, fundsDoc] = await Promise.all([
        db.collection(holdingsPath(uid)).get(),
        db.collection(positionsPath(uid)).get(),
        db.collection(fundsPath(uid)).doc(FUNDS_DOC_ID).get(),
      ]);
      const funds = payload(fundsDoc);
      if (funds === undefined) {
        throw new Error(`No cached funds for uid '${uid}' — refusing to size orders blind`);
      }
      return {
        holdings: holdingDocs.docs.map((d) => toHolding(d.data() ?? {})),
        positions: positionDocs.docs.map((d) => toPosition(d.data() ?? {})),
        funds: toFunds(funds),
      };
    },
  };
}

/**
 * Today's order count + notional, summed from the audit log. Needs a composite
 * index on `auditLog` over `(uid, type, ts)` — see the VERIFY-LIVE notes.
 */
export function createFirestoreAggregatesSource(db: FirestoreLike): AggregatesSource {
  return {
    async today(uid, istDateKey): Promise<TodayAggregates> {
      const { from, to } = istDayBounds(istDateKey);
      const snap = await db
        .collection(AUDIT_LOG_COLLECTION)
        .where('uid', '==', uid)
        .where('type', '==', 'order.submitted')
        .where('ts', '>=', from)
        .where('ts', '<=', to)
        .get();

      let notionalInr = 0;
      for (const doc of snap.docs) {
        const detail = doc.data()?.['detail'];
        const value =
          typeof detail === 'object' && detail !== null
            ? (detail as Record<string, unknown>)['notionalInr']
            : undefined;
        if (typeof value === 'number' && Number.isFinite(value)) notionalInr += value;
      }
      return { orderCount: snap.docs.length, notionalInr };
    },
  };
}
