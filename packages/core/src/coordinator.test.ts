import { describe, expect, it } from 'vitest';
import { symbolKey } from './domain.js';
import {
  COORDINATOR_DEFAULTS,
  intentKey,
  runCoordinator,
  type CoordinatorInput,
} from './coordinator.js';
import { HORIZONS, type LedgerEntry, type Proposal } from './schemas.js';
import {
  INFY,
  MARKET_OPEN_NOW,
  RELIANCE,
  makeBook,
  makeConfig,
  makeLedgerEntry,
  makeOrder,
  makeProposal,
} from './test-utils.js';

const REL = symbolKey(RELIANCE);

const at = (seconds: number): string =>
  new Date(Date.parse(MARKET_OPEN_NOW) + seconds * 1000).toISOString();

function input(patch: Partial<CoordinatorInput> & { proposals: Proposal[] }): CoordinatorInput {
  return {
    ledger: [],
    config: makeConfig(),
    availableMarginInr: 1_000_000,
    now: MARKET_OPEN_NOW,
    ...patch,
  };
}

/** long_term BUY 10 RELIANCE @ 2950.5 ⇒ ₹29,505 notional. */
const buyLongTerm = (over?: Partial<Proposal>): Proposal =>
  makeProposal({ id: 'p-lt', bookId: 'long_term', horizon: 'long_term', ...over });

describe('defaults', () => {
  it('has netting off and the documented precedence', () => {
    expect(COORDINATOR_DEFAULTS.nettingEnabled).toBe(false);
    expect(COORDINATOR_DEFAULTS.precedence).toEqual([...HORIZONS]);
    expect(COORDINATOR_DEFAULTS.washWindowSeconds).toBe(60);
  });

  it('accepts a clean proposal and stamps the decision', () => {
    const out = runCoordinator(input({ proposals: [buyLongTerm()] }));
    expect(out.accepted).toHaveLength(1);
    expect(out.blocked).toEqual([]);
    expect(out.deferred).toEqual([]);
    expect(out.netted).toEqual([]);
    expect(out.accepted[0]?.coordinator).toMatchObject({ decision: 'accepted' });
    expect(out.accepted[0]?.coordinator?.reason).toContain('long_term/long_term BUY 10');
  });

  it('handles an empty batch', () => {
    const out = runCoordinator(input({ proposals: [] }));
    expect(out).toEqual({ accepted: [], blocked: [], deferred: [], netted: [] });
  });

  it('rejects an unparseable now', () => {
    expect(() => runCoordinator(input({ proposals: [], now: 'soon' }))).toThrow(TypeError);
  });
});

describe('duplicate-intent suppression', () => {
  it('keeps the earliest of two identical intents and blocks the rest', () => {
    const first = buyLongTerm({ id: 'p-first', createdAt: at(0) });
    const second = buyLongTerm({ id: 'p-second', createdAt: at(30) });
    const out = runCoordinator(input({ proposals: [second, first] }));
    expect(out.accepted.map((p) => p.id)).toEqual(['p-first']);
    expect(out.blocked).toHaveLength(1);
    expect(out.blocked[0]?.proposal.id).toBe('p-second');
    expect(out.blocked[0]?.reason).toContain('duplicate_intent');
    expect(out.blocked[0]?.proposal.coordinator?.decision).toBe('blocked');
  });

  it('blocks a candidate whose intent is already live in the inbox', () => {
    const live = buyLongTerm({ id: 'p-live', createdAt: at(-300) });
    const fresh = buyLongTerm({ id: 'p-new' });
    const out = runCoordinator(input({ proposals: [fresh], livePending: [live] }));
    expect(out.accepted).toEqual([]);
    expect(out.blocked[0]?.reason).toContain('a live pending proposal already covers');
  });

  it('does not treat different books or sides as duplicates', () => {
    const a = buyLongTerm({ id: 'a' });
    const b = makeProposal({ id: 'b', bookId: 'swing', horizon: 'swing' });
    expect(intentKey(a)).not.toBe(intentKey(b));
    expect(runCoordinator(input({ proposals: [a, b] })).accepted).toHaveLength(2);
  });
});

