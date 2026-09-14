import type { OrderRecord } from '@pm/core';
import * as logger from 'firebase-functions/logger';

import {
  orderCancelledPush,
  orderFilledPush,
  orderPartiallyFilledPush,
  orderRejectedPush,
  type PushPayload,
} from '../catalogue.js';
import { sendToUser } from '../notify.js';
import type { Db, DocUpdatedEvent, Messaging } from '../ports.js';

export interface OnOrderUpdatedResult {
  sent: boolean;
}

function pushForStatus(orderId: string, after: OrderRecord): PushPayload | undefined {
  const tradingSymbol = after.order.symbol.tradingSymbol;
  switch (after.status) {
    case 'COMPLETE':
      return orderFilledPush({
        orderId,
        side: after.order.side,
        filledQty: after.filledQty,
        tradingSymbol,
        avgFillPrice: after.avgFillPrice ?? 0,
      });
    case 'PARTIAL':
      return orderPartiallyFilledPush({
        orderId,
        side: after.order.side,
        filledQty: after.filledQty,
        totalQty: after.order.quantity,
        tradingSymbol,
      });
    case 'CANCELLED':
      return orderCancelledPush({ orderId, tradingSymbol });
    case 'REJECTED':
      return orderRejectedPush({
        orderId,
        reason: after.rejectionReason ?? 'rejected by broker',
      });
    default:
      return undefined;
  }
}

/**
 * docs/06 §6.5 "Order filled" / "Order rejected/failed". Fires on `orders/{id}`
 * status changes to `COMPLETE` / `REJECTED` / `CANCELLED` / `PARTIAL` (a
 * partial fill); no-op if the status did not change, or changed to a status
 * this catalogue doesn't push for (e.g. `SUBMITTED` → `OPEN`).
 */
export async function onOrderUpdated(
  deps: { db: Db; messaging: Messaging },
  event: DocUpdatedEvent<OrderRecord>,
): Promise<OnOrderUpdatedResult> {
  const { before, after } = event;

  if (before.status === after.status) {
    return { sent: false };
  }

  const payload = pushForStatus(event.id, after);
  if (!payload) {
    logger.info('onOrderUpdated: status change not in the notified set, skipping', {
      orderId: event.id,
      from: before.status,
      to: after.status,
    });
    return { sent: false };
  }

  const result = await sendToUser(deps, after.uid, payload);
  return { sent: result.sent > 0 };
}
