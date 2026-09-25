import { describe, expect, it } from 'vitest';
import { symbolKey } from './domain.js';
import {
  canExit,
  heldProducts,
  netBySymbolProduct,
  ownedQty,
  positionsByBook,
  reconcile,
  type BookPosition,
} from './ledger.js';
import type { LedgerEntry } from './schemas.js';
import { INFY, RELIANCE, makeLedgerEntry, makeOrder, makePosition } from './test-utils.js';

const REL = symbolKey(RELIANCE);
const INF = symbolKey(INFY);

const ts = (minute: number): string =>
  new Date(Date.parse('2026-01-13T04:00:00.000Z') + minute * 60_000).toISOString();

function pos(positions: BookPosition[], bookId: string, key: string, product = 'DELIVERY') {
  const found = positions.find(
    (p) => p.bookId === bookId && p.symbolKey === key && p.product === product,
  );
  if (found === undefined) throw new Error(`no position for ${bookId}/${key}/${product}`);
  return found;
}

describe('positionsByBook', () => {
  it('attributes the same symbol to two books independently', () => {
    const entries: LedgerEntry[] = [
      makeLedgerEntry({ bookId: 'long_term', qty: 100, price: 2000, ts: ts(0) }),
      makeLedgerEntry({ bookId: 'swing', qty: 50, price: 2500, ts: ts(1) }),
      makeLedgerEntry({ bookId: 'swing', qty: 50, price: 2700, ts: ts(2) }),
    ];
    const positions = positionsByBook(entries);
    expect(positions).toHaveLength(2);
    expect(pos(positions, 'long_term', REL).qty).toBe(100);
    expect(pos(positions, 'long_term', REL).avgCostInr).toBe(2000);
    expect(pos(positions, 'swing', REL).qty).toBe(100);
    expect(pos(positions, 'swing', REL).avgCostInr).toBe(2600);
  });

  it('keeps the same symbol separate per product', () => {
    const entries = [
      makeLedgerEntry({ bookId: 'day_trade', product: 'INTRADAY', qty: 20, price: 100, ts: ts(0) }),
      makeLedgerEntry({ bookId: 'day_trade', product: 'DELIVERY', qty: 5, price: 110, ts: ts(1) }),
    ];
    const positions = positionsByBook(entries);
    expect(pos(positions, 'day_trade', REL, 'INTRADAY').qty).toBe(20);
    expect(pos(positions, 'day_trade', REL, 'DELIVERY').qty).toBe(5);
  });

  it('computes weighted-average cost on adds and keeps it on partial exits', () => {
    const entries = [
      makeLedgerEntry({ qty: 10, price: 100, ts: ts(0) }),
      makeLedgerEntry({ qty: 30, price: 200, ts: ts(1) }),
      makeLedgerEntry({ side: 'SELL', qty: 20, price: 250, ts: ts(2) }),
    ];
    const p = pos(positionsByBook(entries), 'long_term', REL);
    // avg after adds = (10×100 + 30×200) / 40 = 175
    expect(p.avgCostInr).toBe(175);
    expect(p.qty).toBe(20);
    // realized = 20 × (250 − 175) = 1500
    expect(p.realizedPnlInr).toBe(1500);
    expect(p.costBasisInr).toBe(3500);
  });

  it('realizes P&L and flattens the average on a full exit', () => {
    const entries = [
      makeLedgerEntry({ qty: 10, price: 100, ts: ts(0) }),
      makeLedgerEntry({ side: 'SELL', qty: 10, price: 90, ts: ts(1) }),
    ];
    const p = pos(positionsByBook(entries), 'long_term', REL);
    expect(p.qty).toBe(0);
    expect(p.avgCostInr).toBe(0);
    expect(p.realizedPnlInr).toBe(-100);
    expect(p.costBasisInr).toBe(0);
  });

  it('handles a short: SELL opens, BUY closes', () => {
    const entries = [
      makeLedgerEntry({ product: 'INTRADAY', side: 'SELL', qty: 10, price: 100, ts: ts(0) }),
      makeLedgerEntry({ product: 'INTRADAY', side: 'BUY', qty: 4, price: 90, ts: ts(1) }),
    ];
    const p = pos(positionsByBook(entries), 'long_term', REL, 'INTRADAY');
    expect(p.qty).toBe(-6);
    expect(p.avgCostInr).toBe(100);
    expect(p.realizedPnlInr).toBe(40);
  });

  it('crosses through zero: realizes the close then re-opens at the new price', () => {
    const entries = [
      makeLedgerEntry({ product: 'INTRADAY', qty: 10, price: 100, ts: ts(0) }),
      makeLedgerEntry({ product: 'INTRADAY', side: 'SELL', qty: 15, price: 120, ts: ts(1) }),
    ];
    const p = pos(positionsByBook(entries), 'long_term', REL, 'INTRADAY');
    expect(p.qty).toBe(-5);
    expect(p.avgCostInr).toBe(120);
    expect(p.realizedPnlInr).toBe(200);
  });

  it('folds entries in chronological order regardless of input order', () => {
    const late = makeLedgerEntry({ side: 'SELL', qty: 10, price: 200, ts: ts(5) });
    const early = makeLedgerEntry({ qty: 10, price: 100, ts: ts(1) });
    const a = pos(positionsByBook([late, early]), 'long_term', REL);
    const b = pos(positionsByBook([early, late]), 'long_term', REL);
    expect(a).toEqual(b);
    expect(a.realizedPnlInr).toBe(1000);
  });

  it('is deterministic for same-timestamp entries (ties broken by id)', () => {
    const e1 = makeLedgerEntry({ id: 'a', qty: 10, price: 100, ts: ts(0) });
    const e2 = makeLedgerEntry({ id: 'b', qty: 10, price: 200, ts: ts(0) });
    expect(positionsByBook([e1, e2])).toEqual(positionsByBook([e2, e1]));
  });

  it('returns nothing for an empty ledger', () => {
    expect(positionsByBook([])).toEqual([]);
  });
});

