import { describe, expect, it } from 'vitest';
import { BrokerError, UnsupportedMappingError, type NormalizedOrder } from '@pm/core';
import { KiteAdapter, type KiteAdapterDeps } from './adapter.js';
import { OrderValidationError } from './errors.js';
import { KITE_BASE_URL } from './wire.js';
import { KITE_TAG_MAX_LENGTH, kiteTagFor } from './tag.js';
import {
  FakeHttpClient,
  NFO_NIFTY_CE,
  NSE_RELIANCE,
  fixedClock,
  makeLoadedInstrumentMaster,
  makeSession,
  sampleHistoricalResponse,
  sampleHoldingsResponse,
  sampleMarginsResponse,
  sampleOrderHistoryResponse,
  sampleOrderIdResponse,
  sampleOrdersListResponse,
  samplePositionsResponse,
  sampleQuoteResponse,
} from './test-utils.js';

function makeAdapter(http: FakeHttpClient, overrides?: Partial<KiteAdapterDeps>): KiteAdapter {
  return new KiteAdapter({
    http,
    instruments: makeLoadedInstrumentMaster(),
    session: () => makeSession(),
    clock: fixedClock(),
    ...overrides,
  });
}

function baseOrder(patch?: Partial<NormalizedOrder>): NormalizedOrder {
  return {
    symbol: NSE_RELIANCE,
    side: 'BUY',
    quantity: 10,
    orderType: 'MARKET',
    product: 'DELIVERY',
    validity: 'DAY',
    ...patch,
  };
}

