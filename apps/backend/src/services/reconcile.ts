/**
 * Order-status reconciliation — docs/04 §4.7 and §4.10.
 *
 * `placeOrder` returns an ack, not a fill. This is the loop that turns acks into
 * truth: poll `getOrder` for every still-open order, update `orders`, drive the
 * proposal to its terminal state, and keep the per-book ledger honest.
 *
 * Ledger rule (docs/10 §10.4): execution writes a *provisional* entry so the
 * sleeve's capital and its ownership are attributed the moment an order leaves.
 * Reconciliation is what makes that entry true — it is rewritten (same id) to
 * the quantity and price that actually **filled**, and removed entirely when
 * nothing filled. `deployedInr` is then recomputed from the ledger, which
 * docs/10 §10.3 names as its definition, so a partial fill or a reject can never
 * leave a sleeve over-committed.
 */

import { positionsByBook, symbolKey } from '@pm/core';
import type { OrderStatus, OrderStatusCode } from '@pm/core';
import type { LedgerEntry, OrderRecord, Proposal } from '@pm/core';
import type { Logger } from '../logger.js';
import type {
  BookRepo,
  BrokerGateway,
  Clock,
  IdGenerator,
  LedgerRepo,
  OrderRepo,
  ProposalRepo,
} from '../ports/index.js';
import type { AuditWriter } from './audit.js';

/** Statuses the reconciler must keep polling. */
export const OPEN_STATUSES: readonly OrderStatusCode[] = [
  'SUBMITTED',
  'OPEN',
  'PARTIAL',
  'UNKNOWN',
];

/** Statuses that end an order's life at the broker. */
export const TERMINAL_STATUSES: readonly OrderStatusCode[] = [
  'COMPLETE',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
];

export interface ReconcileDeps {
  orders: OrderRepo;
  proposals: ProposalRepo;
  ledger: LedgerRepo;
  books: BookRepo;
  broker: BrokerGateway;
  audit: AuditWriter;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
}

export interface ReconcileSummary {
  checked: number;
  updated: number;
  errors: number;
}

export type SyncResult =
  | { ok: true; order: OrderRecord; changed: boolean }
  | { ok: false; reason: 'NOT_FOUND' | 'UNAUTHORIZED' | 'BROKER_ERROR'; detail: string };

export interface ReconcileService {
  /** Poll every open order for one user. Never throws; errors are counted. */
  reconcileUser(uid: string): Promise<ReconcileSummary>;
  /** Re-sync one order from the broker (`GET /v1/orders/:id`). */
  syncOrder(uid: string, orderId: string): Promise<SyncResult>;
}

/** `deployedInr` as docs/10 §10.3 defines it: open cost basis, from the ledger. */
export function deployedFromLedger(entries: readonly LedgerEntry[], bookId: string): number {
  return positionsByBook(entries)
    .filter((p) => p.bookId === bookId && p.qty !== 0)
    .reduce((sum, p) => sum + p.costBasisInr, 0);
}

