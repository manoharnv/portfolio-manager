import { describe, expect, it } from 'vitest';

import { FakeDb, FakeMessaging } from '../test-utils/fakes.js';
import { makeOrderRecord } from '../test-utils/fixtures.js';
import { onOrderUpdated } from './onOrderUpdated.js';

function deps() {
  return { db: new FakeDb(), messaging: new FakeMessaging() };
}

describe('onOrderUpdated', () => {
  it('pushes "Order filled" when status changes to COMPLETE', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const before = makeOrderRecord({ status: 'OPEN', filledQty: 0 });
    const after = makeOrderRecord({ status: 'COMPLETE', filledQty: 5, avgFillPrice: 3910 });

    const result = await onOrderUpdated(d, { id: 'o1', path: 'orders/o1', before, after });

    expect(result).toEqual({ sent: true });
    expect(d.messaging.sent[0]?.notification.body).toBe('SELL 5 TCS filled @ ₹3,910');
    expect(d.messaging.sent[0]?.data['deepLink']).toBe('pm://orders/o1');
  });

  it('defaults avgFillPrice to 0 when COMPLETE but the broker reported none', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const before = makeOrderRecord({ status: 'OPEN' });
    const after = makeOrderRecord({ status: 'COMPLETE', avgFillPrice: null });

    const result = await onOrderUpdated(d, { id: 'o1', path: 'orders/o1', before, after });

    expect(result).toEqual({ sent: true });
    expect(d.messaging.sent[0]?.notification.body).toContain('₹0');
  });

  it('pushes on a partial fill', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const before = makeOrderRecord({ status: 'OPEN', filledQty: 0 });
    const after = makeOrderRecord({ status: 'PARTIAL', filledQty: 2 });

    const result = await onOrderUpdated(d, { id: 'o1', path: 'orders/o1', before, after });

    expect(result).toEqual({ sent: true });
    expect(d.messaging.sent[0]?.notification.body).toBe('SELL 2/5 TCS partially filled');
  });

  it('pushes "Order rejected" with the broker-supplied reason', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const before = makeOrderRecord({ status: 'OPEN' });
    const after = makeOrderRecord({ status: 'REJECTED', rejectionReason: 'insufficient funds' });

    const result = await onOrderUpdated(d, { id: 'o1', path: 'orders/o1', before, after });

    expect(result).toEqual({ sent: true });
    expect(d.messaging.sent[0]?.notification.body).toBe('Order rejected: insufficient funds');
  });

  it('falls back to a default rejection reason when the broker gave none', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const before = makeOrderRecord({ status: 'OPEN' });
    const after = makeOrderRecord({ status: 'REJECTED', rejectionReason: null });

    const result = await onOrderUpdated(d, { id: 'o1', path: 'orders/o1', before, after });

    expect(result).toEqual({ sent: true });
    expect(d.messaging.sent[0]?.notification.body).toBe('Order rejected: rejected by broker');
  });

  it('pushes "Order cancelled" when status changes to CANCELLED', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const before = makeOrderRecord({ status: 'OPEN' });
    const after = makeOrderRecord({ status: 'CANCELLED' });

    const result = await onOrderUpdated(d, { id: 'o1', path: 'orders/o1', before, after });

    expect(result).toEqual({ sent: true });
    expect(d.messaging.sent[0]?.notification.body).toBe('Order cancelled: TCS');
  });

  it('no-ops when the status is unchanged', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const before = makeOrderRecord({ status: 'OPEN', filledQty: 2 });
    const after = makeOrderRecord({ status: 'OPEN', filledQty: 2 });

    const result = await onOrderUpdated(d, { id: 'o1', path: 'orders/o1', before, after });

    expect(result).toEqual({ sent: false });
    expect(d.messaging.sent).toHaveLength(0);
  });

  it('no-ops for a status change outside the notified set', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const before = makeOrderRecord({ status: 'SUBMITTED' });
    const after = makeOrderRecord({ status: 'OPEN' });

    const result = await onOrderUpdated(d, { id: 'o1', path: 'orders/o1', before, after });

    expect(result).toEqual({ sent: false });
    expect(d.messaging.sent).toHaveLength(0);
  });

  it('no tokens → no send even for a notified status change', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: [] });
    const before = makeOrderRecord({ status: 'OPEN' });
    const after = makeOrderRecord({ status: 'COMPLETE' });

    const result = await onOrderUpdated(d, { id: 'o1', path: 'orders/o1', before, after });

    expect(result).toEqual({ sent: false });
  });
});