describe('KiteAdapter', () => {
  it('reports broker = "kite"', () => {
    expect(makeAdapter(new FakeHttpClient()).broker).toBe('kite');
  });

  describe('getSessionStatus', () => {
    it('is connected when now is before expiresAt (no network probe)', async () => {
      const http = new FakeHttpClient();
      const adapter = makeAdapter(http, {
        session: () => makeSession({ expiresAt: '2026-01-13T18:30:00.000Z' }),
        clock: fixedClock('2026-01-13T04:30:00.000Z'),
      });
      const status = await adapter.getSessionStatus();
      expect(status).toEqual({
        broker: 'kite',
        connected: true,
        expiresAt: '2026-01-13T18:30:00.000Z',
      });
      expect(http.requests).toHaveLength(0);
    });

    it('is disconnected once now reaches expiresAt', async () => {
      const http = new FakeHttpClient();
      const adapter = makeAdapter(http, {
        session: () => makeSession({ expiresAt: '2026-01-13T18:30:00.000Z' }),
        clock: fixedClock('2026-01-13T18:30:00.000Z'),
      });
      const status = await adapter.getSessionStatus();
      expect(status.connected).toBe(false);
    });

    it('is disconnected well past expiresAt', async () => {
      const adapter = makeAdapter(new FakeHttpClient(), {
        session: () => makeSession({ expiresAt: '2026-01-13T18:30:00.000Z' }),
        clock: fixedClock('2026-01-14T00:00:00.000Z'),
      });
      expect((await adapter.getSessionStatus()).connected).toBe(false);
    });
  });

  describe('resolveInstrument', () => {
    it('resolves a known symbol with zero HTTP calls', async () => {
      const http = new FakeHttpClient();
      const ref = await makeAdapter(http).resolveInstrument(NSE_RELIANCE);
      expect(ref.brokerInstrumentId).toBe('738561');
      expect(http.requests).toHaveLength(0);
    });

    it('rejects with BrokerError(INSTRUMENT_UNKNOWN) for an unknown symbol', async () => {
      const http = new FakeHttpClient();
      const adapter = makeAdapter(http);
      await expect(
        adapter.resolveInstrument({ exchange: 'NSE', segment: 'EQ', tradingSymbol: 'NOPE' }),
      ).rejects.toMatchObject({ kind: 'INSTRUMENT_UNKNOWN' });
      expect(http.requests).toHaveLength(0);
    });
  });

  describe('placeOrder', () => {
    it('resolves the instrument, tags the order, and POSTs it', async () => {
      const http = new FakeHttpClient();
      http.enqueue(sampleOrderIdResponse('OID1'));
      const ack = await makeAdapter(http).placeOrder(baseOrder(), 'idempotency-key-1');

      expect(ack).toEqual({
        brokerOrderId: 'OID1',
        status: 'SUBMITTED',
        raw: { order_id: 'OID1' },
      });
      expect(http.requests).toHaveLength(1);
      expect(http.requests[0]?.url).toBe(`${KITE_BASE_URL}/orders/regular`);
    });

    it('derives the Kite tag deterministically from the idempotency key, ≤20 chars', async () => {
      const http = new FakeHttpClient();
      http.enqueue(sampleOrderIdResponse());
      const idemKey = 'a-very-long-idempotency-key-that-will-not-fit-in-twenty-characters';
      await makeAdapter(http).placeOrder(baseOrder(), idemKey);

      const body = http.requests[0]?.body ?? '';
      const tagMatch = /tag=([^&]+)/.exec(body);
      expect(tagMatch).not.toBeNull();
      const tag = tagMatch?.[1] ?? '';
      expect(tag.length).toBeLessThanOrEqual(KITE_TAG_MAX_LENGTH);
      expect(tag).toBe(kiteTagFor(idemKey));
    });

    it('rejects with OrderValidationError(LOT_SIZE) before any HTTP call', async () => {
      const http = new FakeHttpClient();
      const order = baseOrder({ symbol: NFO_NIFTY_CE, quantity: 10 }); // lot size is 25
      const promise = makeAdapter(http).placeOrder(order, 'k1');
      await expect(promise).rejects.toBeInstanceOf(OrderValidationError);
      await expect(promise).rejects.toMatchObject({ reason: 'LOT_SIZE' });
      expect(http.requests).toHaveLength(0);
    });

    it('rejects with OrderValidationError(TICK_SIZE) for an off-grid limitPrice, before any HTTP call', async () => {
      const http = new FakeHttpClient();
      const order = baseOrder({ orderType: 'LIMIT', limitPrice: 2950.53 }); // tick size is 0.05
      const promise = makeAdapter(http).placeOrder(order, 'k1');
      await expect(promise).rejects.toMatchObject({ reason: 'TICK_SIZE' });
      expect(http.requests).toHaveLength(0);
    });

    it('rejects with OrderValidationError(TICK_SIZE) for an off-grid triggerPrice, before any HTTP call', async () => {
      const http = new FakeHttpClient();
      const order = baseOrder({ orderType: 'SL', limitPrice: 2950.5, triggerPrice: 2900.03 });
      const promise = makeAdapter(http).placeOrder(order, 'k1');
      await expect(promise).rejects.toMatchObject({ reason: 'TICK_SIZE' });
      expect(http.requests).toHaveLength(0);
    });

    it('accepts a price exactly on the tick grid', async () => {
      const http = new FakeHttpClient();
      http.enqueue(sampleOrderIdResponse());
      const order = baseOrder({ orderType: 'LIMIT', limitPrice: 2950.55 }); // 59011 * 0.05
      await expect(makeAdapter(http).placeOrder(order, 'k1')).resolves.toBeDefined();
      expect(http.requests).toHaveLength(1);
    });

    it('rejects with BrokerError(INSTRUMENT_UNKNOWN) before any HTTP call', async () => {
      const http = new FakeHttpClient();
      const order = baseOrder({
        symbol: { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'NOPE' },
      });
      const promise = makeAdapter(http).placeOrder(order, 'k1');
      await expect(promise).rejects.toBeInstanceOf(BrokerError);
      await expect(promise).rejects.toMatchObject({ kind: 'INSTRUMENT_UNKNOWN' });
      expect(http.requests).toHaveLength(0);
    });

    it('rejects MTF with UnsupportedMappingError and ZERO HTTP calls', async () => {
      const http = new FakeHttpClient();
      const order = baseOrder({ product: 'MTF' });
      await expect(makeAdapter(http).placeOrder(order, 'k1')).rejects.toBeInstanceOf(
        UnsupportedMappingError,
      );
      expect(http.requests).toHaveLength(0);
    });

    it('checks lot/tick validation before the (later) product mapping step', async () => {
      // An MTF order that ALSO fails lot-size should still fail closed — the
      // exact error identity doesn't matter here, only that nothing reaches HTTP.
      const http = new FakeHttpClient();
      const order = baseOrder({ symbol: NFO_NIFTY_CE, product: 'MTF', quantity: 1 });
      await expect(makeAdapter(http).placeOrder(order, 'k1')).rejects.toBeInstanceOf(Error);
      expect(http.requests).toHaveLength(0);
    });
  });

  describe('modifyOrder', () => {
    it('maps a NormalizedOrder patch onto Kite modify fields', async () => {
      const http = new FakeHttpClient();
      http.enqueue(sampleOrderIdResponse('OID9'));
      const ack = await makeAdapter(http).modifyOrder('OID9', { quantity: 15, validity: 'IOC' });
      expect(http.requests[0]?.url).toBe(`${KITE_BASE_URL}/orders/regular/OID9`);
      expect(http.requests[0]?.body).toBe('quantity=15&validity=IOC');
      expect(ack.brokerOrderId).toBe('OID9');
    });

    it('ignores fields Kite cannot modify (symbol/side/product)', async () => {
      const http = new FakeHttpClient();
      http.enqueue(sampleOrderIdResponse());
      await makeAdapter(http).modifyOrder('OID1', {
        symbol: NFO_NIFTY_CE,
        side: 'SELL',
        product: 'INTRADAY',
        quantity: 25,
      });
      expect(http.requests[0]?.body).toBe('quantity=25');
    });
  });

  it('cancelOrder DELETEs and reports CANCELLED', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleOrderIdResponse('OID5'));
    const ack = await makeAdapter(http).cancelOrder('OID5');
    expect(http.requests[0]?.method).toBe('DELETE');
    expect(ack).toEqual({ brokerOrderId: 'OID5', status: 'CANCELLED', raw: { order_id: 'OID5' } });
  });

  it('getOrder fetches the order history and returns the latest entry', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleOrderHistoryResponse());
    const status = await makeAdapter(http).getOrder('OID1');
    expect(http.requests[0]?.url).toBe(`${KITE_BASE_URL}/orders/OID1`);
    expect(status.brokerOrderId).toBe('151220000000000');
  });

  it('listOrders fetches the flat order list', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleOrdersListResponse());
    const list = await makeAdapter(http).listOrders();
    expect(http.requests[0]?.url).toBe(`${KITE_BASE_URL}/orders`);
    expect(list).toHaveLength(1);
  });

  it('getHoldings fetches /portfolio/holdings', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleHoldingsResponse());
    const holdings = await makeAdapter(http).getHoldings();
    expect(http.requests[0]?.url).toBe(`${KITE_BASE_URL}/portfolio/holdings`);
    expect(holdings).toHaveLength(1);
  });

  it('getPositions fetches /portfolio/positions', async () => {
    const http = new FakeHttpClient();
    http.enqueue(samplePositionsResponse());
    const positions = await makeAdapter(http).getPositions();
    expect(http.requests[0]?.url).toBe(`${KITE_BASE_URL}/portfolio/positions`);
    expect(positions).toHaveLength(1);
  });

  it('getFunds fetches /user/margins', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleMarginsResponse());
    const funds = await makeAdapter(http).getFunds();
    expect(http.requests[0]?.url).toBe(`${KITE_BASE_URL}/user/margins`);
    expect(funds.availableCash).toBe(500_000);
  });

  it('getQuote fetches /quote for the given symbols', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleQuoteResponse());
    const [quote] = await makeAdapter(http).getQuote([NSE_RELIANCE]);
    expect(http.requests[0]?.url).toBe(`${KITE_BASE_URL}/quote?i=NSE%3ARELIANCE`);
    expect(quote?.symbol).toEqual(NSE_RELIANCE);
  });

  describe('getHistorical', () => {
    it('resolves the instrument token and fetches historical candles', async () => {
      const http = new FakeHttpClient();
      http.enqueue(sampleHistoricalResponse());
      const candles = await makeAdapter(http).getHistorical({
        symbol: NSE_RELIANCE,
        interval: '1d',
        from: '2026-01-12T00:00:00.000Z',
        to: '2026-01-13T00:00:00.000Z',
      });
      expect(http.requests[0]?.url).toContain('/instruments/historical/738561/day');
      expect(candles).toHaveLength(2);
    });

    it('rejects with BrokerError(INSTRUMENT_UNKNOWN) before any HTTP call', async () => {
      const http = new FakeHttpClient();
      const promise = makeAdapter(http).getHistorical({
        symbol: { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'NOPE' },
        interval: '1d',
        from: '2026-01-12T00:00:00.000Z',
        to: '2026-01-13T00:00:00.000Z',
      });
      await expect(promise).rejects.toMatchObject({ kind: 'INSTRUMENT_UNKNOWN' });
      expect(http.requests).toHaveLength(0);
    });
  });
});