export function createReconcileService(deps: ReconcileDeps): ReconcileService {
  async function apply(record: OrderRecord, live: OrderStatus): Promise<boolean> {
    const status = live.status;
    // An UNKNOWN or still-open status is not news — leave the record alone.
    if (!TERMINAL_STATUSES.includes(status) && status !== 'PARTIAL') return false;
    if (status === record.status && live.filledQty === record.filledQty) return false;

    const nowIso = deps.clock.now().toISOString();
    const avgFillPrice = typeof live.avgPrice === 'number' ? live.avgPrice : null;
    await deps.orders.patch(record.id, {
      status,
      filledQty: live.filledQty,
      avgFillPrice,
      rejectionReason: live.rejectionReason ?? null,
      updatedAt: nowIso,
    });

    // --- ledger: keep only what actually filled --------------------------
    const entryId = deps.ids.ledgerId(record.id);
    if (live.filledQty > 0 && avgFillPrice !== null) {
      const entry: LedgerEntry = {
        id: entryId,
        uid: record.uid,
        bookId: record.bookId,
        strategyId: (await strategyIdFor(record)) ?? record.bookId,
        symbolKey: symbolKey(record.order.symbol),
        product: record.order.product,
        side: record.order.side,
        qty: live.filledQty,
        price: avgFillPrice,
        orderId: record.id,
        ts: nowIso,
      };
      await deps.ledger.append(entry);
    } else if (TERMINAL_STATUSES.includes(status)) {
      await deps.ledger.remove(record.uid, entryId);
    }

    // --- book: recompute the sleeve from the ledger -----------------------
    const book = await deps.books.get(record.uid, record.bookId);
    if (book !== undefined) {
      const entries = await deps.ledger.list(record.uid);
      await deps.books.patch(record.uid, record.bookId, {
        deployedInr: deployedFromLedger(entries, record.bookId),
      });
    }

    // --- proposal + audit -------------------------------------------------
    if (status === 'COMPLETE') {
      await deps.proposals.transition(record.proposalId, 'placed', 'filled', {
        orderId: record.id,
      });
      await deps.audit.record({
        uid: record.uid,
        type: 'order.filled',
        refId: record.id,
        detail: {
          proposalId: record.proposalId,
          brokerOrderId: record.brokerOrderId,
          filledQty: live.filledQty,
          avgFillPrice,
        },
      });
    } else if (status === 'REJECTED' || status === 'CANCELLED' || status === 'EXPIRED') {
      await deps.proposals.transition(record.proposalId, 'placed', 'rejected', {
        orderId: record.id,
        failureReason: live.rejectionReason ?? `broker ${status}`,
      });
      await deps.audit.record({
        uid: record.uid,
        type: 'order.rejected',
        refId: record.id,
        detail: {
          proposalId: record.proposalId,
          brokerOrderId: record.brokerOrderId,
          status,
          rejectionReason: live.rejectionReason ?? null,
          filledQty: live.filledQty,
        },
      });
    }
    // PARTIAL: the proposal deliberately stays `placed` until terminal
    // (docs/04 §4.10).
    return true;
  }

  async function strategyIdFor(record: OrderRecord): Promise<string | undefined> {
    const proposal: Proposal | undefined = await deps.proposals.get(record.proposalId);
    return proposal?.strategyId;
  }

  async function syncOne(uid: string, record: OrderRecord): Promise<SyncResult> {
    if (record.brokerOrderId === null) {
      return { ok: true, order: record, changed: false };
    }
    let live: OrderStatus;
    try {
      const ctx = await deps.broker.forUser(uid);
      live = await ctx.adapter.getOrder(record.brokerOrderId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: 'BROKER_ERROR', detail };
    }
    const changed = await apply(record, live);
    const fresh = (await deps.orders.get(record.id)) ?? record;
    return { ok: true, order: fresh, changed };
  }

  return {
    async reconcileUser(uid: string): Promise<ReconcileSummary> {
      const open = await deps.orders.listOpen(uid);
      let updated = 0;
      let errors = 0;
      for (const record of open) {
        const result = await syncOne(uid, record);
        if (!result.ok) {
          errors += 1;
          deps.logger.warn(
            { uid, orderId: record.id, detail: result.detail },
            'reconcile: order sync failed',
          );
          continue;
        }
        if (result.changed) updated += 1;
      }
      return { checked: open.length, updated, errors };
    },

    async syncOrder(uid: string, orderId: string): Promise<SyncResult> {
      const record = await deps.orders.get(orderId);
      if (record === undefined) {
        return { ok: false, reason: 'NOT_FOUND', detail: `order '${orderId}' not found` };
      }
      if (record.uid !== uid) {
        return { ok: false, reason: 'UNAUTHORIZED', detail: 'caller is not the owner' };
      }
      return syncOne(uid, record);
    },
  };
}
