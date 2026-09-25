import { describe, expect, it } from 'vitest';
import {
  deployedFromLedger,
  deployedInrFor,
  isClosingOrder,
  openReservationInr,
  reservationInr,
  reservationPrice,
} from './reservations.js';
import type { OpenReservation } from './reservations.js';
import { makeLedgerEntry, makeOrder, makeOrderRecord } from '../test-utils/fixtures.js';

describe('isClosingOrder', () => {
  it('treats a DELIVERY SELL as a close even when the book owns nothing', () => {
    expect(isClosingOrder(makeOrder({ side: 'SELL' }), 0)).toBe(true);
  });

  it('treats an INTRADAY SELL with no position as an opening short', () => {
    expect(isClosingOrder(makeOrder({ side: 'SELL', product: 'INTRADAY' }), 0)).toBe(false);
    expect(isClosingOrder(makeOrder({ side: 'SELL', product: 'INTRADAY' }), 5)).toBe(true);
  });

  it('treats a BUY as closing only against a short', () => {
    expect(isClosingOrder(makeOrder({ side: 'BUY' }), 0)).toBe(false);
    expect(isClosingOrder(makeOrder({ side: 'BUY' }), 10)).toBe(false);
    expect(isClosingOrder(makeOrder({ side: 'BUY' }), -5)).toBe(true);
  });
});

describe('reservationPrice', () => {
  it('prefers the limit price', () => {
    expect(reservationPrice(makeOrder({ limitPrice: 2950.5 }), 3000)).toBe(2950.5);
  });

  it('falls back to the trigger price for an SL-M order', () => {
    const order = makeOrder({ orderType: 'SL-M', limitPrice: undefined, triggerPrice: 2900 });
    expect(reservationPrice(order, 3000)).toBe(2900);
  });

  it('uses the proposal-time LTP for a MARKET order', () => {
    const order = makeOrder({ orderType: 'MARKET', limitPrice: undefined });
    expect(reservationPrice(order, 2951)).toBe(2951);
  });

  it('is undefined when nothing can price the order', () => {
    const order = makeOrder({ orderType: 'MARKET', limitPrice: undefined });
    expect(reservationPrice(order, undefined)).toBeUndefined();
    expect(reservationPrice(order, 0)).toBeUndefined();
    expect(reservationPrice(order, Number.NaN)).toBeUndefined();
  });
});

describe('reservationInr', () => {
  it('is quantity × the reservation price', () => {
    expect(reservationInr(makeOrder({ quantity: 10, limitPrice: 100 }))).toBe(1_000);
  });

  it('is undefined when unpriceable', () => {
    expect(
      reservationInr(makeOrder({ orderType: 'MARKET', limitPrice: undefined }), undefined),
    ).toBeUndefined();
  });
});

describe('openReservationInr', () => {
  it('reserves the whole order before any fill', () => {
    expect(openReservationInr(makeOrderRecord())).toBe(29_505);
  });

  it('reserves only the unfilled remainder after a partial fill', () => {
    expect(openReservationInr(makeOrderRecord({ filledQty: 4 }))).toBeCloseTo(17_703, 6);
  });

  it('reserves nothing once fully filled', () => {
    expect(openReservationInr(makeOrderRecord({ filledQty: 10 }))).toBe(0);
    expect(openReservationInr(makeOrderRecord({ filledQty: 12 }))).toBe(0);
  });

  it('prices a MARKET order from the proposal LTP, else the average fill', () => {
    const market = makeOrderRecord({
      order: makeOrder({ orderType: 'MARKET', limitPrice: undefined }),
    });
    expect(openReservationInr(market, 2_951)).toBe(29_510);
    expect(openReservationInr({ ...market, avgFillPrice: 2_900 })).toBe(29_000);
    expect(openReservationInr(market)).toBe(0);
  });
});

describe('deployedFromLedger', () => {
  it('sums the open cost basis of one book only', () => {
    const entries = [
      makeLedgerEntry({ bookId: 'long_term', qty: 10, price: 100 }),
      makeLedgerEntry({ bookId: 'swing', qty: 5, price: 200 }),
    ];
    expect(deployedFromLedger(entries, 'long_term')).toBe(1_000);
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

describe('deployedInrFor', () => {
  it('adds outstanding reservations to the filled cost basis', () => {
    // One filled order (10 @ 100 in the ledger), one still-open order, and one
    // rejected order whose reservation must already be gone.
    const entries = [makeLedgerEntry({ id: 'led_a', orderId: 'a', qty: 10, price: 100 })];
    const open: OpenReservation[] = [
      { record: makeOrderRecord({ id: 'a', status: 'COMPLETE', filledQty: 10 }) },
      { record: makeOrderRecord({ id: 'b', status: 'OPEN' }) },
      { record: makeOrderRecord({ id: 'c', status: 'REJECTED' }) },
    ];

    // 1_000 (filled, from the ledger) + 29_505 (order b's unfilled remainder).
    // Order a reserves nothing (terminal), order c reserves nothing (rejected).
    expect(deployedInrFor('long_term', entries, open)).toBeCloseTo(30_505, 6);
  });

  it('counts the unfilled remainder of a partially-filled order', () => {
    const entries = [makeLedgerEntry({ id: 'led_b', orderId: 'b', qty: 4, price: 2_949 })];
    const open: OpenReservation[] = [
      {
        record: makeOrderRecord({ id: 'b', status: 'PARTIAL', filledQty: 4, avgFillPrice: 2_949 }),
      },
    ];
    // 4 × 2949 filled + 6 × 2950.5 still reserved.
    expect(deployedInrFor('long_term', entries, open)).toBeCloseTo(11_796 + 17_703, 6);
  });

  it('ignores orders belonging to another book', () => {
    const open: OpenReservation[] = [
      { record: makeOrderRecord({ id: 'b', bookId: 'swing', status: 'OPEN' }) },
    ];
    expect(deployedInrFor('long_term', [], open)).toBe(0);
    expect(deployedInrFor('swing', [], open)).toBe(29_505);
  });

  it('does not reserve for an exit — that capital is already in the ledger', () => {
    const entries = [makeLedgerEntry({ id: 'led_a', orderId: 'a', qty: 10, price: 100 })];
    const open: OpenReservation[] = [
      {
        record: makeOrderRecord({
          id: 'b',
          status: 'OPEN',
          order: makeOrder({ side: 'SELL', quantity: 10 }),
        }),
      },
    ];
    expect(deployedInrFor('long_term', entries, open)).toBe(1_000);
  });

  it('is zero for a book with no fills and no open orders', () => {
    expect(deployedInrFor('scalp', [], [])).toBe(0);
  });
});
