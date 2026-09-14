import { describe, expect, it } from 'vitest';
import {
  guardrailBlockedPush,
  ipChangedPush,
  killSwitchOffPush,
  killSwitchOnPush,
  orderCancelledPush,
  orderFailedPush,
  orderFilledPush,
  orderPartiallyFilledPush,
  orderRejectedPush,
  proposalCreatedPush,
  proposalExpiringSoonPush,
  sessionExpiredPush,
  sessionNeededPush,
} from './catalogue.js';

describe('catalogue — docs/06 §6.5 notification texts (exact rows)', () => {
  it('New proposal', () => {
    const push = proposalCreatedPush({
      proposalId: 'p1',
      side: 'BUY',
      quantity: 10,
      tradingSymbol: 'INFY',
    });
    expect(push.notification.title).toBe('New proposal');
    expect(push.notification.body).toBe('BUY 10 INFY proposed — review');
    expect(push.data).toEqual({
      type: 'proposal',
      proposalId: 'p1',
      deepLink: 'pm://proposals/p1',
    });
  });

  it('Proposal expiring soon', () => {
    const push = proposalExpiringSoonPush({ proposalId: 'p1' });
    expect(push.notification.body).toBe('Proposal expires in 2 min');
    expect(push.data).toEqual({
      type: 'proposal',
      proposalId: 'p1',
      deepLink: 'pm://proposals/p1',
    });
  });

  it('Order filled', () => {
    const push = orderFilledPush({
      orderId: 'o1',
      side: 'SELL',
      filledQty: 5,
      tradingSymbol: 'TCS',
      avgFillPrice: 3910,
    });
    expect(push.notification.body).toBe('SELL 5 TCS filled @ ₹3,910');
    expect(push.data).toEqual({ type: 'order', orderId: 'o1', deepLink: 'pm://orders/o1' });
  });

  it('Order filled — Indian digit grouping above one lakh', () => {
    const push = orderFilledPush({
      orderId: 'o2',
      side: 'BUY',
      filledQty: 100,
      tradingSymbol: 'RELIANCE',
      avgFillPrice: 125_000.5,
    });
    expect(push.notification.body).toBe('BUY 100 RELIANCE filled @ ₹1,25,000.5');
  });

  it('Order rejected/failed — rejected half', () => {
    const push = orderRejectedPush({ orderId: 'o1', reason: 'insufficient funds' });
    expect(push.notification.body).toBe('Order rejected: insufficient funds');
    expect(push.data).toEqual({ type: 'order', orderId: 'o1', deepLink: 'pm://orders/o1' });
  });

  it('Order rejected/failed — failed half (deep-links to the proposal; no order record exists)', () => {
    const push = orderFailedPush({ proposalId: 'p1', reason: 'insufficient funds' });
    expect(push.notification.body).toBe('Order failed: insufficient funds');
    expect(push.data).toEqual({
      type: 'proposal',
      proposalId: 'p1',
      deepLink: 'pm://proposals/p1',
    });
  });

  it('Session needed', () => {
    const push = sessionNeededPush();
    expect(push.notification.body).toBe('Connect your broker for today');
    expect(push.data).toEqual({ type: 'session', deepLink: 'pm://broker-connect' });
  });

  it('Guardrail blocked', () => {
    const push = guardrailBlockedPush({ reason: 'over daily cap' });
    expect(push.notification.body).toBe('Auto-blocked: over daily cap');
    expect(push.data).toEqual({ type: 'audit', deepLink: 'pm://audit' });
  });

  it('Kill switch on', () => {
    const push = killSwitchOnPush();
    expect(push.notification.body).toBe('Trading halted');
    expect(push.data).toEqual({ type: 'killswitch', deepLink: 'pm://dashboard' });
  });
});

describe('catalogue — adjacent, non-table cases used by the handlers', () => {
  it('order partially filled', () => {
    const push = orderPartiallyFilledPush({
      orderId: 'o1',
      side: 'BUY',
      filledQty: 3,
      totalQty: 10,
      tradingSymbol: 'INFY',
    });
    expect(push.notification.body).toBe('BUY 3/10 INFY partially filled');
    expect(push.data).toEqual({ type: 'order', orderId: 'o1', deepLink: 'pm://orders/o1' });
  });

  it('order cancelled', () => {
    const push = orderCancelledPush({ orderId: 'o1', tradingSymbol: 'INFY' });
    expect(push.notification.body).toBe('Order cancelled: INFY');
    expect(push.data).toEqual({ type: 'order', orderId: 'o1', deepLink: 'pm://orders/o1' });
  });

  it('kill switch off', () => {
    const push = killSwitchOffPush();
    expect(push.notification.body).toBe('Trading resumed');
    expect(push.data).toEqual({ type: 'killswitch', deepLink: 'pm://dashboard' });
  });

  it('session expired', () => {
    const push = sessionExpiredPush({ broker: 'dhan' });
    expect(push.notification.body).toBe('Your dhan session expired — reconnect to keep trading');
    expect(push.data).toEqual({ type: 'session', deepLink: 'pm://broker-connect' });
  });

  it('ip changed', () => {
    const push = ipChangedPush({ ip: '203.0.113.10' });
    expect(push.notification.body).toBe('Order IP changed to 203.0.113.10 — review');
    expect(push.data).toEqual({ type: 'audit', deepLink: 'pm://audit' });
  });
});
