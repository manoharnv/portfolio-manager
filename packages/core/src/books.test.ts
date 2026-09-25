import { describe, expect, it } from 'vitest';
import {
  BookAllocationError,
  BookBudgetError,
  applyDeployment,
  applyRelease,
  assertValidAllocations,
  availableBudget,
  canDeploy,
  deriveAllocatedCapital,
  validateAllocations,
  withDerivedAllocations,
} from './books.js';
import { makeBook } from './test-utils.js';

describe('availableBudget', () => {
  it('is allocated minus deployed', () => {
    expect(availableBudget(makeBook({ allocatedCapitalInr: 500_000, deployedInr: 120_000 }))).toBe(
      380_000,
    );
  });

  it('never goes negative even if the book is over-deployed', () => {
    expect(availableBudget(makeBook({ allocatedCapitalInr: 100, deployedInr: 250 }))).toBe(0);
  });
});

describe('canDeploy', () => {
  it('allows an amount within budget, including exactly the remainder', () => {
    const book = makeBook({ allocatedCapitalInr: 100_000, deployedInr: 40_000 });
    expect(canDeploy(book, 1)).toBe(true);
    expect(canDeploy(book, 60_000)).toBe(true);
  });

  it('rejects an amount over budget', () => {
    const book = makeBook({ allocatedCapitalInr: 100_000, deployedInr: 40_000 });
    expect(canDeploy(book, 60_001)).toBe(false);
  });

  it('rejects a disabled book', () => {
    expect(canDeploy(makeBook({ enabled: false }), 1)).toBe(false);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects the amount %s', (amount) => {
    expect(canDeploy(makeBook(), amount)).toBe(false);
  });
});

describe('applyDeployment', () => {
  it('adds to deployedInr and returns a new object', () => {
    const book = makeBook({ allocatedCapitalInr: 100_000, deployedInr: 10_000 });
    const after = applyDeployment(book, 25_000);
    expect(after.deployedInr).toBe(35_000);
    expect(book.deployedInr).toBe(10_000);
    expect(availableBudget(after)).toBe(65_000);
  });

  it('rejects an over-deployment instead of silently clamping', () => {
    const book = makeBook({ allocatedCapitalInr: 100_000, deployedInr: 90_000 });
    expect(() => applyDeployment(book, 20_000)).toThrow(BookBudgetError);
    try {
      applyDeployment(book, 20_000);
    } catch (err) {
      const e = err as BookBudgetError;
      expect(e.bookId).toBe('long_term');
      expect(e.requestedInr).toBe(20_000);
      expect(e.availableInr).toBe(10_000);
      expect(e.message).toContain('has ₹10000 available');
    }
  });

  it('explains a disabled book and a bad amount differently', () => {
    expect(() => applyDeployment(makeBook({ enabled: false }), 1)).toThrow(/is disabled/);
    expect(() => applyDeployment(makeBook(), -5)).toThrow(/positive finite number/);
  });

  it('accumulates across several deployments up to the budget', () => {
    let book = makeBook({ allocatedCapitalInr: 100_000, deployedInr: 0 });
    book = applyDeployment(book, 40_000);
    book = applyDeployment(book, 40_000);
    expect(availableBudget(book)).toBe(20_000);
    expect(() => applyDeployment(book, 20_001)).toThrow(BookBudgetError);
  });
});

describe('applyRelease', () => {
  it('frees budget and books realized P&L', () => {
    const book = makeBook({ deployedInr: 50_000, realizedPnlInr: 1_000 });
    const after = applyRelease(book, 20_000, 3_500);
    expect(after.deployedInr).toBe(30_000);
    expect(after.realizedPnlInr).toBe(4_500);
  });

  it('defaults realized P&L to zero', () => {
    expect(applyRelease(makeBook({ deployedInr: 10 }), 10).realizedPnlInr).toBe(0);
  });

  it('books a loss as a negative P&L', () => {
    expect(applyRelease(makeBook({ deployedInr: 10_000 }), 10_000, -2_000).realizedPnlInr).toBe(
      -2_000,
    );
  });

  it('clamps at zero rather than going negative', () => {
    expect(applyRelease(makeBook({ deployedInr: 5_000 }), 9_000).deployedInr).toBe(0);
  });

  it('rejects nonsense amounts', () => {
    expect(() => applyRelease(makeBook(), -1)).toThrow(BookBudgetError);
    expect(() => applyRelease(makeBook(), Number.NaN)).toThrow(BookBudgetError);
    expect(() => applyRelease(makeBook(), 1, Number.NaN)).toThrow(/finite/);
  });
});

