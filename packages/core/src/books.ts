/**
 * Books = capital sleeves — docs/10-multi-strategy.md §10.3.
 *
 * One real broker account, four virtual budgets. A book may only deploy within
 * its own `allocatedCapitalInr`; this is checked **in addition to** the backend's
 * real funds/margin guardrail, never instead of it. That is what stops the scalp
 * book spending the long-term book's capital.
 */

import type { Book } from './schemas.js';

/** Tolerance for percentage/rupee comparisons so float noise never blocks a trade. */
const EPS = 1e-9;

export class BookBudgetError extends Error {
  readonly bookId: string;
  readonly requestedInr: number;
  readonly availableInr: number;

  constructor(bookId: string, requestedInr: number, availableInr: number, message: string) {
    super(message);
    this.name = 'BookBudgetError';
    this.bookId = bookId;
    this.requestedInr = requestedInr;
    this.availableInr = availableInr;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BookAllocationError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Invalid book allocation: ${detail}`);
    this.name = 'BookAllocationError';
    this.detail = detail;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Capital this book may still put to work. Never negative. */
export function availableBudget(book: Book): number {
  return Math.max(0, book.allocatedCapitalInr - book.deployedInr);
}

/**
 * `true` when `amountInr` fits the book's remaining budget. A disabled book can
 * never deploy, and a non-positive/non-finite amount is rejected outright.
 */
export function canDeploy(book: Book, amountInr: number): boolean {
  if (!book.enabled) return false;
  if (!Number.isFinite(amountInr) || amountInr <= 0) return false;
  return amountInr <= availableBudget(book) + EPS;
}

/**
 * Returns a copy of the book with `amountInr` added to `deployedInr`.
 * Throws {@link BookBudgetError} rather than over-deploying.
 */
export function applyDeployment(book: Book, amountInr: number): Book {
  if (!canDeploy(book, amountInr)) {
    throw new BookBudgetError(
      book.id,
      amountInr,
      availableBudget(book),
      !book.enabled
        ? `Book '${book.id}' is disabled`
        : !Number.isFinite(amountInr) || amountInr <= 0
          ? `Deployment amount must be a positive finite number, got ${amountInr}`
          : `Book '${book.id}' has ₹${availableBudget(book)} available, needs ₹${amountInr}`,
    );
  }
  return { ...book, deployedInr: book.deployedInr + amountInr };
}

/**
 * Returns a copy of the book with `amountInr` released from `deployedInr` and
 * `realizedPnlInr` booked. Releasing more than is deployed clamps at zero (a
 * partial-fill reconciliation must not drive the sleeve negative) — the caller
 * should treat a clamp as a reconciliation signal.
 */
export function applyRelease(book: Book, amountInr: number, realizedPnlInr = 0): Book {
  if (!Number.isFinite(amountInr) || amountInr < 0) {
    throw new BookBudgetError(
      book.id,
      amountInr,
      book.deployedInr,
      `Release amount must be a non-negative finite number, got ${amountInr}`,
    );
  }
  if (!Number.isFinite(realizedPnlInr)) {
    throw new BookBudgetError(
      book.id,
      amountInr,
      book.deployedInr,
      `Realized P&L must be finite, got ${realizedPnlInr}`,
    );
  }
  return {
    ...book,
    deployedInr: Math.max(0, book.deployedInr - amountInr),
    realizedPnlInr: book.realizedPnlInr + realizedPnlInr,
  };
}

export interface AllocationValidation {
  ok: boolean;
  totalAllocationPct: number;
  reservePct: number;
  /** `totalAllocationPct + reservePct` */
  committedPct: number;
  detail: string;
}

/**
 * Σ allocationPct + reservePct ≤ 100, with unique book ids (docs/10 §10.3).
 * Disabled books still count — their allocation stays reserved for them.
 */
export function validateAllocations(
  books: readonly Book[],
  reservePct: number,
): AllocationValidation {
  const totalAllocationPct = books.reduce((sum, b) => sum + b.allocationPct, 0);
  const committedPct = totalAllocationPct + reservePct;
  const base: Omit<AllocationValidation, 'ok' | 'detail'> = {
    totalAllocationPct,
    reservePct,
    committedPct,
  };

  const ids = books.map((b) => b.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) {
    return {
      ...base,
      ok: false,
      detail: `duplicate book ids: ${[...new Set(duplicates)].join(', ')}`,
    };
  }
  if (!Number.isFinite(reservePct) || reservePct < 0 || reservePct > 100) {
    return { ...base, ok: false, detail: `reservePct must be within 0–100, got ${reservePct}` };
  }
  if (books.some((b) => !Number.isFinite(b.allocationPct) || b.allocationPct < 0)) {
    return { ...base, ok: false, detail: 'every allocationPct must be a non-negative number' };
  }
  if (committedPct > 100 + EPS) {
    return {
      ...base,
      ok: false,
      detail: `Σ allocationPct (${totalAllocationPct}%) + reservePct (${reservePct}%) = ${committedPct}% > 100%`,
    };
  }
  return {
    ...base,
    ok: true,
    detail: `Σ allocationPct (${totalAllocationPct}%) + reservePct (${reservePct}%) = ${committedPct}% ≤ 100%`,
  };
}

/** Throwing form of {@link validateAllocations}. */
export function assertValidAllocations(books: readonly Book[], reservePct: number): void {
  const result = validateAllocations(books, reservePct);
  if (!result.ok) throw new BookAllocationError(result.detail);
}

/**
 * `allocatedCapitalInr` = totalManagedCapitalInr × allocationPct / 100
 * (docs/10 §10.3). The reserve is accounted for separately by
 * {@link validateAllocations}, not subtracted here.
 */
export function deriveAllocatedCapital(totalManagedInr: number, book: Book): number {
  if (!Number.isFinite(totalManagedInr) || totalManagedInr < 0) {
    throw new BookAllocationError(`totalManagedCapitalInr must be ≥ 0, got ${totalManagedInr}`);
  }
  return (totalManagedInr * book.allocationPct) / 100;
}

/** Recompute `allocatedCapitalInr` for every book from the total managed capital. */
export function withDerivedAllocations(totalManagedInr: number, books: readonly Book[]): Book[] {
  return books.map((book) => ({
    ...book,
    allocatedCapitalInr: deriveAllocatedCapital(totalManagedInr, book),
  }));
}
