import {
  AdapterNotRegisteredError,
  BrokerError,
  clearBrokerRegistry,
  createAdapter,
  createReadAdapter,
  registeredBrokers,
  type BrokerCreds,
} from '@pm/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDhanAdapter, createDhanReadAdapter, registerDhanAdapter } from './register.js';
import {
  DHAN_FUNDS,
  DHAN_ORDER_ACK,
  EXPECTED_HEADERS,
  FIXED_NOW,
  FakeHttpClient,
  TEST_BASE_URL,
  TEST_SESSION,
  fixedClock,
  makeMaster,
} from './test-utils.js';

const creds: BrokerCreds = {
  broker: 'dhan',
  dhan: { clientId: TEST_SESSION.clientId, accessToken: TEST_SESSION.accessToken },
};

let http: FakeHttpClient;

const deps = (): Parameters<typeof registerDhanAdapter>[0] => ({
  instruments: makeMaster(),
  http,
  clock: fixedClock(),
  baseUrl: TEST_BASE_URL,
  session: () => TEST_SESSION,
});

beforeEach(() => {
  clearBrokerRegistry();
  http = new FakeHttpClient();
});

afterEach(() => {
  clearBrokerRegistry();
});

describe('registerDhanAdapter', () => {
  it('is not an import side-effect — nothing is registered until it is called', () => {
    expect(registeredBrokers('full')).toEqual([]);
    expect(() => createAdapter(creds)).toThrow(AdapterNotRegisteredError);
  });

  it("makes core's createAdapter return a working Dhan adapter", async () => {
    registerDhanAdapter(deps());
    expect(registeredBrokers('full')).toEqual(['dhan']);

    const adapter = createAdapter(creds);
    expect(adapter.broker).toBe('dhan');

    http.respondJson(200, DHAN_ORDER_ACK);
    const ack = await adapter.placeOrder(
      {
        symbol: { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'RELIANCE' },
        side: 'BUY',
        quantity: 10,
        orderType: 'LIMIT',
        product: 'DELIVERY',
        validity: 'DAY',
        limitPrice: 2950.5,
      },
      'prop-0001',
    );
    expect(ack.brokerOrderId).toBe('112111182198');
    expect(http.last.url).toBe(`${TEST_BASE_URL}/orders`);
    expect(http.last.headers).toEqual(EXPECTED_HEADERS);
  });

  it('makes createReadAdapter return a facade with no order methods at runtime', async () => {
    registerDhanAdapter(deps());
    const read = createReadAdapter(creds);
    expect(read.broker).toBe('dhan');
    expect('placeOrder' in read).toBe(false);
    expect('cancelOrder' in read).toBe(false);
    expect(Object.keys(read).sort()).toEqual([
      'broker',
      'getFunds',
      'getHistorical',
      'getHoldings',
      'getPositions',
      'getQuote',
      'getSessionStatus',
      'resolveInstrument',
    ]);

    http.respondJson(200, DHAN_FUNDS);
    await expect(read.getFunds()).resolves.toMatchObject({ availableMargin: 125000.75 });
  });

  it('replaces the previous registration when called twice', () => {
    registerDhanAdapter(deps());
    registerDhanAdapter(deps());
    expect(registeredBrokers('full')).toEqual(['dhan']);
  });
});

describe('createDhanAdapter', () => {
  it('rejects credentials for another broker', () => {
    expect(() => createDhanAdapter({ broker: 'kite' }, deps())).toThrow(
      /Expected dhan credentials/,
    );
  });

  it('fails closed when the daily token is missing or blank', () => {
    for (const bad of [
      { broker: 'dhan' } as BrokerCreds,
      { broker: 'dhan', dhan: { clientId: '', accessToken: 'x' } } as BrokerCreds,
      { broker: 'dhan', dhan: { clientId: 'x', accessToken: '  ' } } as BrokerCreds,
    ]) {
      const err = (() => {
        try {
          createDhanAdapter(bad, deps());
          return undefined;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(BrokerError);
      expect((err as BrokerError).kind).toBe('AUTH_EXPIRED');
    }
  });

  it('reports disconnected when no session resolver supplies an expiry', async () => {
    const { session: _drop, ...rest } = deps();
    const adapter = createDhanAdapter(creds, rest);
    await expect(adapter.getSessionStatus()).resolves.toEqual({ broker: 'dhan', connected: false });
  });

  it('uses BrokerCreds.dhan.expiresAt when no session resolver is supplied', async () => {
    const { session: _drop, ...rest } = deps();
    const future = new Date(FIXED_NOW.getTime() + 6 * 60 * 60 * 1000).toISOString();
    const adapter = createDhanAdapter(
      {
        broker: 'dhan',
        dhan: {
          clientId: TEST_SESSION.clientId,
          accessToken: TEST_SESSION.accessToken,
          expiresAt: future,
        },
      },
      { ...rest, clock: () => FIXED_NOW },
    );
    await expect(adapter.getSessionStatus()).resolves.toEqual({
      broker: 'dhan',
      connected: true,
      expiresAt: future,
    });
  });

  it('fails closed when BrokerCreds.dhan.expiresAt is already in the past', async () => {
    const { session: _drop, ...rest } = deps();
    const past = new Date(FIXED_NOW.getTime() - 60_000).toISOString();
    const adapter = createDhanAdapter(
      {
        broker: 'dhan',
        dhan: {
          clientId: TEST_SESSION.clientId,
          accessToken: TEST_SESSION.accessToken,
          expiresAt: past,
        },
      },
      { ...rest, clock: () => FIXED_NOW },
    );
    await expect(adapter.getSessionStatus()).resolves.toEqual({
      broker: 'dhan',
      connected: false,
      expiresAt: past,
    });
  });

  it('reports the expiry the session resolver provides', async () => {
    const adapter = createDhanAdapter(creds, deps());
    await expect(adapter.getSessionStatus()).resolves.toEqual({
      broker: 'dhan',
      connected: true,
      expiresAt: TEST_SESSION.expiresAt,
    });
  });

  it('defaults the clock and the HTTP client when they are not supplied', () => {
    const adapter = createDhanAdapter(creds, { instruments: makeMaster(), baseUrl: TEST_BASE_URL });
    expect(adapter.broker).toBe('dhan');
  });

  it('forwards the optional deps', async () => {
    const adapter = createDhanAdapter(creds, {
      ...deps(),
      enrichPortfolioPrices: false,
      sessionMarginMs: 1,
      timeoutMs: 1234,
    });
    http.respondJson(200, DHAN_FUNDS);
    await adapter.getFunds();
    expect(http.last.timeoutMs).toBe(1234);
  });
});

describe('createDhanReadAdapter', () => {
  it('returns the read facade directly, without touching the registry', async () => {
    const read = createDhanReadAdapter(creds, deps());
    expect('placeOrder' in read).toBe(false);
    http.respondJson(200, DHAN_FUNDS);
    await expect(read.getFunds()).resolves.toMatchObject({ usedMargin: 4999.25 });
    expect(registeredBrokers('full')).toEqual([]);
  });

  it('still reads the clock through the injected accessor', async () => {
    const read = createDhanReadAdapter(creds, { ...deps(), clock: () => FIXED_NOW });
    await expect(read.getSessionStatus()).resolves.toMatchObject({ connected: true });
  });
});