describe('validateAllocations', () => {
  const books = [
    makeBook({ id: 'long_term', allocationPct: 50 }),
    makeBook({ id: 'swing', allocationPct: 30 }),
    makeBook({ id: 'day_trade', allocationPct: 15, product: 'INTRADAY' }),
  ];

  it('accepts Σ allocationPct + reservePct below 100', () => {
    const result = validateAllocations(books, 4);
    expect(result.ok).toBe(true);
    expect(result.totalAllocationPct).toBe(95);
    expect(result.committedPct).toBe(99);
  });

  it('accepts exactly 100', () => {
    const result = validateAllocations(books, 5);
    expect(result.ok).toBe(true);
    expect(result.committedPct).toBe(100);
    expect(result.detail).toContain('≤ 100%');
  });

  it('rejects when the reserve pushes the total over 100', () => {
    const result = validateAllocations(books, 6);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('101% > 100%');
  });

  it('rejects duplicate book ids', () => {
    const result = validateAllocations([books[0]!, books[0]!], 0);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('duplicate book ids: long_term');
  });

  it('rejects an out-of-range reserve', () => {
    expect(validateAllocations(books, -1).ok).toBe(false);
    expect(validateAllocations(books, 101).ok).toBe(false);
    expect(validateAllocations(books, Number.NaN).ok).toBe(false);
  });

  it('rejects a negative allocation', () => {
    const result = validateAllocations([makeBook({ allocationPct: -1 })], 0);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('non-negative');
  });

  it('counts disabled books — their allocation stays reserved', () => {
    const withDisabled = [
      makeBook({ id: 'long_term', allocationPct: 60 }),
      makeBook({ id: 'swing', allocationPct: 50, enabled: false }),
    ];
    expect(validateAllocations(withDisabled, 0).ok).toBe(false);
  });

  it('tolerates float noise in percentages', () => {
    const thirds = [
      makeBook({ id: 'long_term', allocationPct: 33.33 }),
      makeBook({ id: 'swing', allocationPct: 33.33 }),
      makeBook({ id: 'day_trade', allocationPct: 33.34, product: 'INTRADAY' }),
    ];
    expect(validateAllocations(thirds, 0).ok).toBe(true);
  });

  it('assertValidAllocations throws on a bad set', () => {
    expect(() => assertValidAllocations(books, 5)).not.toThrow();
    expect(() => assertValidAllocations(books, 20)).toThrow(BookAllocationError);
  });
});

describe('deriveAllocatedCapital', () => {
  it('is totalManaged × allocationPct / 100', () => {
    expect(deriveAllocatedCapital(1_000_000, makeBook({ allocationPct: 50 }))).toBe(500_000);
    expect(deriveAllocatedCapital(1_000_000, makeBook({ allocationPct: 5 }))).toBe(50_000);
    expect(deriveAllocatedCapital(0, makeBook({ allocationPct: 50 }))).toBe(0);
  });

  it('rejects nonsense capital', () => {
    expect(() => deriveAllocatedCapital(-1, makeBook())).toThrow(BookAllocationError);
    expect(() => deriveAllocatedCapital(Number.NaN, makeBook())).toThrow(BookAllocationError);
  });

  it('recomputes a whole set of books', () => {
    const books = withDerivedAllocations(2_000_000, [
      makeBook({ id: 'long_term', allocationPct: 50, allocatedCapitalInr: 0 }),
      makeBook({ id: 'scalp', allocationPct: 5, allocatedCapitalInr: 0, product: 'INTRADAY' }),
    ]);
    expect(books.map((b) => b.allocatedCapitalInr)).toEqual([1_000_000, 100_000]);
  });
});