describe('product discipline', () => {
  const cncOwned: LedgerEntry[] = [
    makeLedgerEntry({ bookId: 'day_trade', product: 'DELIVERY', qty: 10, price: 2000 }),
  ];

  it('blocks an MIS order that would reference CNC-owned quantity', () => {
    const mis = makeProposal({
      id: 'p-mis',
      bookId: 'day_trade',
      horizon: 'day_trade',
      order: makeOrder({ side: 'SELL', quantity: 10, product: 'INTRADAY' }),
    });
    const out = runCoordinator(input({ proposals: [mis], ledger: cncOwned }));
    expect(out.accepted).toEqual([]);
    expect(out.blocked[0]?.reason).toContain('product_discipline');
    expect(out.blocked[0]?.reason).toContain('holds NSE:EQ:RELIANCE as DELIVERY');
  });

  it('allows the matching CNC exit', () => {
    const cnc = makeProposal({
      id: 'p-cnc',
      bookId: 'day_trade',
      horizon: 'day_trade',
      order: makeOrder({ side: 'SELL', quantity: 10, product: 'DELIVERY' }),
    });
    expect(runCoordinator(input({ proposals: [cnc], ledger: cncOwned })).accepted).toHaveLength(1);
  });

  it('blocks selling delivery stock the book does not own', () => {
    const naked = makeProposal({ id: 'p-naked', order: makeOrder({ side: 'SELL', quantity: 5 }) });
    const out = runCoordinator(input({ proposals: [naked] }));
    expect(out.blocked[0]?.reason).toContain('ownership');
  });

  it('blocks a sell that would half-exit and half-short in one order', () => {
    const ledger = [
      makeLedgerEntry({ bookId: 'day_trade', product: 'INTRADAY', qty: 5, price: 100 }),
    ];
    const p = makeProposal({
      id: 'p-mixed',
      bookId: 'day_trade',
      horizon: 'day_trade',
      order: makeOrder({ side: 'SELL', quantity: 8, product: 'INTRADAY' }),
    });
    const out = runCoordinator(input({ proposals: [p], ledger }));
    expect(out.blocked[0]?.reason).toContain('would both exit and open a short');
  });

  it('allows a fresh short in a leveraged product', () => {
    const p = makeProposal({
      id: 'p-short',
      bookId: 'day_trade',
      horizon: 'day_trade',
      order: makeOrder({ side: 'SELL', quantity: 8, product: 'INTRADAY' }),
    });
    expect(runCoordinator(input({ proposals: [p] })).accepted).toHaveLength(1);
  });
});

describe('self-trade / wash prevention', () => {
  const swingOwnsRel = [makeLedgerEntry({ bookId: 'swing', qty: 10, price: 2000 })];

  const buy = buyLongTerm({ id: 'p-buy', createdAt: at(0) });
  const sell = makeProposal({
    id: 'p-sell',
    bookId: 'swing',
    horizon: 'swing',
    createdAt: at(10),
    order: makeOrder({ side: 'SELL', quantity: 10 }),
  });

  it('blocks BOTH sides when two books oppose each other inside the window', () => {
    const out = runCoordinator(input({ proposals: [buy, sell], ledger: swingOwnsRel }));
    expect(out.accepted).toEqual([]);
    expect(out.blocked.map((b) => b.proposal.id).sort()).toEqual(['p-buy', 'p-sell']);
    for (const b of out.blocked) {
      expect(b.reason).toContain('wash_trade');
      expect(b.reason).toContain(REL);
    }
  });

  it('allows the pair once they are outside the window', () => {
    const later = { ...sell, createdAt: at(120) };
    const out = runCoordinator(input({ proposals: [buy, later], ledger: swingOwnsRel }));
    expect(out.accepted).toHaveLength(2);
  });

  it('respects a configured wash window', () => {
    const later = { ...sell, createdAt: at(120) };
    const out = runCoordinator(
      input({
        proposals: [buy, later],
        ledger: swingOwnsRel,
        config: makeConfig({
          coordinator: {
            nettingEnabled: false,
            washWindowSeconds: 300,
            precedence: [...HORIZONS],
          },
        }),
      }),
    );
    expect(out.accepted).toEqual([]);
    expect(out.blocked).toHaveLength(2);
  });

  it('does not flag opposing orders on different symbols', () => {
    const other = {
      ...sell,
      order: makeOrder({ side: 'SELL', quantity: 10, symbol: INFY }),
    };
    const ledger = [makeLedgerEntry({ bookId: 'swing', symbolKey: symbolKey(INFY), qty: 10 })];
    expect(runCoordinator(input({ proposals: [buy, other], ledger })).accepted).toHaveLength(2);
  });

  it('blocks a candidate that opposes an already-live proposal', () => {
    const live = { ...sell, id: 'p-live' };
    const out = runCoordinator(
      input({ proposals: [buy], ledger: swingOwnsRel, livePending: [live] }),
    );
    expect(out.accepted).toEqual([]);
    expect(out.blocked[0]?.reason).toContain("opposes live proposal 'p-live'");
  });

  it('ignores live proposals that are already resolved', () => {
    const live = { ...sell, id: 'p-live', status: 'filled' as const };
    expect(
      runCoordinator(input({ proposals: [buy], ledger: swingOwnsRel, livePending: [live] }))
        .accepted,
    ).toHaveLength(1);
  });
});

