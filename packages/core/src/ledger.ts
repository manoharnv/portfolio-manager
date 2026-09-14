/**
 * Position attribution ledger — docs/10-multi-strategy.md §10.4.
 *
 * The broker reports *net* positions per (symbol, product). That is not enough
 * when two books trade the same symbol with the same product, so we keep our own
 * tagged ledger and reconstruct per-book positions from it.
 *
 * Exit rule: a book may only close quantity **it owns** in the ledger. The scalp
 * book can never sell the long-term book's delivery shares.
 */

import type { NormalizedOrder, Position, Product, Side } from './domain.js';
import { symbolKey } from './domain.js';
import type { LedgerEntry } from './schemas.js';

/** Per-(book, symbol, product) reconstructed position. */
export interface BookPosition {
  bookId: string;
  symbolKey: string;
  product: Product;
  /** Signed: positive = long, negative = short. */
  qty: number;
  /** Weighted average cost of the currently open quantity; 0 when flat. */
  avgCostInr: number;
  /** Booked P&L from closes within this (book, symbol, product). */
  realizedPnlInr: number;
  /** |qty| × avgCostInr — the capital this position ties up at cost. */
  costBasisInr: number;
}

/** Ledger totals across all books, for broker reconciliation. */
export interface NetPosition {
  symbolKey: string;
  product: Product;
  qty: number;
  avgCostInr: number;
  realizedPnlInr: number;
}

interface Acc {
  qty: number;
  avgCost: number;
  realizedPnl: number;
}

function emptyAcc(): Acc {
  return { qty: 0, avgCost: 0, realizedPnl: 0 };
}

/**
 * Fold one fill into a running position.
 *
 * - adding to a position → weighted-average cost;
 * - reducing a position → realize P&L on the closed quantity, average unchanged;
 * - crossing through zero → realize on the closed part, re-open the remainder at
 *   the fill price.
 */
function applyFill(acc: Acc, side: Side, qty: number, price: number): void {
  if (qty <= 0) return;
  const signed = side === 'BUY' ? qty : -qty;

  if (acc.qty === 0) {
    acc.qty = signed;
    acc.avgCost = price;
    return;
  }

  const sameDirection = acc.qty > 0 === signed > 0;
  if (sameDirection) {
    const openAbs = Math.abs(acc.qty);
    acc.avgCost = (openAbs * acc.avgCost + qty * price) / (openAbs + qty);
    acc.qty += signed;
    return;
  }

  const wasLong = acc.qty > 0;
  const closed = Math.min(Math.abs(acc.qty), qty);
  acc.realizedPnl += wasLong ? closed * (price - acc.avgCost) : closed * (acc.avgCost - price);
  acc.qty += signed;

  if (acc.qty === 0) {
    acc.avgCost = 0;
  } else if (acc.qty > 0 !== wasLong) {
    // Crossed through flat into the opposite direction.
    acc.avgCost = price;
  }
}

