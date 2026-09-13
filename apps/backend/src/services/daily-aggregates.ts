/**
 * Today's running totals for the `dailyNotional` / `dailyOrderCount` guardrails
 * (docs/04 §4.5).
 *
 * Derived from `orders`, not from a counter: a counter can drift, and the
 * guardrail that stops a runaway day must be computed from the record of what
 * actually left. Conservative by design — a submitted order counts even if it
 * was later cancelled, because it *did* consume a slot in the day's budget.
 */

import { estimateOrderNotionalInr } from '@pm/core';
import type { OrderRecord, TodayAggregates } from '@pm/core';
import { istDayBounds } from '../adapters/firestore/mappers.js';
import type { Clock, DailyAggregates, OrderRepo } from '../ports/index.js';

/** Notional of one order: filled value if known, else the ordered value. */
export function orderNotionalInr(record: OrderRecord): number {
  if (record.filledQty > 0 && record.avgFillPrice !== null) {
    return record.filledQty * record.avgFillPrice;
  }
  return estimateOrderNotionalInr(record.order, undefined) ?? 0;
}

export function summarise(records: readonly OrderRecord[]): TodayAggregates {
  return {
    orderCount: records.length,
    notionalInr: records.reduce((sum, r) => sum + orderNotionalInr(r), 0),
  };
}

export function createDailyAggregates(orders: OrderRepo, clock: Clock): DailyAggregates {
  return {
    async today(uid: string): Promise<TodayAggregates> {
      const { fromIso, toIso } = istDayBounds(clock.now());
      return summarise(await orders.listApprovedBetween(uid, fromIso, toIso));
    },
  };
}
