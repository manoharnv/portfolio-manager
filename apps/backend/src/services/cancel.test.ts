import { beforeEach, describe, expect, it } from 'vitest';
import { BrokerError } from '@pm/core';
import { SessionUnavailableError } from '../ports/index.js';
import { createAuditWriter } from './audit.js';
import { createCancelService, type CancelService } from './cancel.js';
import {
  FakeAuditLog,
  FakeBrokerAdapter,
  FakeBrokerGateway,
  FakeOrderRepo,
  FixedClock,
  SeqIdGenerator,
} from '../test-utils/fakes.js';
import { makeOrderRecord } from '../test-utils/fixtures.js';

interface Harness {
  service: CancelService;
  orders: FakeOrderRepo;
  auditLog: FakeAuditLog;
  adapter: FakeBrokerAdapter;
  broker: FakeBrokerGateway;
}

function harness(): Harness {
  const clock = new FixedClock('2026-01-13T05:00:00.000Z');
  const orders = new FakeOrderRepo([makeOrderRecord({ status: 'OPEN' })]);
  const auditLog = new FakeAuditLog();
  const adapter = new FakeBrokerAdapter();
  const broker = new FakeBrokerGateway(adapter);
  const service = createCancelService({
    orders,
    broker,
    clock,
    audit: createAuditWriter({ audit: auditLog, ids: new SeqIdGenerator(), clock, ip: '1.2.3.4' }),
  });
  return { service, orders, auditLog, adapter, broker };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('cancelOrder', () => {
  it('cancels an open order at the broker and records it', async () => {
    const result = await h.service.cancelOrder({ uid: 'u1', orderId: 'ord_0001' });

    expect(result).toEqual({ ok: true, orderId: 'ord_0001', status: 'CANCELLED' });
    expect(h.adapter.cancelCalls).toEqual(['BRK-1']);
    expect(await h.orders.get('ord_0001')).toMatchObject({
      status: 'CANCELLED',
      updatedAt: '2026-01-13T05:00:00.000Z',
    });
    expect(h.auditLog.byType('order.rejected')[0]?.detail['action']).toBe('cancel');
  });

  it('refuses a caller who does not own the order', async () => {
    expect(await h.service.cancelOrder({ uid: 'intruder', orderId: 'ord_0001' })).toMatchObject({
      ok: false,
      reason: 'UNAUTHORIZED',
    });
    expect(h.adapter.cancelCalls).toHaveLength(0);
  });

  it('reports a missing order', async () => {
    expect(await h.service.cancelOrder({ uid: 'u1', orderId: 'nope' })).toMatchObject({
      ok: false,
      reason: 'NOT_FOUND',
    });
  });

  it.each(['COMPLETE', 'CANCELLED', 'REJECTED', 'EXPIRED'] as const)(
    'refuses to cancel a %s order',
    async (status) => {
      await h.orders.patch('ord_0001', { status });
      expect(await h.service.cancelOrder({ uid: 'u1', orderId: 'ord_0001' })).toMatchObject({
        ok: false,
        reason: 'NOT_CANCELLABLE',
      });
      expect(h.adapter.cancelCalls).toHaveLength(0);
    },
  );

  it('refuses when the order never reached the broker', async () => {
    await h.orders.patch('ord_0001', { brokerOrderId: null });
    expect(await h.service.cancelOrder({ uid: 'u1', orderId: 'ord_0001' })).toMatchObject({
      ok: false,
      reason: 'NOT_CANCELLABLE',
    });
  });

  it('reports a missing broker session', async () => {
    h.broker.error = new SessionUnavailableError('dhan', 'no token');
    expect(await h.service.cancelOrder({ uid: 'u1', orderId: 'ord_0001' })).toMatchObject({
      ok: false,
      reason: 'SESSION_INVALID',
    });
  });

  it('surfaces a broker error with its kind and leaves the order unchanged', async () => {
    h.adapter.script.throwOn = { cancelOrder: new BrokerError('RATE_LIMITED', 'slow down') };
    const result = await h.service.cancelOrder({ uid: 'u1', orderId: 'ord_0001' });

    expect(result).toMatchObject({
      ok: false,
      reason: 'BROKER_ERROR',
      brokerErrorKind: 'RATE_LIMITED',
    });
    expect(await h.orders.get('ord_0001')).toMatchObject({ status: 'OPEN' });
    expect(h.auditLog.types()).toContain('order.failed');
  });

  it('maps AUTH_EXPIRED to a re-login refusal', async () => {
    h.adapter.script.throwOn = { cancelOrder: new BrokerError('AUTH_EXPIRED', 'token dead') };
    expect(await h.service.cancelOrder({ uid: 'u1', orderId: 'ord_0001' })).toMatchObject({
      ok: false,
      reason: 'SESSION_INVALID',
    });
  });
});