/** Chronological order; ties broken by entry id so the fold is deterministic. */
function sortedEntries(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => {
    const ta = Date.parse(a.ts);
    const tb = Date.parse(b.ts);
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

interface Group {
  bookId: string;
  symbolKey: string;
  product: Product;
  acc: Acc;
}

/**
 * Fold the ledger into groups keyed by `keyOf`. Each group carries its
 * identifying fields verbatim — never re-parsed out of the composite key — so a
 * trading symbol containing a separator character cannot corrupt attribution.
 */
function fold(entries: readonly LedgerEntry[], keyOf: (e: LedgerEntry) => string): Group[] {
  const groups = new Map<string, Group>();
  for (const e of sortedEntries(entries)) {
    const k = keyOf(e);
    let g = groups.get(k);
    if (g === undefined) {
      g = { bookId: e.bookId, symbolKey: e.symbolKey, product: e.product, acc: emptyAcc() };
      groups.set(k, g);
    }
    applyFill(g.acc, e.side, e.qty, e.price);
  }
  return [...groups.values()];
}

const bookKey = (e: LedgerEntry): string => JSON.stringify([e.bookId, e.symbolKey, e.product]);
const netKey = (e: LedgerEntry): string => JSON.stringify([e.symbolKey, e.product]);

/**
 * Per-(bookId, symbolKey, product) positions rebuilt from the ledger. Flat
 * positions (qty === 0) are still returned so realized P&L is not lost.
 */
export function positionsByBook(entries: readonly LedgerEntry[]): BookPosition[] {
  return fold(entries, bookKey)
    .map((g) => ({
      bookId: g.bookId,
      symbolKey: g.symbolKey,
      product: g.product,
      qty: g.acc.qty,
      avgCostInr: g.acc.avgCost,
      realizedPnlInr: g.acc.realizedPnl,
      costBasisInr: Math.abs(g.acc.qty) * g.acc.avgCost,
    }))
    .sort(
      (x, y) =>
        x.bookId.localeCompare(y.bookId) ||
        x.symbolKey.localeCompare(y.symbolKey) ||
        x.product.localeCompare(y.product),
    );
}

/** Signed quantity a book owns of (symbolKey, product). Positive = long. */
export function ownedQty(
  entries: readonly LedgerEntry[],
  bookId: string,
  key: string,
  product: Product,
): number {
  const relevant = entries.filter(
    (e) => e.bookId === bookId && e.symbolKey === key && e.product === product,
  );
  return fold(relevant, bookKey)[0]?.acc.qty ?? 0;
}

/** Products (other than `exclude`) in which this book holds a non-zero position. */
export function heldProducts(
  entries: readonly LedgerEntry[],
  bookId: string,
  key: string,
  exclude?: Product,
): Product[] {
  return positionsByBook(entries)
    .filter((p) => p.bookId === bookId && p.symbolKey === key && p.qty !== 0)
    .map((p) => p.product)
    .filter((p) => p !== exclude);
}

export interface ExitCheck {
  ok: boolean;
  /** Audit-ready explanation; empty when `ok`. */
  reason: string;
  /** Signed quantity the book holds. */
  ownedQty: number;
  /** Quantity of the book's position this order could close. */
  closableQty: number;
  requestedQty: number;
}

/**
 * May this book close `order.quantity` of its own position? A SELL closes a long,
 * a BUY closes a short. Anything the book does not own is not closable here — the
 * coordinator decides separately whether opening fresh exposure is allowed.
 */
export function canExit(
  entries: readonly LedgerEntry[],
  bookId: string,
  order: NormalizedOrder,
): ExitCheck {
  const key = symbolKey(order.symbol);
  const owned = ownedQty(entries, bookId, key, order.product);
  const closableQty = order.side === 'SELL' ? Math.max(0, owned) : Math.max(0, -owned);
  const requestedQty = order.quantity;
  const ok = requestedQty > 0 && requestedQty <= closableQty;
  return {
    ok,
    reason: ok
      ? ''
      : `book '${bookId}' can close ${closableQty} of ${order.product} ${key} ` +
        `(holds ${owned}), order wants to close ${requestedQty}`,
    ownedQty: owned,
    closableQty,
    requestedQty,
  };
}

/** Ledger totals per (symbolKey, product) across every book. */
export function netBySymbolProduct(entries: readonly LedgerEntry[]): NetPosition[] {
  return fold(entries, netKey)
    .map((g) => ({
      symbolKey: g.symbolKey,
      product: g.product,
      qty: g.acc.qty,
      avgCostInr: g.acc.avgCost,
      realizedPnlInr: g.acc.realizedPnl,
    }))
    .sort((x, y) => x.symbolKey.localeCompare(y.symbolKey) || x.product.localeCompare(y.product));
}

export type MismatchKind = 'qty_mismatch' | 'missing_in_broker' | 'missing_in_ledger';

export interface ReconciliationMismatch {
  symbolKey: string;
  product: Product;
  ledgerQty: number;
  brokerQty: number;
  /** brokerQty − ledgerQty. Positive ⇒ quantity we never booked (manual trade). */
  diff: number;
  kind: MismatchKind;
  detail: string;
}

/**
 * Compare ledger totals against the broker's net positions (docs/10 §10.4).
 * An empty result means the books agree. Any drift is a bug or a manual trade
 * placed outside the system, and must be attributed to the `unmanaged` book.
 */
export function reconcile(
  ledgerNet: readonly NetPosition[],
  brokerPositions: readonly Position[],
): ReconciliationMismatch[] {
  const pairKey = (sym: string, product: Product): string => JSON.stringify([sym, product]);

  const ledgerMap = new Map<string, NetPosition>();
  for (const n of ledgerNet) {
    ledgerMap.set(pairKey(n.symbolKey, n.product), n);
  }

  const brokerMap = new Map<string, { symbolKey: string; product: Product; qty: number }>();
  for (const p of brokerPositions) {
    const sym = symbolKey(p.symbol);
    const k = pairKey(sym, p.product);
    const prev = brokerMap.get(k);
    brokerMap.set(k, { symbolKey: sym, product: p.product, qty: (prev?.qty ?? 0) + p.netQty });
  }

  const out: ReconciliationMismatch[] = [];
  for (const k of new Set([...ledgerMap.keys(), ...brokerMap.keys()])) {
    const l = ledgerMap.get(k);
    const b = brokerMap.get(k);
    const ledgerQty = l?.qty ?? 0;
    const brokerQty = b?.qty ?? 0;
    if (ledgerQty === brokerQty) continue;

    const sym = l?.symbolKey ?? b?.symbolKey ?? '';
    const product: Product = l?.product ?? b?.product ?? 'DELIVERY';
    const kind: MismatchKind =
      ledgerQty !== 0 && brokerQty === 0
        ? 'missing_in_broker'
        : ledgerQty === 0 && brokerQty !== 0
          ? 'missing_in_ledger'
          : 'qty_mismatch';
    out.push({
      symbolKey: sym,
      product,
      ledgerQty,
      brokerQty,
      diff: brokerQty - ledgerQty,
      kind,
      detail: `${sym} ${product}: ledger ${ledgerQty} vs broker ${brokerQty} (diff ${brokerQty - ledgerQty})`,
    });
  }

  return out.sort(
    (x, y) => x.symbolKey.localeCompare(y.symbolKey) || x.product.localeCompare(y.product),
  );
}