describe('ownedQty and heldProducts', () => {
  const entries = [
    makeLedgerEntry({ bookId: 'long_term', product: 'DELIVERY', qty: 100, price: 2000, ts: ts(0) }),
    makeLedgerEntry({ bookId: 'day_trade', product: 'INTRADAY', qty: 20, price: 2100, ts: ts(1) }),
    makeLedgerEntry({ bookId: 'swing', symbolKey: INF, qty: 30, price: 1500, ts: ts(2) }),
  ];

  it('reports what a book owns and zero for what it does not', () => {
    expect(ownedQty(entries, 'long_term', REL, 'DELIVERY')).toBe(100);
    expect(ownedQty(entries, 'day_trade', REL, 'INTRADAY')).toBe(20);
    expect(ownedQty(entries, 'day_trade', REL, 'DELIVERY')).toBe(0);
    expect(ownedQty(entries, 'scalp', REL, 'INTRADAY')).toBe(0);
    expect(ownedQty(entries, 'swing', INF, 'DELIVERY')).toBe(30);
    expect(ownedQty([], 'long_term', REL, 'DELIVERY')).toBe(0);
  });

  it('lists other products a book holds the symbol in', () => {
    const mixed = [
      makeLedgerEntry({ bookId: 'swing', product: 'DELIVERY', qty: 10, ts: ts(0) }),
      makeLedgerEntry({ bookId: 'swing', product: 'MARGIN', qty: 5, ts: ts(1) }),
    ];
    expect(heldProducts(mixed, 'swing', REL, 'MARGIN')).toEqual(['DELIVERY']);
    expect(heldProducts(mixed, 'swing', REL).sort()).toEqual(['DELIVERY', 'MARGIN']);
    expect(heldProducts(mixed, 'scalp', REL)).toEqual([]);
  });
});

