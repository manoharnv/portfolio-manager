import type { AuditEvent, AuditEventType } from '@pm/core';

import {
  guardrailBlockedPush,
  ipChangedPush,
  killSwitchOffPush,
  killSwitchOnPush,
  orderFailedPush,
  type PushPayload,
  sessionExpiredPush,
} from '../catalogue.js';
import { sendToUser } from '../notify.js';
import type { Db, DocCreatedEvent, Messaging } from '../ports.js';

export interface OnAuditEventResult {
  sent: boolean;
}

type NotifiedAuditType =
  'guardrail.blocked' | 'killswitch.toggled' | 'session.expired' | 'ip.changed' | 'order.failed';

const NOTIFIED_TYPES: readonly NotifiedAuditType[] = [
  'guardrail.blocked',
  'killswitch.toggled',
  'session.expired',
  'ip.changed',
  'order.failed',
];

function isNotifiedType(type: AuditEventType): type is NotifiedAuditType {
  return (NOTIFIED_TYPES as readonly string[]).includes(type);
}

function detailString(detail: Record<string, unknown>, key: string, fallback: string): string {
  const value = detail[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function pushForAuditEvent(event: AuditEvent): PushPayload | undefined {
  if (!isNotifiedType(event.type)) {
    return undefined;
  }
  switch (event.type) {
    case 'guardrail.blocked':
      return guardrailBlockedPush({
        reason: detailString(event.detail, 'reason', 'guardrail check failed'),
      });
    case 'killswitch.toggled':
      return event.detail['killSwitch'] === true ? killSwitchOnPush() : killSwitchOffPush();
    case 'session.expired':
      return sessionExpiredPush({ broker: detailString(event.detail, 'broker', 'broker') });
    case 'ip.changed':
      return ipChangedPush({ ip: detailString(event.detail, 'ip', 'unknown') });
    case 'order.failed':
      // refId is the proposalId (docs task spec: the backend writes this
      // event, actor 'backend', when a placeOrder attempt errors before the
      // broker ever accepted it — no orders/{id} record exists to link to).
      // Optional on the schema; without it there's nothing to deep-link to.
      if (event.refId === undefined) {
        return undefined;
      }
      return orderFailedPush({
        proposalId: event.refId,
        reason: detailString(event.detail, 'reason', 'order placement failed'),
      });
  }
}

/**
 * docs/06 §6.5 "Guardrail blocked" / "Kill switch on" / "Order rejected/failed"
 * (the "failed" half), plus the `session.expired` and `ip.changed` security
 * events from docs/07 §7.7's audit ledger. Audit types outside that set are
 * ignored.
 */
export async function onAuditEvent(
  deps: { db: Db; messaging: Messaging },
  event: DocCreatedEvent<AuditEvent>,
): Promise<OnAuditEventResult> {
  const payload = pushForAuditEvent(event.data);
  if (!payload) {
    return { sent: false };
  }

  const result = await sendToUser(deps, event.data.uid, payload);
  return { sent: result.sent > 0 };
}
