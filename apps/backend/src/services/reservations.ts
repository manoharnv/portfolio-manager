/**
 * Capital reservations — the half-step between "order submitted" and "order
 * filled" (docs/10 §10.3/§10.4).
 *
 * The ledger is the record of what a book **owns**, so a row may only exist once
 * quantity has actually filled: an unfilled BUY that showed up in the ledger
 * would let a later SELL from the same book pass `canExit` against shares that
 * never arrived — and on an intraday book that is an unintended short, not a
 * square-off.
 *
 * A submitted order still has to hold the sleeve's capital, though, or two
 * proposals could each spend the same rupees. That is what a *reservation* is:
 *
 *     deployedInr(book) = Σ open cost basis in the ledger (filled)
 *                       + Σ unfilled remainder of the book's still-open orders
 *
 * Reservations are **derived**, never stored: an order record plus its
 * proposal's `marketContext.ltpAtProposal` is enough to price one, so there is
 * no third source of truth to drift.
 */

import { ownedQty, positionsByBook, symbolKey } from '@pm/core';
import type { LedgerEntry, NormalizedOrder, OrderRecord, OrderStatusCode } from '@pm/core';

/** Statuses whose unfilled remainder still ties up the book's capital. */
export const RESERVING_STATUSES: readonly OrderStatusCode[] = [
  'SUBMITTED',
  'OPEN',
  'PARTIAL',
  'UNKNOWN',
];

/**
 * Is this order *reducing* a position the book already holds? A SELL closes a
 * long, a BUY closes a short — and a DELIVERY SELL is always treated as a close,
 * because you cannot short delivery stock (docs/10 §10.4 exit rule).
 */
export function isClosingOrder(order: NormalizedOrder, owned: number): boolean {
  if (order.side === 'SELL') return owned > 0 || order.product === 'DELIVERY';
  return owned < 0;
}

/**
 * The price a reservation is valued at.
 *
 * MARKET and SL-M orders carry no price of their own, so the **proposal-time
 * LTP** is used as an approximation — it is the number the human saw and the
 * only price attached to the decision. The reservation is corrected the moment
 * a fill arrives and the ledger takes over.
 */
export function reservationPrice(
  order: NormalizedOrder,
  proposalLtp?: number | undefined,
): number | undefined {
  const price = order.limitPrice ?? order.triggerPrice ?? proposalLtp;
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : undefined;
}

/** Capital an order reserves when it is submitted. `undefined` ⇒ unpriceable. */
export function reservationInr(
  order: NormalizedOrder,
  proposalLtp?: number | undefined,
): number | undefined {
  const price = reservationPrice(order, proposalLtp);
  return price === undefined ? undefined : order.quantity * price;
}

/** Capital an order *still* reserves: its unfilled remainder, in rupees. */
export function openReservationInr(record: OrderRecord, proposalLtp?: number | undefined): number {
  const price = reservationPrice(record.order, proposalLtp ?? record.avgFillPrice ?? undefined);
  if (price === undefined) return 0;
  const remaining = Math.max(0, record.order.quantity - record.filledQty);
  return remaining * price;
}

/** An open order plus the proposal-time LTP needed to price it. */
export interface OpenReservation {
  record: OrderRecord;
  /** Only needed for MARKET / SL-M orders, which carry no price. */
  proposalLtp?: number | undefined;
}

/** Σ open cost basis in the ledger for one book (docs/10 §10.3's definition). */
export function deployedFromLedger(entries: readonly LedgerEntry[], bookId: string): number {
  return positionsByBook(entries)
    .filter((p) => p.bookId === bookId && p.qty !== 0)
    .reduce((sum, p) => sum + p.costBasisInr, 0);
}

/**
 * `deployedInr` for one book: filled cost basis plus outstanding reservations.
 *
 * Closing orders are excluded from the reservation sum — the position they are
 * unwinding is already counted at cost in the ledger, so reserving for the exit
 * as well would charge the sleeve twice and could block a legitimate square-off.
 * This mirrors the submission-time rule, where only an opening order deploys.
 */
export function deployedInrFor(
  bookId: string,
  entries: readonly LedgerEntry[],
  open: readonly OpenReservation[],
): number {
  const reserved = open
    .filter((o) => o.record.bookId === bookId && RESERVING_STATUSES.includes(o.record.status))
    .filter((o) => {
      const owned = ownedQty(
        entries,
        bookId,
        symbolKey(o.record.order.symbol),
        o.record.order.product,
      );
      return !isClosingOrder(o.record.order, owned);
    })
    .reduce((sum, o) => sum + openReservationInr(o.record, o.proposalLtp), 0);

  return deployedFromLedger(entries, bookId) + reserved;
}
