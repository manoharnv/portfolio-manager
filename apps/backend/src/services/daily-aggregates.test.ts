import { describe, expect, it } from 'vitest';
import { createDailyAggregates, orderNotionalInr, summarise } from './daily-aggregates.js';
import { FakeOrderRepo, FixedClock } from '../test-utils/fakes.js';
import { makeOrder, makeOrderRecord } from '../test-utils/fixtures.js';

describe('orderNotionalInr', () => {
  it('uses the actual fill when one is known', () => {
    expect(orderNotionalInr(makeOrderRecord({ filledQty: 4, avgFillPrice: 100 }))).toBe(400);
  });

  it('falls back to the ordered value before a fill', () => {
    expect(orderNotionalInr(makeOrderRecord())).toBe(29_505);
  });

  it('values a market order with no price at zero rather than guessing', () => {
    const record = makeOrderRecord({
      order: makeOrder({ orderType: 'MARKET', limitPrice: undefined }),
    });
    expect(orderNotionalInr(record)).toBe(0);
  });
});

describe('summarise', () => {
  it('counts every order submitted today, terminal or not', () => {
    const records = [
      makeOrderRecord({ id: 'a', filledQty: 10, avgFillPrice: 100 }),
      makeOrderRecord({ id: 'b', status: 'CANCELLED' }),
    ];
    expect(summarise(records)).toEqual({ orderCount: 2, notionalInr: 1_000 + 29_505 });
  });

  it('is zero for an empty day', () => {
    expect(summarise([])).toEqual({ orderCount: 0, notionalInr: 0 });
  });
});

describe('createDailyAggregates', () => {
  it('sums only orders inside the IST trading day', async () => {
    const orders = new FakeOrderRepo([
      // 09:20 IST on the 13th — inside.
      makeOrderRecord({ id: 'a', approvedAt: '2026-01-13T03:50:00.000Z' }),
      // 23:50 IST on the 12th — the previous IST day.
      makeOrderRecord({ id: 'b', approvedAt: '2026-01-12T18:20:00.000Z' }),
    ]);
    const daily = createDailyAggregates(orders, new FixedClock('2026-01-13T04:30:00.000Z'));

    expect(await daily.today('u1', '2026-01-13')).toEqual({
      orderCount: 1,
      notionalInr: 29_505,
    });
  });

  it('includes an order placed just after the IST midnight boundary', async () => {
    // 00:05 IST on the 13th = 18:35 UTC on the 12th.
    const orders = new FakeOrderRepo([
      makeOrderRecord({ id: 'a', approvedAt: '2026-01-12T18:35:00.000Z' }),
    ]);
    const daily = createDailyAggregates(orders, new FixedClock('2026-01-13T04:30:00.000Z'));

    expect((await daily.today('u1', '2026-01-13')).orderCount).toBe(1);
  });
});
