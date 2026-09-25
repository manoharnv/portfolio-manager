/**
 * docs/06-mobile-app.md §6.5 — the notification catalogue, expressed as pure
 * functions of the event. Every function here is total and side-effect free:
 * given the same input it returns the same `PushPayload`. `notify.ts` is the
 * only consumer that actually sends anything.
 *
 * The seven functions marked "docs/06 §6.5 row" reproduce that table's "Push"
 * text and "Deep link" column verbatim for the table's own example values —
 * see `catalogue.test.ts`. The rest fill in adjacent cases the handlers need
 * (a partial fill, a cancelled order, kill-switch-off, …) that aren't literal
 * rows in the table but belong to the same families.
 */

import type { Side } from '@pm/core';

export interface PushPayload {
  notification: { title: string; body: string };
  /** FCM data payload — string values only, per the Admin SDK's `MulticastMessage`. */
  data: Record<string, string>;
}

/**
 * `₹3,910`-style formatting with Indian digit grouping, matching the docs/06
 * §6.5 example text exactly. NOT the same as `@pm/core`'s `formatInr` (which
 * intentionally omits digit grouping) — this one is presentation-only, for a
 * push notification body, so it lives here rather than in `packages/core`.
 */
function formatInrAmount(n: number): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n);
}

// ---------------------------------------------------------------------------
// docs/06 §6.5 row: "New proposal" → "BUY 10 INFY proposed — review" → proposal detail
// ---------------------------------------------------------------------------
export function proposalCreatedPush(params: {
  proposalId: string;
  side: Side;
  quantity: number;
  tradingSymbol: string;
}): PushPayload {
  const deepLink = `pm://proposals/${params.proposalId}`;
  return {
    notification: {
      title: 'New proposal',
      body: `${params.side} ${params.quantity} ${params.tradingSymbol} proposed — review`,
    },
    data: { type: 'proposal', proposalId: params.proposalId, deepLink },
  };
}

// ---------------------------------------------------------------------------
// docs/06 §6.5 row: "Proposal expiring soon" → "Proposal expires in 2 min" → proposal detail
// ---------------------------------------------------------------------------
export function proposalExpiringSoonPush(params: { proposalId: string }): PushPayload {
  const deepLink = `pm://proposals/${params.proposalId}`;
  return {
    notification: { title: 'Proposal expiring soon', body: 'Proposal expires in 2 min' },
    data: { type: 'proposal', proposalId: params.proposalId, deepLink },
  };
}

// ---------------------------------------------------------------------------
// docs/06 §6.5 row: "Order filled" → "SELL 5 TCS filled @ ₹3,910" → order detail
// ---------------------------------------------------------------------------
export function orderFilledPush(params: {
  orderId: string;
  side: Side;
  filledQty: number;
  tradingSymbol: string;
  avgFillPrice: number;
}): PushPayload {
  const deepLink = `pm://orders/${params.orderId}`;
  return {
    notification: {
      title: 'Order filled',
      body: `${params.side} ${params.filledQty} ${params.tradingSymbol} filled @ ₹${formatInrAmount(params.avgFillPrice)}`,
    },
    data: { type: 'order', orderId: params.orderId, deepLink },
  };
}

/** Same family as "Order filled" — used by `onOrderUpdated` for a `PARTIAL` fill. */
export function orderPartiallyFilledPush(params: {
  orderId: string;
  side: Side;
  filledQty: number;
  totalQty: number;
  tradingSymbol: string;
}): PushPayload {
  const deepLink = `pm://orders/${params.orderId}`;
  return {
    notification: {
      title: 'Order partially filled',
      body: `${params.side} ${params.filledQty}/${params.totalQty} ${params.tradingSymbol} partially filled`,
    },
    data: { type: 'order', orderId: params.orderId, deepLink },
  };
}

