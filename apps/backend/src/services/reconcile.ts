/**
 * Order-status reconciliation — docs/04 §4.7 and §4.10.
 *
 * `placeOrder` returns an ack, not a fill. This is the loop that turns acks into
 * truth: poll `getOrder` for every still-open order, update `orders`, drive the
 * proposal to its terminal state, and keep the per-book ledger honest.
 *
 * **The ledger records fills, and only fills** (docs/10 §10.4). A row appears
 * the first time an order fills any quantity, carrying the *cumulative* filled
 * quantity and average price, and is updated in place (same id `led_<orderId>`)
 * as more fills arrive. An order that is rejected or cancelled without filling
 * never gets a row at all. That is what makes `canExit` mean "the book owns
 * this", so a day-trade square-off can never sell shares that are still in
 * flight.
 *
 * Capital is still held while an order is open — see `reservations.ts`. After
 * every change this module recomputes
 *   `deployedInr = Σ filled cost basis + Σ unfilled remainder of open orders`,
 * so a reject releases exactly what it reserved, with no stored delta to drift.
 *
 * It also sweeps proposals that got stuck in `approved`/`placing` — a crash
 * between the state write and the broker call would otherwise leave a proposal
 * pinned forever, and its reservation with it.
 */

import { canTransition, symbolKey } from '@pm/core';
import type { OrderStatus, OrderStatusCode } from '@pm/core';
import type { LedgerEntry, OrderRecord, ProposalStatus } from '@pm/core';
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
import { deployedInrFor, type OpenReservation } from './reservations.js';

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

/** A proposal parked in `approved`/`placing` this long is presumed abandoned. */
export const DEFAULT_STUCK_AFTER_MS = 5 * 60 * 1000;

/** Non-terminal states the backend owns; nobody else can move them on. */
const STUCK_CANDIDATE_STATUSES: readonly ProposalStatus[] = ['approved', 'placing'];

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
  /** Defaults to {@link DEFAULT_STUCK_AFTER_MS}. */
  stuckAfterMs?: number | undefined;
}

export interface ReconcileSummary {
  checked: number;
  updated: number;
  errors: number;
  /** Proposals moved out of a stuck `approved`/`placing` state. */
  stuck: number;
}

export type SyncResult =
  | { ok: true; order: OrderRecord; changed: boolean }
  | { ok: false; reason: 'NOT_FOUND' | 'UNAUTHORIZED' | 'BROKER_ERROR'; detail: string };

export interface ReconcileService {
  /** Poll every open order for one user, then sweep stuck proposals. Never throws. */
  reconcileUser(uid: string): Promise<ReconcileSummary>;
  /** Re-sync one order from the broker (`GET /v1/orders/:id`). */
  syncOrder(uid: string, orderId: string): Promise<SyncResult>;
}

export function createReconcileService(deps: ReconcileDeps): ReconcileService {
  const stuckAfterMs = deps.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;

  /** Proposal-time LTP, fetched only for orders that carry no price of their own. */
  async function proposalLtpFor(record: OrderRecord): Promise<number | undefined> {
    if (record.order.limitPrice !== undefined || record.order.triggerPrice !== undefined) {
      return undefined;
    }
    const proposal = await deps.proposals.get(record.proposalId);
    return proposal?.marketContext.ltpAtProposal;
  }

  /** `Σ filled cost basis + Σ open reservations`, recomputed from scratch. */
  async function recomputeDeployed(uid: string, bookId: OrderRecord['bookId']): Promise<void> {
    const book = await deps.books.get(uid, bookId);
    if (book === undefined) return;

    const entries = await deps.ledger.list(uid);
    const open = await deps.orders.listOpen(uid);
    const reservations: OpenReservation[] = [];
    for (const record of open) {
      reservations.push({ record, proposalLtp: await proposalLtpFor(record) });
    }
    await deps.books.patch(uid, bookId, {
      deployedInr: deployedInrFor(bookId, entries, reservations),
    });
  }

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

    // --- ledger: fills only, upserted in place ----------------------------
    const entryId = deps.ids.ledgerId(record.id);
    if (live.filledQty > 0 && avgFillPrice !== null) {
      const proposal = await deps.proposals.get(record.proposalId);
      const entry: LedgerEntry = {
        id: entryId,
        uid: record.uid,
        bookId: record.bookId,
        strategyId: proposal?.strategyId ?? record.bookId,
        symbolKey: symbolKey(record.order.symbol),
        product: record.order.product,
        side: record.order.side,
        // Cumulative, not incremental: re-appending the same id replaces the row,
        // so a PARTIAL followed by COMPLETE updates rather than double-counts.
        qty: live.filledQty,
        price: avgFillPrice,
        orderId: record.id,
        ts: nowIso,
      };
      await deps.ledger.append(entry);
    } else if (TERMINAL_STATUSES.includes(status)) {
      // Nothing filled, so there should be no row. Belt and braces.
      await deps.ledger.remove(record.uid, entryId);
    }

    // --- book: recompute the sleeve from fills + live reservations ---------
    await recomputeDeployed(record.uid, record.bookId);

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

  /**
   * Free proposals abandoned mid-execution.
   *
   * Only edges core's state machine already allows are used:
   * `approved → blocked` and `placing → failed`. A proposal that *does* have an
   * order record is left alone — that one belongs to the polling loop above, not
   * here, and calling it "failed" while the broker holds a live order would be
   * the worst possible lie.
   */
  async function sweepStuck(uid: string): Promise<number> {
    const candidates = await deps.proposals.listByStatus(uid, STUCK_CANDIDATE_STATUSES);
    const cutoffMs = deps.clock.now().getTime() - stuckAfterMs;
    let swept = 0;

    for (const proposal of candidates) {
      const stuckSince = proposal.decidedAt ?? proposal.createdAt;
      const sinceMs = Date.parse(stuckSince);
      if (Number.isNaN(sinceMs) || sinceMs > cutoffMs) continue;

      const existing = await deps.orders.findByProposal(uid, proposal.id);
      if (existing !== undefined) continue;

      const to: ProposalStatus = proposal.status === 'approved' ? 'blocked' : 'failed';
      if (!canTransition(proposal.status, to)) continue;

      const moved = await deps.proposals.transition(proposal.id, proposal.status, to, {
        failureReason: 'stuck',
      });
      if (!moved.ok) continue;

      await deps.audit.record({
        uid,
        type: to === 'blocked' ? 'guardrail.blocked' : 'order.failed',
        refId: proposal.id,
        detail: {
          reason: 'stuck',
          from: proposal.status,
          to,
          stuckSince,
          stuckAfterMs,
        },
      });
      await recomputeDeployed(uid, proposal.bookId);
      swept += 1;
      deps.logger.warn(
        { uid, proposalId: proposal.id, from: proposal.status, to },
        'stuck proposal swept',
      );
    }
    return swept;
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
      const stuck = await sweepStuck(uid);
      return { checked: open.length, updated, errors, stuck };
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