describe('canExit', () => {
  const entries = [
    makeLedgerEntry({ bookId: 'long_term', product: 'DELIVERY', qty: 100, price: 2000, ts: ts(0) }),
  ];

  it('allows a book to close what it owns, including the full amount', () => {
    expect(canExit(entries, 'long_term', makeOrder({ side: 'SELL', quantity: 40 })).ok).toBe(true);
    expect(canExit(entries, 'long_term', makeOrder({ side: 'SELL', quantity: 100 })).ok).toBe(true);
  });

  it('denies closing more than it owns', () => {
    const check = canExit(entries, 'long_term', makeOrder({ side: 'SELL', quantity: 101 }));
    expect(check.ok).toBe(false);
    expect(check.closableQty).toBe(100);
    expect(check.requestedQty).toBe(101);
    expect(check.reason).toContain("book 'long_term' can close 100");
  });

  it('denies another book closing this book’s position', () => {
    const check = canExit(entries, 'scalp', makeOrder({ side: 'SELL', quantity: 1 }));
    expect(check.ok).toBe(false);
    expect(check.ownedQty).toBe(0);
    expect(check.reason).toContain("book 'scalp' can close 0");
  });

  it('denies an exit in the wrong product', () => {
    expect(
      canExit(entries, 'long_term', makeOrder({ side: 'SELL', quantity: 10, product: 'INTRADAY' }))
        .ok,
    ).toBe(false);
  });

  it('treats a BUY as an exit only against a short', () => {
    const short = [
      makeLedgerEntry({
        bookId: 'day_trade',
        product: 'INTRADAY',
        side: 'SELL',
        qty: 10,
        price: 100,
        ts: ts(0),
      }),
    ];
    const buy = makeOrder({ side: 'BUY', quantity: 10, product: 'INTRADAY' });
    expect(canExit(short, 'day_trade', buy).ok).toBe(true);
    expect(canExit(entries, 'long_term', makeOrder({ side: 'BUY', quantity: 1 })).ok).toBe(false);
  });
});

describe('netBySymbolProduct', () => {
  it('sums across books for broker reconciliation', () => {
    const entries = [
      makeLedgerEntry({ bookId: 'long_term', qty: 100, price: 2000, ts: ts(0) }),
      makeLedgerEntry({ bookId: 'swing', qty: 50, price: 2200, ts: ts(1) }),
      makeLedgerEntry({
        bookId: 'day_trade',
        product: 'INTRADAY',
        qty: 20,
        price: 2300,
        ts: ts(2),
      }),
    ];
    const net = netBySymbolProduct(entries);
    expect(net).toHaveLength(2);
    expect(net.find((n) => n.product === 'DELIVERY')?.qty).toBe(150);
    expect(net.find((n) => n.product === 'INTRADAY')?.qty).toBe(20);
  });

  it('nets opposing entries from different books', () => {
    const entries = [
      makeLedgerEntry({ bookId: 'swing', product: 'INTRADAY', qty: 10, price: 100, ts: ts(0) }),
      makeLedgerEntry({
        bookId: 'day_trade',
        product: 'INTRADAY',
        side: 'SELL',
        qty: 4,
        price: 110,
        ts: ts(1),
      }),
    ];
    expect(netBySymbolProduct(entries)[0]?.qty).toBe(6);
  });
});

describe('reconcile', () => {
  const ledgerNet = netBySymbolProduct([
    makeLedgerEntry({ bookId: 'long_term', qty: 100, price: 2000, ts: ts(0) }),
  ]);

  it('reports nothing when the books agree', () => {
    expect(reconcile(ledgerNet, [makePosition({ netQty: 100, product: 'DELIVERY' })])).toEqual([]);
    expect(reconcile([], [])).toEqual([]);
  });

  it('detects a quantity mismatch (a manual trade outside the system)', () => {
    const mismatches = reconcile(ledgerNet, [makePosition({ netQty: 120 })]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      kind: 'qty_mismatch',
      ledgerQty: 100,
      brokerQty: 120,
      diff: 20,
    });
    expect(mismatches[0]?.detail).toContain('ledger 100 vs broker 120');
  });

  it('detects quantity present in the ledger but not at the broker', () => {
    expect(reconcile(ledgerNet, [])[0]).toMatchObject({ kind: 'missing_in_broker', diff: -100 });
  });

  it('detects quantity at the broker that the ledger never booked', () => {
    expect(reconcile([], [makePosition({ netQty: 7 })])[0]).toMatchObject({
      kind: 'missing_in_ledger',
      diff: 7,
    });
  });

  it('matches on product, not just symbol', () => {
    const mismatches = reconcile(ledgerNet, [makePosition({ netQty: 100, product: 'INTRADAY' })]);
    expect(mismatches.map((m) => m.kind).sort()).toEqual([
      'missing_in_broker',
      'missing_in_ledger',
    ]);
  });

  it('folds duplicate broker rows for the same symbol and product', () => {
    expect(
      reconcile(ledgerNet, [makePosition({ netQty: 60 }), makePosition({ netQty: 40 })]),
    ).toEqual([]);
  });
});
