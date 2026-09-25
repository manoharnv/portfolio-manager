import { describe, expect, it } from 'vitest';
import { NormalizedOrderSchema, symbolKey } from '@pm/core';
import {
  estimateValueInr,
  istDayOfMonth,
  istInstantIso,
  istWeekday,
  limitOrder,
  lotAndTick,
  makeDraft,
  marketOrder,
  ownedInBook,
  qtyForBudget,
  roundDownToLot,
  roundMoney,
  roundToTick,
  stopMarketOrder,
} from './util.js';
import {
  INFY,
  NOW_IST_1000,
  RELIANCE,
  makeInstrument,
  makeLedgerEntry,
} from '../test-utils/index.js';

describe('roundMoney', () => {
  it('removes float dust', () => {
    expect(roundMoney(2950.3500000000004)).toBe(2950.35);
    expect(roundMoney(1 / 3, 2)).toBe(0.33);
  });
});

describe('roundToTick', () => {
  it('snaps to the nearest tick', () => {
    expect(roundToTick(2950.37, 0.05)).toBe(2950.35);
    expect(roundToTick(2950.38, 0.05)).toBe(2950.4);
  });

  it('floors and ceils on demand', () => {
    expect(roundToTick(2950.39, 0.05, 'floor')).toBe(2950.35);
    expect(roundToTick(2950.31, 0.05, 'ceil')).toBe(2950.35);
  });

  it('is a no-op on an exact multiple, in every mode', () => {
    for (const mode of ['nearest', 'floor', 'ceil'] as const) {
      expect(roundToTick(2950.35, 0.05, mode)).toBe(2950.35);
    }
  });

  it('passes the price through when the tick is unusable', () => {
    expect(roundToTick(100.123, 0)).toBe(100.123);
    expect(roundToTick(100.123, Number.NaN)).toBe(100.123);
    expect(roundToTick(Number.NaN, 0.05)).toBeNaN();
  });
});

describe('roundDownToLot', () => {
  it('never rounds up past a lot boundary', () => {
    expect(roundDownToLot(7, 5)).toBe(5);
    expect(roundDownToLot(4, 5)).toBe(0);
    expect(roundDownToLot(10, 5)).toBe(10);
  });

  it('treats a missing/invalid lot size as 1', () => {
    expect(roundDownToLot(7.9, 0)).toBe(7);
    expect(roundDownToLot(7.9, Number.NaN)).toBe(7);
  });

  it('is zero for non-positive quantities', () => {
    expect(roundDownToLot(0, 5)).toBe(0);
    expect(roundDownToLot(-3, 5)).toBe(0);
    expect(roundDownToLot(Number.NaN, 5)).toBe(0);
  });
});

describe('qtyForBudget', () => {
  it('fits whole lots inside the budget', () => {
    expect(qtyForBudget(10_000, 2950, 1)).toBe(3);
    expect(qtyForBudget(20_000, 2950, 5)).toBe(5);
  });

  it('is zero for an unusable budget or price', () => {
    expect(qtyForBudget(0, 2950, 1)).toBe(0);
    expect(qtyForBudget(-1, 2950, 1)).toBe(0);
    expect(qtyForBudget(10_000, 0, 1)).toBe(0);
    expect(qtyForBudget(10_000, Number.NaN, 1)).toBe(0);
    expect(qtyForBudget(Number.POSITIVE_INFINITY, 10, 1)).toBe(0);
  });
});

describe('estimateValueInr', () => {
  it('rounds to paise', () => {
    expect(estimateValueInr(3, 2950.333)).toBe(8851);
  });
});

describe('ownedInBook', () => {
  const ledger = [
    makeLedgerEntry({ bookId: 'long_term', qty: 10 }),
    makeLedgerEntry({ bookId: 'swing', qty: 4, symbolKey: symbolKey(RELIANCE) }),
  ];

  it('reads only the named book', () => {
    expect(ownedInBook(ledger, 'long_term', RELIANCE, 'DELIVERY')).toBe(10);
    expect(ownedInBook(ledger, 'swing', RELIANCE, 'DELIVERY')).toBe(4);
    expect(ownedInBook(ledger, 'day_trade', RELIANCE, 'DELIVERY')).toBe(0);
  });

  it('is zero for a different product or symbol', () => {
    expect(ownedInBook(ledger, 'long_term', RELIANCE, 'INTRADAY')).toBe(0);
    expect(ownedInBook(ledger, 'long_term', INFY, 'DELIVERY')).toBe(0);
  });
});

