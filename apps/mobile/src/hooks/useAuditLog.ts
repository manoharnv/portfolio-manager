/**
 * `auditLog/{eventId}` — append-only, client-unreadable except your own
 * (docs/03 §3.7, docs/07 §7.7). Read-only feed; nothing here can write.
 */
import { useMemo } from 'react';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { AuditEventSchema, type AuditEvent, type AuditEventType } from '@pm/core';
import { getDb } from '../lib/firebase';
import { useQuerySnapshot, type Subscription } from './firestore';

export const AUDIT_PAGE_SIZE = 100;

/** Short, human labels for the feed rows. */
export const AUDIT_LABELS: Record<AuditEventType, string> = {
  'proposal.created': 'Proposal created',
  'proposal.approved': 'Proposal approved',
  'proposal.rejected': 'Proposal rejected',
  'proposal.expired': 'Proposal expired',
  'order.submitted': 'Order submitted',
  'order.filled': 'Order filled',
  'order.rejected': 'Order rejected',
  'order.failed': 'Order failed',
  'guardrail.blocked': 'Guardrail blocked',
  'killswitch.toggled': 'Kill switch toggled',
  'config.changed': 'Config changed',
  'session.connected': 'Broker connected',
  'session.expired': 'Broker session expired',
  'ip.changed': 'Order IP changed',
  'auth.login': 'Sign-in',
  'coordinator.blocked': 'Coordinator blocked',
  'coordinator.netted': 'Coordinator netted',
  'coordinator.deferred': 'Coordinator deferred',
};

export function auditLabel(type: string): string {
  return AUDIT_LABELS[type as AuditEventType] ?? type;
}

/** Anything that stopped money moving reads as a warning in the feed. */
const ALERT_TYPES: ReadonlySet<string> = new Set([
  'guardrail.blocked',
  'order.rejected',
  'order.failed',
  'killswitch.toggled',
  'ip.changed',
  'session.expired',
  'coordinator.blocked',
]);

export function isAlert(event: AuditEvent): boolean {
  return ALERT_TYPES.has(event.type);
}

export function useAuditLog(uid: string | undefined): Subscription<AuditEvent[]> {
  const q = useMemo(() => {
    if (uid === undefined) return null;
    return query(
      collection(getDb(), 'auditLog'),
      where('uid', '==', uid),
      orderBy('ts', 'desc'),
      limit(AUDIT_PAGE_SIZE),
    );
  }, [uid]);

  return useQuerySnapshot(q, AuditEventSchema, 'auditLog');
}