// ---------------------------------------------------------------------------
// docs/06 §6.5 row: "Order rejected/failed" → "Order rejected: insufficient funds" → order detail
// ---------------------------------------------------------------------------
export function orderRejectedPush(params: { orderId: string; reason: string }): PushPayload {
  const deepLink = `pm://orders/${params.orderId}`;
  return {
    notification: { title: 'Order rejected', body: `Order rejected: ${params.reason}` },
    data: { type: 'order', orderId: params.orderId, deepLink },
  };
}

/**
 * Same table row as {@link orderRejectedPush} ("rejected/failed") — the "failed"
 * half, used by `onAuditEvent` for the `order.failed` audit type (a placeOrder
 * attempt that errored before the broker ever accepted it). Deep-links to the
 * *proposal*, not an order — a failed placement never produces an `orders/{id}`
 * record to link to.
 */
export function orderFailedPush(params: { proposalId: string; reason: string }): PushPayload {
  const deepLink = `pm://proposals/${params.proposalId}`;
  return {
    notification: { title: 'Order failed', body: `Order failed: ${params.reason}` },
    data: { type: 'proposal', proposalId: params.proposalId, deepLink },
  };
}

/** Same family as "Order rejected/failed" — used by `onOrderUpdated` for `CANCELLED`. */
export function orderCancelledPush(params: {
  orderId: string;
  tradingSymbol: string;
}): PushPayload {
  const deepLink = `pm://orders/${params.orderId}`;
  return {
    notification: { title: 'Order cancelled', body: `Order cancelled: ${params.tradingSymbol}` },
    data: { type: 'order', orderId: params.orderId, deepLink },
  };
}

// ---------------------------------------------------------------------------
// docs/06 §6.5 row: "Session needed" → "Connect your broker for today" → broker connect
// ---------------------------------------------------------------------------
export function sessionNeededPush(): PushPayload {
  const deepLink = 'pm://broker-connect';
  return {
    notification: { title: 'Session needed', body: 'Connect your broker for today' },
    data: { type: 'session', deepLink },
  };
}

/** Same family as "Session needed" — used by `onAuditEvent` for the `session.expired` audit type. */
export function sessionExpiredPush(params: { broker: string }): PushPayload {
  const deepLink = 'pm://broker-connect';
  return {
    notification: {
      title: 'Session expired',
      body: `Your ${params.broker} session expired — reconnect to keep trading`,
    },
    data: { type: 'session', deepLink },
  };
}

// ---------------------------------------------------------------------------
// docs/06 §6.5 row: "Guardrail blocked" → "Auto-blocked: over daily cap" → audit
// ---------------------------------------------------------------------------
export function guardrailBlockedPush(params: { reason: string }): PushPayload {
  const deepLink = 'pm://audit';
  return {
    notification: { title: 'Guardrail blocked', body: `Auto-blocked: ${params.reason}` },
    data: { type: 'audit', deepLink },
  };
}

/** Same family as "Guardrail blocked" — used by `onAuditEvent` for the `ip.changed` audit type. */
export function ipChangedPush(params: { ip: string }): PushPayload {
  const deepLink = 'pm://audit';
  return {
    notification: { title: 'Security alert', body: `Order IP changed to ${params.ip} — review` },
    data: { type: 'audit', deepLink },
  };
}

// ---------------------------------------------------------------------------
// docs/06 §6.5 row: "Kill switch on" → "Trading halted" → dashboard
// ---------------------------------------------------------------------------
export function killSwitchOnPush(): PushPayload {
  const deepLink = 'pm://dashboard';
  return {
    notification: { title: 'Kill switch on', body: 'Trading halted' },
    data: { type: 'killswitch', deepLink },
  };
}

/** The natural counterpart `onAuditEvent` needs for `killswitch.toggled` → false. Not a docs/06 row. */
export function killSwitchOffPush(): PushPayload {
  const deepLink = 'pm://dashboard';
  return {
    notification: { title: 'Kill switch off', body: 'Trading resumed' },
    data: { type: 'killswitch', deepLink },
  };
}