describe('order builders', () => {
  const base = { symbol: RELIANCE, side: 'BUY', quantity: 10, product: 'DELIVERY' } as const;

  it('builds a schema-valid LIMIT order', () => {
    const order = limitOrder({ ...base, limitPrice: 2950.5 });
    expect(NormalizedOrderSchema.parse(order)).toEqual(order);
    expect(order.triggerPrice).toBeUndefined();
    expect(order.validity).toBe('DAY');
  });

  it('builds a schema-valid MARKET order with no prices at all', () => {
    const order = marketOrder(base);
    expect(NormalizedOrderSchema.parse(order)).toEqual(order);
    expect(order.limitPrice).toBeUndefined();
  });

  it('builds a schema-valid SL-M order with a trigger and no limit', () => {
    const order = stopMarketOrder({ ...base, side: 'SELL', triggerPrice: 2800 });
    expect(NormalizedOrderSchema.parse(order)).toEqual(order);
    expect(order.limitPrice).toBeUndefined();
    expect(order.triggerPrice).toBe(2800);
  });

  it('honours an explicit validity', () => {
    expect(marketOrder({ ...base, validity: 'IOC' }).validity).toBe('IOC');
  });
});

describe('makeDraft', () => {
  const order = limitOrder({
    symbol: RELIANCE,
    side: 'BUY',
    quantity: 10,
    product: 'DELIVERY',
    limitPrice: 2950,
  });

  it('stamps the intent into the signals so it survives into Firestore', () => {
    const draft = makeDraft({
      strategyId: 'dca',
      bookId: 'long_term',
      horizon: 'long_term',
      intent: 'dca',
      order,
      rationale: { summary: 'why', signals: { a: 1 } },
      ltp: 2950,
      capturedAt: NOW_IST_1000,
    });
    expect(draft.rationale.signals).toEqual({ a: 1, intent: 'dca' });
    expect(draft.marketContext).toEqual({
      ltpAtProposal: 2950,
      estimatedValueInr: 29_500,
      capturedAt: NOW_IST_1000,
    });
  });

  it('carries an optional charges estimate', () => {
    const draft = makeDraft({
      strategyId: 'dca',
      bookId: 'long_term',
      horizon: 'long_term',
      intent: 'dca',
      order: marketOrder({ symbol: RELIANCE, side: 'BUY', quantity: 2, product: 'DELIVERY' }),
      rationale: { summary: 'why', signals: {} },
      ltp: 100,
      capturedAt: NOW_IST_1000,
      estimatedCharges: 20,
    });
    expect(draft.marketContext.estimatedCharges).toBe(20);
    // MARKET has no price of its own, so the LTP values it.
    expect(draft.marketContext.estimatedValueInr).toBe(200);
  });
});

describe('lotAndTick', () => {
  it('uses the instrument when it is sane', () => {
    expect(lotAndTick(makeInstrument({ lotSize: 25, tickSize: 0.1 }))).toEqual({
      lotSize: 25,
      tickSize: 0.1,
    });
  });

  it('falls back when the instrument is missing or nonsense', () => {
    expect(lotAndTick(undefined)).toEqual({ lotSize: 1, tickSize: 0.05 });
    expect(lotAndTick(makeInstrument({ lotSize: 0, tickSize: 0 }))).toEqual({
      lotSize: 1,
      tickSize: 0.05,
    });
  });
});

describe('IST calendar helpers', () => {
  it('reads the weekday and day-of-month in IST', () => {
    expect(istWeekday(NOW_IST_1000)).toBe(2); // Tuesday
    expect(istDayOfMonth(NOW_IST_1000)).toBe(13);
    // 19:00 UTC on the 12th is 00:30 IST on the 13th.
    expect(istDayOfMonth('2026-01-12T19:00:00.000Z')).toBe(13);
  });

  it('builds an IST instant with the +05:30 offset', () => {
    expect(istInstantIso('2026-01-13', 9 * 60 + 15)).toBe('2026-01-13T09:15:00.000+05:30');
    expect(new Date(istInstantIso('2026-01-13', 9 * 60 + 15)).toISOString()).toBe(
      '2026-01-13T03:45:00.000Z',
    );
  });
});
