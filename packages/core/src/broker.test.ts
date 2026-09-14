import { afterEach, describe, expect, it } from 'vitest';
import {
  clearBrokerRegistry,
  createAdapter,
  createReadAdapter,
  registerAdapter,
  registerReadAdapter,
  registeredBrokers,
  toReadOnly,
  unregisterBroker,
  type BrokerAdapter,
  type BrokerCreds,
  type BrokerReadAdapter,
} from './broker.js';
import { AdapterNotRegisteredError } from './errors.js';
import type { Broker } from './domain.js';
import { RELIANCE, makeInstrument, makeQuote } from './test-utils.js';

function fakeRead(broker: Broker): BrokerReadAdapter {
  return {
    broker,
    getSessionStatus: () => Promise.resolve({ broker, connected: true }),
    getHoldings: () => Promise.resolve([]),
    getPositions: () => Promise.resolve([]),
    getFunds: () =>
      Promise.resolve({ availableCash: 0, usedMargin: 0, availableMargin: 0, raw: null }),
    resolveInstrument: () => Promise.resolve(makeInstrument({ broker })),
    getQuote: () => Promise.resolve([makeQuote()]),
    getHistorical: () => Promise.resolve([]),
  };
}

let placed = 0;

function fakeFull(broker: Broker): BrokerAdapter {
  return {
    ...fakeRead(broker),
    placeOrder: () => {
      placed += 1;
      return Promise.resolve({ brokerOrderId: 'B1', status: 'SUBMITTED' as const, raw: null });
    },
    modifyOrder: () =>
      Promise.resolve({ brokerOrderId: 'B1', status: 'SUBMITTED' as const, raw: null }),
    cancelOrder: () =>
      Promise.resolve({ brokerOrderId: 'B1', status: 'CANCELLED' as const, raw: null }),
    getOrder: () =>
      Promise.resolve({
        brokerOrderId: 'B1',
        status: 'COMPLETE' as const,
        filledQty: 1,
        pendingQty: 0,
        updatedAt: '2026-01-13T04:30:00.000Z',
        raw: null,
      }),
    listOrders: () => Promise.resolve([]),
  };
}

const dhanCreds: BrokerCreds = {
  broker: 'dhan',
  dhan: { clientId: '10000001', accessToken: 'jwt' },
};

afterEach(() => {
  clearBrokerRegistry();
  placed = 0;
});

describe('adapter registry', () => {
  it('createAdapter throws a clear error for an unregistered broker', () => {
    expect(() => createAdapter(dhanCreds)).toThrow(AdapterNotRegisteredError);
    expect(() => createAdapter(dhanCreds)).toThrow(/No full \(read\+write\) broker adapter/);
    expect(() => createAdapter(dhanCreds)).toThrow(/@pm\/broker-dhan/);
  });

  it('createReadAdapter throws a clear error for an unregistered broker', () => {
    expect(() =>
      createReadAdapter({ broker: 'kite', kite: { apiKey: 'k', accessToken: 'a' } }),
    ).toThrow(AdapterNotRegisteredError);
  });

  it('createAdapter refuses a broker that only registered a READ adapter', () => {
    registerReadAdapter('dhan', () => fakeRead('dhan'));
    expect(createReadAdapter(dhanCreds).broker).toBe('dhan');
    expect(() => createAdapter(dhanCreds)).toThrow(AdapterNotRegisteredError);
  });

  it('createAdapter returns the full adapter once registered', async () => {
    registerAdapter('dhan', () => fakeFull('dhan'));
    const adapter = createAdapter(dhanCreds);
    await adapter.placeOrder(
      {
        symbol: RELIANCE,
        side: 'BUY',
        quantity: 1,
        orderType: 'MARKET',
        product: 'DELIVERY',
        validity: 'DAY',
      },
      'idem-1',
    );
    expect(placed).toBe(1);
  });

  it('createReadAdapter hands back a facade without order methods', () => {
    registerAdapter('dhan', () => fakeFull('dhan'));
    const read = createReadAdapter(dhanCreds);
    for (const method of ['placeOrder', 'modifyOrder', 'cancelOrder', 'getOrder', 'listOrders']) {
      expect(method in (read as unknown as Record<string, unknown>)).toBe(false);
    }
    expect(read.broker).toBe('dhan');
  });

  it('toReadOnly forwards every read method', async () => {
    const read = toReadOnly(fakeFull('dhan'));
    await expect(read.getSessionStatus()).resolves.toEqual({ broker: 'dhan', connected: true });
    await expect(read.getHoldings()).resolves.toEqual([]);
    await expect(read.getPositions()).resolves.toEqual([]);
    await expect(read.getFunds()).resolves.toMatchObject({ availableMargin: 0 });
    await expect(read.getQuote([RELIANCE])).resolves.toHaveLength(1);
    await expect(
      read.getHistorical({ symbol: RELIANCE, interval: '1d', from: 'a', to: 'b' }),
    ).resolves.toEqual([]);
    await expect(read.resolveInstrument(RELIANCE)).resolves.toMatchObject({ lotSize: 1 });
  });

  it('tracks and clears registrations', () => {
    registerAdapter('dhan', () => fakeFull('dhan'));
    registerReadAdapter('kite', () => fakeRead('kite'));
    expect(registeredBrokers('read')).toEqual(['dhan', 'kite']);
    expect(registeredBrokers('full')).toEqual(['dhan']);
    expect(registeredBrokers()).toEqual(['dhan', 'kite']);

    unregisterBroker('kite');
    expect(registeredBrokers('read')).toEqual(['dhan']);

    clearBrokerRegistry();
    expect(registeredBrokers('read')).toEqual([]);
  });
});

describe('read/write type split', () => {
  it('BrokerReadAdapter has no placeOrder at the type level', () => {
    registerReadAdapter('dhan', () => fakeRead('dhan'));
    const read = createReadAdapter(dhanCreds);
    // @ts-expect-error — a read-only adapter must not expose placeOrder.
    const forbidden: unknown = read.placeOrder;
    expect(forbidden).toBeUndefined();
  });

  it('a full adapter is still assignable to the read surface', () => {
    const full: BrokerAdapter = fakeFull('dhan');
    const asRead: BrokerReadAdapter = full;
    expect(asRead.broker).toBe('dhan');
  });
});
