import { describe, expect, it } from 'vitest';

import { FakeDb, FakeMessaging } from '../test-utils/fakes.js';
import { makeAuditEvent } from '../test-utils/fixtures.js';
import { onAuditEvent } from './onAuditEvent.js';

function deps() {
  return { db: new FakeDb(), messaging: new FakeMessaging() };
}

describe('onAuditEvent', () => {
  it('pushes "Auto-blocked: <reason>" for guardrail.blocked', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const event = makeAuditEvent({
      type: 'guardrail.blocked',
      detail: { reason: 'over daily cap' },
    });

    const result = await onAuditEvent(d, { id: 'a1', path: 'auditLog/a1', data: event });

    expect(result).toEqual({ sent: true });
    expect(d.messaging.sent[0]?.notification.body).toBe('Auto-blocked: over daily cap');
  });

  it('falls back to a default reason when guardrail.blocked has no detail.reason', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const event = makeAuditEvent({ type: 'guardrail.blocked', detail: {} });

    const result = await onAuditEvent(d, { id: 'a1', path: 'auditLog/a1', data: event });

    expect(result).toEqual({ sent: true });
    expect(d.messaging.sent[0]?.notification.body).toBe('Auto-blocked: guardrail check failed');
  });

  it('pushes "Trading halted" for killswitch.toggled → on', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const event = makeAuditEvent({ type: 'killswitch.toggled', detail: { killSwitch: true } });

    const result = await onAuditEvent(d, { id: 'a1', path: 'auditLog/a1', data: event });

    expect(result).toEqual({ sent: true });
    expect(d.messaging.sent[0]?.notification.body).toBe('Trading halted');
  });

  it('pushes "Trading resumed" for killswitch.toggled → off', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const event = makeAuditEvent({ type: 'killswitch.toggled', detail: { killSwitch: false } });

    const result = await onAuditEvent(d, { id: 'a1', path: 'auditLog/a1', data: event });

    expect(result).toEqual({ sent: true });
    expect(d.messaging.sent[0]?.notification.body).toBe('Trading resumed');
  });

  it('pushes for session.expired, naming the broker', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const event = makeAuditEvent({ type: 'session.expired', detail: { broker: 'kite' } });

    const result = await onAuditEvent(d, { id: 'a1', path: 'auditLog/a1', data: event });

    expect(result).toEqual({ sent: true });
    expect(d.messaging.sent[0]?.notification.body).toContain('kite');
  });

  it('pushes for ip.changed, naming the ip', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const event = makeAuditEvent({ type: 'ip.changed', detail: { ip: '203.0.113.5' } });

    const result = await onAuditEvent(d, { id: 'a1', path: 'auditLog/a1', data: event });

    expect(result).toEqual({ sent: true });
    expect(d.messaging.sent[0]?.notification.body).toContain('203.0.113.5');
  });

  it('pushes "Order failed: <reason>" for order.failed, deep-linking to the proposal', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const event = makeAuditEvent({
      type: 'order.failed',
      actor: 'backend',
      refId: 'p1',
      detail: { reason: 'insufficient funds', kind: 'BROKER_REJECTED' },
    });

    const result = await onAuditEvent(d, { id: 'a1', path: 'auditLog/a1', data: event });

    expect(result).toEqual({ sent: true });
    expect(d.messaging.sent[0]?.notification.body).toBe('Order failed: insufficient funds');
    expect(d.messaging.sent[0]?.data['deepLink']).toBe('pm://proposals/p1');
    expect(d.messaging.sent[0]?.data['proposalId']).toBe('p1');
  });

  it('falls back to a default reason when order.failed has no detail.reason', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const event = makeAuditEvent({ type: 'order.failed', refId: 'p1', detail: {} });

    const result = await onAuditEvent(d, { id: 'a1', path: 'auditLog/a1', data: event });

    expect(result).toEqual({ sent: true });
    expect(d.messaging.sent[0]?.notification.body).toBe('Order failed: order placement failed');
  });

  it('ignores order.failed with no refId (nothing to deep-link to)', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const event = makeAuditEvent({
      type: 'order.failed',
      detail: { reason: 'insufficient funds' },
    });

    const result = await onAuditEvent(d, { id: 'a1', path: 'auditLog/a1', data: event });

    expect(result).toEqual({ sent: false });
    expect(d.messaging.sent).toHaveLength(0);
  });

  it('ignores audit types outside the notified set', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const event = makeAuditEvent({ type: 'order.filled' });

    const result = await onAuditEvent(d, { id: 'a1', path: 'auditLog/a1', data: event });

    expect(result).toEqual({ sent: false });
    expect(d.messaging.sent).toHaveLength(0);
  });

  it('no tokens → no send even for a notified type', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: [] });
    const event = makeAuditEvent({ type: 'guardrail.blocked', detail: { reason: 'x' } });

    const result = await onAuditEvent(d, { id: 'a1', path: 'auditLog/a1', data: event });

    expect(result).toEqual({ sent: false });
  });
});