describe('netting', () => {
  const a = buyLongTerm({ id: 'p-a', createdAt: at(0) });
  const b = makeProposal({ id: 'p-b', bookId: 'swing', horizon: 'swing', createdAt: at(5) });
  const nettingOn = makeConfig({
    coordinator: { nettingEnabled: true, washWindowSeconds: 60, precedence: [...HORIZONS] },
  });

  it('is off by default: both orders survive separately', () => {
    const out = runCoordinator(input({ proposals: [a, b] }));
    expect(out.accepted).toHaveLength(2);
    expect(out.netted).toEqual([]);
  });

  it('merges same-side, same-price orders when enabled', () => {
    const out = runCoordinator(input({ proposals: [a, b], config: nettingOn }));
    expect(out.accepted).toHaveLength(1);
    expect(out.accepted[0]?.order.quantity).toBe(20);
    expect(out.accepted[0]?.id).toBe('p-a'); // highest precedence book is the base
    expect(out.accepted[0]?.marketContext.estimatedValueInr).toBe(20 * 2950.5);
    expect(out.netted).toHaveLength(1);
    expect(out.netted[0]?.mergedFrom).toEqual(['p-b']);
    expect(out.netted[0]?.reason).toContain('netted: 2 same-side BUY orders');
    expect(out.accepted[0]?.coordinator).toMatchObject({
      decision: 'netted',
      nettedFrom: ['p-b'],
    });
  });

  it('does not merge orders with different prices or types', () => {
    const different = { ...b, order: makeOrder({ limitPrice: 2951 }) };
    const out = runCoordinator(input({ proposals: [a, different], config: nettingOn }));
    expect(out.accepted).toHaveLength(2);
    expect(out.netted).toEqual([]);
  });
});

describe('precedence and capital arbitration', () => {
  it('serves higher-precedence books first when margin is scarce', () => {
    const lt = buyLongTerm({ id: 'p-lt', createdAt: at(10) });
    const swing = makeProposal({
      id: 'p-swing',
      bookId: 'swing',
      horizon: 'swing',
      createdAt: at(5),
    });
    const scalp = makeProposal({
      id: 'p-scalp',
      bookId: 'scalp',
      horizon: 'scalp',
      createdAt: at(0),
      order: makeOrder({ product: 'INTRADAY' }),
    });

    // Room for two of the three ₹29,505 orders.
    const out = runCoordinator(
      input({ proposals: [scalp, swing, lt], availableMarginInr: 60_000 }),
    );
    expect(out.accepted.map((p) => p.id)).toEqual(['p-lt', 'p-swing']);
    expect(out.deferred.map((d) => d.proposal.id)).toEqual(['p-scalp']);
    expect(out.deferred[0]?.reason).toContain('capital_arbitration');
    expect(out.deferred[0]?.proposal.coordinator?.decision).toBe('deferred');
  });

  it('honours a custom precedence order', () => {
    const lt = buyLongTerm({ id: 'p-lt' });
    const scalp = makeProposal({
      id: 'p-scalp',
      bookId: 'scalp',
      horizon: 'scalp',
      order: makeOrder({ product: 'INTRADAY' }),
    });
    const out = runCoordinator(
      input({
        proposals: [lt, scalp],
        availableMarginInr: 30_000,
        config: makeConfig({
          coordinator: {
            nettingEnabled: false,
            washWindowSeconds: 60,
            precedence: ['scalp', 'day_trade', 'swing', 'long_term'],
          },
        }),
      }),
    );
    expect(out.accepted.map((p) => p.id)).toEqual(['p-scalp']);
    expect(out.deferred.map((d) => d.proposal.id)).toEqual(['p-lt']);
  });

  it('defers everything when there is no margin at all', () => {
    const out = runCoordinator(input({ proposals: [buyLongTerm()], availableMarginInr: 0 }));
    expect(out.accepted).toEqual([]);
    expect(out.deferred).toHaveLength(1);
  });

  it('does not consume margin for a DELIVERY exit', () => {
    const ledger = [makeLedgerEntry({ bookId: 'long_term', qty: 10, price: 2000 })];
    const exit = buyLongTerm({ id: 'p-exit', order: makeOrder({ side: 'SELL', quantity: 10 }) });
    expect(
      runCoordinator(input({ proposals: [exit], ledger, availableMarginInr: 0 })).accepted,
    ).toHaveLength(1);
  });

  it('defers a proposal that would breach its book budget', () => {
    const books = [makeBook({ id: 'long_term', allocatedCapitalInr: 20_000, deployedInr: 0 })];
    const out = runCoordinator(input({ proposals: [buyLongTerm()], books }));
    expect(out.accepted).toEqual([]);
    expect(out.deferred[0]?.reason).toContain('book_budget');
  });

  it('accumulates deployment within a book across a batch', () => {
    const books = [makeBook({ id: 'long_term', allocatedCapitalInr: 40_000 })];
    const a = buyLongTerm({ id: 'p-a', strategyId: 's-a', createdAt: at(0) });
    const b = buyLongTerm({ id: 'p-b', strategyId: 's-b', createdAt: at(5) });
    const out = runCoordinator(input({ proposals: [a, b], books }));
    expect(out.accepted.map((p) => p.id)).toEqual(['p-a']);
    expect(out.deferred[0]?.reason).toContain('book_budget');
  });

  it('skips the budget check when no books are supplied', () => {
    expect(runCoordinator(input({ proposals: [buyLongTerm()] })).accepted).toHaveLength(1);
  });
});
