import { describe, expect, it } from 'vitest';
import { BrokerError, toReadOnly } from '@pm/core';
import { SimulatedOrderExecutor } from './simulator.js';
import { FakeBrokerAdapter, FixedClock } from './test-utils/fakes.js';
import { MARKET_OPEN_NOW, makeOrder, makeQuote } from './test-utils/fixtures.js';

function setup(fillAfterMs = 2_000): {
  sim: SimulatedOrderExecutor;
  clock: FixedClock;
  real: FakeBrokerAdapter;
} {
  const clock = new FixedClock(MARKET_OPEN_NOW);
  const real = new FakeBrokerAdapter({ quotes: [makeQuote({ ltp: 2951 })] });
  const sim = new SimulatedOrderExecutor({ read: toReadOnly(real), clock, fillAfterMs });
  return { sim, clock, real };
}

describe('SimulatedOrderExecutor', () => {
  it('acks with SUBMITTED and a synthetic broker order id', async () => {
    const { sim } = setup();
    const ack = await sim.placeOrder(makeOrder(), 'idem-1');

    expect(ack.status).toBe('SUBMITTED');
    expect(ack.brokerOrderId).toMatch(/^SIM-\d{6}$/);
    expect(ack.raw).toMatchObject({ simulated: true, idempotencyKey: 'idem-1' });
  });

  it('mints a fresh id per order', async () => {
    const { sim } = setup();
    const a = await sim.placeOrder(makeOrder(), 'idem-1');
    const b = await sim.placeOrder(makeOrder(), 'idem-2');
    expect(a.brokerOrderId).not.toBe(b.brokerOrderId);
  });

  it('fills at the live LTP only once the clock has passed fillAfterMs', async () => {
    const { sim, clock } = setup(2_000);
    const ack = await sim.placeOrder(makeOrder({ quantity: 7 }), 'idem-1');

    expect((await sim.getOrder(ack.brokerOrderId)).status).toBe('SUBMITTED');
    clock.advance(1_999);
    const midway = await sim.getOrder(ack.brokerOrderId);
    expect(midway.status).toBe('OPEN');
    expect(midway.filledQty).toBe(0);

    clock.advance(1);
    const filled = await sim.getOrder(ack.brokerOrderId);
    expect(filled.status).toBe('COMPLETE');
    expect(filled.filledQty).toBe(7);
    expect(filled.pendingQty).toBe(0);
    expect(filled.avgPrice).toBe(2951);
  });

  it('fills immediately when fillAfterMs is zero', async () => {
    const { sim } = setup(0);
    const ack = await sim.placeOrder(makeOrder(), 'idem-1');
    expect((await sim.getOrder(ack.brokerOrderId)).status).toBe('COMPLETE');
  });

  it('stays OPEN rather than inventing a price when no quote is available', async () => {
    const clock = new FixedClock(MARKET_OPEN_NOW);
    const real = new FakeBrokerAdapter({ quotes: [] });
    const sim = new SimulatedOrderExecutor({ read: toReadOnly(real), clock, fillAfterMs: 0 });

    const ack = await sim.placeOrder(makeOrder(), 'idem-1');
    expect((await sim.getOrder(ack.brokerOrderId)).status).toBe('OPEN');
  });

  it('stays OPEN when the quote lookup throws', async () => {
    const clock = new FixedClock(MARKET_OPEN_NOW);
    const real = new FakeBrokerAdapter({
      throwOn: { getQuote: new BrokerError('NETWORK', 'quote feed down') },
    });
    const sim = new SimulatedOrderExecutor({ read: toReadOnly(real), clock, fillAfterMs: 0 });

    const ack = await sim.placeOrder(makeOrder(), 'idem-1');
    expect((await sim.getOrder(ack.brokerOrderId)).status).toBe('OPEN');
  });

  it('cancels an order placed before its fill instant', async () => {
    const { sim, clock } = setup(5_000);
    const ack = await sim.placeOrder(makeOrder(), 'idem-1');

    clock.advance(1_000);
    const cancelAck = await sim.cancelOrder(ack.brokerOrderId);
    expect(cancelAck.status).toBe('CANCELLED');

    clock.advance(10_000);
    const after = await sim.getOrder(ack.brokerOrderId);
    expect(after.status).toBe('CANCELLED');
    expect(after.filledQty).toBe(0);
  });

  it('refuses to cancel an order that already filled', async () => {
    const { sim, clock } = setup(1_000);
    const ack = await sim.placeOrder(makeOrder(), 'idem-1');
    clock.advance(2_000);

    await expect(sim.cancelOrder(ack.brokerOrderId)).rejects.toBeInstanceOf(BrokerError);
  });

  it('modifies an open order and refuses once terminal', async () => {
    const { sim, clock } = setup(1_000);
    const ack = await sim.placeOrder(makeOrder(), 'idem-1');

    const modified = await sim.modifyOrder(ack.brokerOrderId, { limitPrice: 2960 });
    expect(modified.status).toBe('SUBMITTED');

    clock.advance(2_000);
    await expect(sim.modifyOrder(ack.brokerOrderId, { limitPrice: 2970 })).rejects.toBeInstanceOf(
      BrokerError,
    );
  });

  it('lists every simulated order with its current status', async () => {
    const { sim, clock } = setup(1_000);
    await sim.placeOrder(makeOrder(), 'idem-1');
    clock.advance(2_000);
    await sim.placeOrder(makeOrder({ quantity: 3 }), 'idem-2');

    const listed = await sim.listOrders();
    expect(listed).toHaveLength(2);
    expect(listed.map((o) => o.status).sort()).toEqual(['COMPLETE', 'SUBMITTED']);
  });

  it('throws a typed error for an unknown order id', async () => {
    const { sim } = setup();
    await expect(sim.getOrder('nope')).rejects.toBeInstanceOf(BrokerError);
    await expect(sim.cancelOrder('nope')).rejects.toThrow(/Unknown simulated order/);
  });

  it('delegates every read to the wrapped adapter', async () => {
    const { sim, real } = setup();
    expect(sim.broker).toBe(real.broker);
    expect(await sim.getSessionStatus()).toEqual(await real.getSessionStatus());
    expect(await sim.getHoldings()).toEqual([]);
    expect(await sim.getPositions()).toEqual([]);
    expect(await sim.getFunds()).toEqual(await real.getFunds());
    expect(
      await sim.getHistorical({ symbol: makeOrder().symbol, interval: '1d', from: '', to: '' }),
    ).toEqual([]);
    const inst = await sim.resolveInstrument(makeOrder().symbol);
    expect(inst.lotSize).toBe(1);
  });
});
