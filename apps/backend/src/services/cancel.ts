/**
 * `POST /v1/orders/:id/cancel` — docs/04 §4.3.
 *
 * Cancelling is the one order-mutating call that does *not* need the guardrail
 * suite: it can only ever reduce exposure. It still needs the owner check, a
 * live broker session, and an audit row.
 */

import { BrokerError } from '@pm/core';
import type { BrokerErrorKind, OrderStatusCode } from '@pm/core';
import type { AuditWriter } from './audit.js';
import type { BrokerGateway, Clock, OrderRepo } from '../ports/index.js';
import { SessionUnavailableError } from '../ports/index.js';

/** Statuses that can still be cancelled at the broker. */
export const CANCELLABLE_STATUSES: readonly OrderStatusCode[] = [
  'SUBMITTED',
  'OPEN',
  'PARTIAL',
  'UNKNOWN',
];

export interface CancelInput {
  uid: string;
  orderId: string;
}

export type CancelResult =
  | { ok: true; orderId: string; status: OrderStatusCode }
  | {
      ok: false;
      reason: 'UNAUTHORIZED' | 'NOT_FOUND' | 'NOT_CANCELLABLE' | 'SESSION_INVALID' | 'BROKER_ERROR';
      detail: string;
      brokerErrorKind?: BrokerErrorKind | undefined;
    };

export interface CancelDeps {
  orders: OrderRepo;
  broker: BrokerGateway;
  audit: AuditWriter;
  clock: Clock;
}

export interface CancelService {
  cancelOrder(input: CancelInput): Promise<CancelResult>;
}

export function createCancelService(deps: CancelDeps): CancelService {
  return {
    async cancelOrder(input: CancelInput): Promise<CancelResult> {
      const record = await deps.orders.get(input.orderId);
      if (record === undefined) {
        return { ok: false, reason: 'NOT_FOUND', detail: `order '${input.orderId}' not found` };
      }
      if (record.uid !== input.uid) {
        return { ok: false, reason: 'UNAUTHORIZED', detail: 'caller is not the owner' };
      }
      if (!CANCELLABLE_STATUSES.includes(record.status)) {
        return {
          ok: false,
          reason: 'NOT_CANCELLABLE',
          detail: `order is ${record.status}`,
        };
      }
      if (record.brokerOrderId === null) {
        return {
          ok: false,
          reason: 'NOT_CANCELLABLE',
          detail: 'order has no broker order id — nothing to cancel',
        };
      }

      let ctx;
      try {
        ctx = await deps.broker.forUser(input.uid);
      } catch (err) {
        const detail =
          err instanceof SessionUnavailableError
            ? err.message
            : `broker unavailable: ${String(err)}`;
        return { ok: false, reason: 'SESSION_INVALID', detail };
      }

      try {
        const ack = await ctx.adapter.cancelOrder(record.brokerOrderId);
        const nowIso = deps.clock.now().toISOString();
        await deps.orders.patch(record.id, { status: 'CANCELLED', updatedAt: nowIso });
        await deps.audit.record({
          uid: input.uid,
          type: 'order.rejected',
          refId: record.id,
          detail: {
            action: 'cancel',
            brokerOrderId: record.brokerOrderId,
            ackStatus: ack.status,
          },
        });
        return { ok: true, orderId: record.id, status: 'CANCELLED' };
      } catch (err) {
        const kind: BrokerErrorKind = err instanceof BrokerError ? err.kind : 'UNKNOWN';
        const detail = err instanceof Error ? err.message : String(err);
        await deps.audit.record({
          uid: input.uid,
          type: 'order.failed',
          refId: record.id,
          detail: { action: 'cancel', kind, detail },
        });
        if (kind === 'AUTH_EXPIRED') {
          return { ok: false, reason: 'SESSION_INVALID', detail, brokerErrorKind: kind };
        }
        return { ok: false, reason: 'BROKER_ERROR', detail, brokerErrorKind: kind };
      }
    },
  };
}
