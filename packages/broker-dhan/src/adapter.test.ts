import {
  BrokerError,
  UnsupportedMappingError,
  type NormalizedOrder,
  type OrderType,
  type Product,
  type Side,
} from '@pm/core';
import { describe, expect, it } from 'vitest';
import { DHAN_CORRELATION_ID_MAX_LENGTH, DhanAdapter, toIstParts } from './adapter.js';
import {
  DHAN_AUTH_ERROR,
  DHAN_CHART,
  DHAN_CHART_ISO,
  DHAN_FUNDS,
  DHAN_HOLDINGS,
  DHAN_HOLDINGS_NO_LTP,
  DHAN_INSTRUMENT_ERROR,
  DHAN_IP_ERROR,
  DHAN_ORDER_ACK,
  DHAN_ORDER_ROW,
  DHAN_POSITIONS,
  DHAN_QUOTE,
  DHAN_RATE_LIMIT_ERROR,
  EXPECTED_HEADERS,
  FIXED_NOW,
  FakeHttpClient,
  NIFTY_CE,
  RELIANCE,
  TEST_BASE_URL,
  TEST_SESSION,
  UNKNOWN_SYMBOL,
  jsonResponse,
  makeAdapter,
} from './test-utils.js';

const order = (patch: Partial<NormalizedOrder> = {}): NormalizedOrder => ({
  symbol: RELIANCE,
  side: 'BUY',
  quantity: 10,
  orderType: 'LIMIT',
  product: 'DELIVERY',
  validity: 'DAY',
  limitPrice: 2950.5,
  ...patch,
});

const KEY = 'prop-0001';

// ---------------------------------------------------------------------------
// Contract: one test per docs/02 §2.6 endpoint row
// ---------------------------------------------------------------------------

describe('endpoint contracts', () => {
  it('placeOrder → POST /v2/orders with the docs/02 §2.6 body', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_ORDER_ACK)),
    });
    const ack = await adapter.placeOrder(order(), KEY);

    expect(http.count).toBe(1);
    expect(http.last.method).toBe('POST');
    expect(http.last.url).toBe(`${TEST_BASE_URL}/orders`);
    expect(http.last.headers).toEqual(EXPECTED_HEADERS);
    expect(http.bodyAt(0)).toEqual({
      dhanClientId: TEST_SESSION.clientId,
      transactionType: 'BUY',
      exchangeSegment: 'NSE_EQ',
      productType: 'CNC',
      orderType: 'LIMIT',
      validity: 'DAY',
      securityId: '11536',
      quantity: 10,
      price: 2950.5,
      triggerPrice: 0,
      disclosedQuantity: 0,
      correlationId: KEY,
    });
    expect(ack).toEqual({ brokerOrderId: '112111182198', status: 'OPEN', raw: DHAN_ORDER_ACK });
  });

  it('modifyOrder → PUT /v2/orders/{id}', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_ORDER_ACK)),
    });
    await adapter.modifyOrder('112111182198', {
      orderType: 'LIMIT',
      validity: 'DAY',
      quantity: 5,
      limitPrice: 2951,
      symbol: RELIANCE,
    });
    expect(http.last.method).toBe('PUT');
    expect(http.last.url).toBe(`${TEST_BASE_URL}/orders/112111182198`);
    expect(http.last.headers).toEqual(EXPECTED_HEADERS);
    expect(http.bodyAt(0)).toEqual({
      dhanClientId: TEST_SESSION.clientId,
      orderId: '112111182198',
      orderType: 'LIMIT',
      validity: 'DAY',
      quantity: 5,
      price: 2951,
    });
  });

  it('cancelOrder → DELETE /v2/orders/{id}', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(
        jsonResponse(200, { orderId: '112111182198', orderStatus: 'CANCELLED' }),
      ),
    });
    const ack = await adapter.cancelOrder('112111182198');
    expect(http.last).toEqual({
      method: 'DELETE',
      url: `${TEST_BASE_URL}/orders/112111182198`,
      headers: EXPECTED_HEADERS,
    });
    expect(ack.status).toBe('CANCELLED');
  });

  it('getOrder → GET /v2/orders/{id}', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_ORDER_ROW)),
    });
    const status = await adapter.getOrder('112111182198');
    expect(http.last.method).toBe('GET');
    expect(http.last.url).toBe(`${TEST_BASE_URL}/orders/112111182198`);
    expect(status).toMatchObject({
      brokerOrderId: '112111182198',
      status: 'PARTIAL',
      filledQty: 4,
    });
  });

  it('listOrders → GET /v2/orders', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, [DHAN_ORDER_ROW])),
    });
    const orders = await adapter.listOrders();
    expect(http.last).toEqual({
      method: 'GET',
      url: `${TEST_BASE_URL}/orders`,
      headers: EXPECTED_HEADERS,
    });
    expect(orders).toHaveLength(1);
  });

  it('getHoldings → GET /v2/holdings', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_HOLDINGS)),
    });
    const holdings = await adapter.getHoldings();
    expect(http.last).toEqual({
      method: 'GET',
      url: `${TEST_BASE_URL}/holdings`,
      headers: EXPECTED_HEADERS,
    });
    expect(holdings).toEqual([
      {
        symbol: RELIANCE,
        quantity: 20,
        avgCostPrice: 2900,
        lastPrice: 2950,
        pnl: 1000,
        raw: expect.objectContaining({ securityId: '11536' }) as unknown,
      },
    ]);
  });

  it('getPositions → GET /v2/positions', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_POSITIONS), jsonResponse(200, DHAN_QUOTE)),
    });
    const positions = await adapter.getPositions();
    expect(http.at(0)).toEqual({
      method: 'GET',
      url: `${TEST_BASE_URL}/positions`,
      headers: EXPECTED_HEADERS,
    });
    expect(positions[0]).toMatchObject({
      symbol: RELIANCE,
      netQty: 10,
      product: 'INTRADAY',
      avgPrice: 2900,
      lastPrice: 2950.5,
      unrealizedPnl: 500,
    });
  });

  it('getFunds → GET /v2/fundlimit', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_FUNDS)),
    });
    const funds = await adapter.getFunds();
    expect(http.last).toEqual({
      method: 'GET',
      url: `${TEST_BASE_URL}/fundlimit`,
      headers: EXPECTED_HEADERS,
    });
    expect(funds).toMatchObject({ availableMargin: 125000.75, usedMargin: 4999.25 });
  });

  it('getHistorical (1d) → POST /v2/charts/historical with IST dates', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_CHART)),
    });
    const candles = await adapter.getHistorical({
      symbol: RELIANCE,
      interval: '1d',
      from: '2026-01-01T03:45:00.000Z',
      to: '2026-01-13T10:00:00.000Z',
    });
    expect(http.last.url).toBe(`${TEST_BASE_URL}/charts/historical`);
    expect(http.last.headers).toEqual(EXPECTED_HEADERS);
    expect(http.bodyAt(0)).toEqual({
      securityId: '11536',
      exchangeSegment: 'NSE_EQ',
      instrument: 'EQUITY',
      expiryCode: 0,
      oi: false,
      fromDate: '2026-01-01',
      toDate: '2026-01-13',
    });
    expect(candles.map((c) => c.ts)).toEqual(DHAN_CHART_ISO);
  });

  it('getHistorical (intraday) → POST /v2/charts/intraday with the minute interval', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_CHART)),
    });
    await adapter.getHistorical({
      symbol: NIFTY_CE,
      interval: '5m',
      from: '2026-01-13T03:45:00.000Z',
      to: '2026-01-13T10:00:00.000Z',
    });
    expect(http.last.url).toBe(`${TEST_BASE_URL}/charts/intraday`);
    expect(http.bodyAt(0)).toEqual({
      securityId: '46285',
      exchangeSegment: 'NSE_FNO',
      instrument: 'OPTIDX',
      interval: '5',
      oi: false,
      fromDate: '2026-01-13 09:15:00',
      toDate: '2026-01-13 15:30:00',
    });
  });

  it.each([
    ['1m', '1'],
    ['5m', '5'],
    ['15m', '15'],
    ['1h', '60'],
  ] as const)('maps the %s interval to Dhan %s', async (interval, expected) => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_CHART)),
    });
    await adapter.getHistorical({
      symbol: RELIANCE,
      interval,
      from: '2026-01-13T03:45:00.000Z',
      to: '2026-01-13T10:00:00.000Z',
    });
    expect((http.bodyAt(0) as { interval: string }).interval).toBe(expected);
  });

  it('getQuote → POST /v2/marketfeed/quote keyed by segment', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_QUOTE)),
    });
    const quotes = await adapter.getQuote([RELIANCE]);
    expect(http.last.url).toBe(`${TEST_BASE_URL}/marketfeed/quote`);
    expect(http.last.headers).toEqual(EXPECTED_HEADERS);
    expect(http.bodyAt(0)).toEqual({ NSE_EQ: [11536] });
    expect(quotes[0]).toMatchObject({ symbol: RELIANCE, ltp: 2950.5, volume: 1234567 });
  });

  it('getQuote groups several symbols and makes no call for an empty list', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_QUOTE)),
    });
    await adapter.getQuote([RELIANCE, NIFTY_CE]);
    expect(http.bodyAt(0)).toEqual({ NSE_EQ: [11536], NSE_FNO: [46285] });

    const empty = makeAdapter();
    await expect(empty.adapter.getQuote([])).resolves.toEqual([]);
    expect(empty.http.count).toBe(0);
  });

  it('resolveInstrument delegates to the master', async () => {
    const { adapter, http } = makeAdapter();
    await expect(adapter.resolveInstrument(RELIANCE)).resolves.toMatchObject({
      broker: 'dhan',
      brokerInstrumentId: '11536',
      lotSize: 1,
      tickSize: 0.05,
    });
    await expect(adapter.resolveInstrument(UNKNOWN_SYMBOL)).rejects.toBeInstanceOf(BrokerError);
    expect(http.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// placeOrder matrix
// ---------------------------------------------------------------------------

describe('placeOrder — order type × side × product', () => {
  const patches: Record<OrderType, Partial<NormalizedOrder>> = {
    MARKET: { orderType: 'MARKET' },
    LIMIT: { orderType: 'LIMIT', limitPrice: 2950.5 },
    SL: { orderType: 'SL', limitPrice: 2950.5, triggerPrice: 2950 },
    'SL-M': { orderType: 'SL-M', triggerPrice: 2950 },
  };
  const expectedTypes: Record<OrderType, string> = {
    MARKET: 'MARKET',
    LIMIT: 'LIMIT',
    SL: 'STOP_LOSS',
    'SL-M': 'STOP_LOSS_MARKET',
  };
  const expectedProducts: Record<Product, string> = {
    DELIVERY: 'CNC',
    INTRADAY: 'INTRADAY',
    MARGIN: 'MARGIN',
    MTF: 'MTF',
  };

  const rows: [OrderType, Side, Product][] = [
    ['MARKET', 'BUY', 'DELIVERY'],
    ['MARKET', 'SELL', 'INTRADAY'],
    ['LIMIT', 'BUY', 'INTRADAY'],
    ['LIMIT', 'SELL', 'DELIVERY'],
    ['SL', 'BUY', 'MARGIN'],
    ['SL', 'SELL', 'INTRADAY'],
    ['SL-M', 'BUY', 'DELIVERY'],
    ['SL-M', 'SELL', 'MARGIN'],
    ['LIMIT', 'BUY', 'MTF'],
  ];

  it.each(rows)('%s %s %s', async (orderType, side, product) => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_ORDER_ACK)),
    });
    await adapter.placeOrder(order({ ...patches[orderType], side, product }), KEY);

    const body = http.bodyAt(0) as Record<string, unknown>;
    expect(body['orderType']).toBe(expectedTypes[orderType]);
    expect(body['transactionType']).toBe(side);
    expect(body['productType']).toBe(expectedProducts[product]);
    // MARKET/SL-M carry no limit price; MARKET/LIMIT carry no trigger.
    expect(body['price']).toBe(orderType === 'LIMIT' || orderType === 'SL' ? 2950.5 : 0);
    expect(body['triggerPrice']).toBe(orderType === 'SL' || orderType === 'SL-M' ? 2950 : 0);
  });

  it('maps IOC validity and the FNO segment', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_ORDER_ACK)),
    });
    await adapter.placeOrder(
      order({ symbol: NIFTY_CE, quantity: 150, validity: 'IOC', product: 'MARGIN' }),
      KEY,
    );
    expect(http.bodyAt(0)).toMatchObject({
      exchangeSegment: 'NSE_FNO',
      validity: 'IOC',
      securityId: '46285',
      quantity: 150,
    });
  });

  it('propagates the idempotency key as correlationId', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_ORDER_ACK)),
    });
    await adapter.placeOrder(order(), 'idem-abc-123');
    expect((http.bodyAt(0) as { correlationId: string }).correlationId).toBe('idem-abc-123');
  });

  it('sends the disclosed quantity, defaulting to 0', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(
        jsonResponse(200, DHAN_ORDER_ACK),
        jsonResponse(200, DHAN_ORDER_ACK),
      ),
    });
    await adapter.placeOrder(order({ quantity: 100, disclosedQuantity: 25 }), KEY);
    expect((http.bodyAt(0) as { disclosedQuantity: number }).disclosedQuantity).toBe(25);
    await adapter.placeOrder(order(), KEY);
    expect((http.bodyAt(1) as { disclosedQuantity: number }).disclosedQuantity).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pre-flight refusals — nothing may reach the wire
// ---------------------------------------------------------------------------

describe('placeOrder refuses before any HTTP call', () => {
  const reject = async (
    patch: Partial<NormalizedOrder>,
    key = KEY,
    match?: RegExp,
  ): Promise<void> => {
    const { adapter, http } = makeAdapter();
    const err = await adapter.placeOrder(order(patch), key).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerError);
    if (match !== undefined) expect((err as BrokerError).message).toMatch(match);
    expect(http.count).toBe(0);
  };

  it('quantity that is not a multiple of the lot size', async () => {
    await reject({ symbol: NIFTY_CE, quantity: 100 }, KEY, /not a multiple of the lot size 75/);
  });

  it('quantity that is zero, negative or fractional', async () => {
    await reject({ quantity: 0 }, KEY, /positive integer/);
    await reject({ quantity: -5 }, KEY, /positive integer/);
    await reject({ quantity: 1.5 }, KEY, /positive integer/);
  });

  it('limit price off the tick grid', async () => {
    await reject({ limitPrice: 2950.53 }, KEY, /not on the 0.05 tick grid/);
  });

  it('trigger price off the tick grid', async () => {
    await reject(
      { orderType: 'SL-M', limitPrice: undefined, triggerPrice: 2950.53 },
      KEY,
      /triggerPrice .* tick grid/,
    );
  });

  it('a missing price the order type requires', async () => {
    await reject({ orderType: 'LIMIT', limitPrice: undefined }, KEY, /need a positive limitPrice/);
    await reject(
      { orderType: 'SL', limitPrice: 2950.5, triggerPrice: undefined },
      KEY,
      /need a positive triggerPrice/,
    );
    await reject({ orderType: 'LIMIT', limitPrice: 0 }, KEY, /need a positive limitPrice/);
  });

  it('a disclosed quantity that is negative or larger than the order', async () => {
    await reject({ disclosedQuantity: -1 }, KEY, /non-negative integer/);
    await reject({ quantity: 10, disclosedQuantity: 11 }, KEY, /exceeds quantity/);
  });

  it('an empty or over-long idempotency key', async () => {
    await reject({}, '   ', /idempotencyKey is required/);
    await reject({}, 'x'.repeat(DHAN_CORRELATION_ID_MAX_LENGTH + 1), /correlationId holds 25/);
  });

  it('an instrument that is not in the master', async () => {
    const { adapter, http } = makeAdapter();
    const err = await adapter
      .placeOrder(order({ symbol: UNKNOWN_SYMBOL }), KEY)
      .catch((e: unknown) => e);
    expect((err as BrokerError).kind).toBe('INSTRUMENT_UNKNOWN');
    expect(http.count).toBe(0);
  });

  it('a product the broker cannot express', async () => {
    const { adapter, http } = makeAdapter();
    await expect(
      adapter.placeOrder(order({ product: 'NONSENSE' as Product }), KEY),
    ).rejects.toBeInstanceOf(UnsupportedMappingError);
    expect(http.count).toBe(0);
  });

  it('an empty broker order id on modify/cancel/get', async () => {
    const { adapter, http } = makeAdapter();
    await expect(adapter.modifyOrder('', { orderType: 'LIMIT', validity: 'DAY' })).rejects.toThrow(
      /brokerOrderId is required/,
    );
    await expect(adapter.cancelOrder(' ')).rejects.toThrow(/brokerOrderId is required/);
    await expect(adapter.getOrder('')).rejects.toThrow(/brokerOrderId is required/);
    expect(http.count).toBe(0);
  });

  it('a modify patch without orderType and validity', async () => {
    const { adapter, http } = makeAdapter();
    await expect(adapter.modifyOrder('1', { quantity: 5 })).rejects.toThrow(
      /requires orderType and validity/,
    );
    expect(http.count).toBe(0);
  });

  it('a modify patch whose quantity or price breaks the instrument grid', async () => {
    const { adapter, http } = makeAdapter();
    const base = { orderType: 'LIMIT', validity: 'DAY', symbol: NIFTY_CE } as const;
    await expect(adapter.modifyOrder('1', { ...base, quantity: 100 })).rejects.toThrow(
      /not a multiple of the lot size 75/,
    );
    await expect(
      adapter.modifyOrder('1', { ...base, symbol: RELIANCE, limitPrice: 2950.53 }),
    ).rejects.toThrow(/limitPrice 2950.53 is not on the 0.05 tick grid/);
    await expect(
      adapter.modifyOrder('1', { ...base, symbol: RELIANCE, triggerPrice: 2950.53 }),
    ).rejects.toThrow(/triggerPrice 2950.53 is not on the 0.05 tick grid/);
    expect(http.count).toBe(0);
  });

  it('but skips grid checks when the patch does not name the instrument', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_ORDER_ACK)),
    });
    await adapter.modifyOrder('1', {
      orderType: 'SL',
      validity: 'IOC',
      limitPrice: 123.456,
      triggerPrice: 123.457,
      disclosedQuantity: 1,
    });
    expect(http.bodyAt(0)).toMatchObject({
      orderType: 'STOP_LOSS',
      validity: 'IOC',
      price: 123.456,
      triggerPrice: 123.457,
      disclosedQuantity: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('error mapping and retry policy', () => {
  it('maps an auth failure and sends exactly one request (never retried)', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(401, DHAN_AUTH_ERROR)),
    });
    const err = await adapter.placeOrder(order(), KEY).catch((e: unknown) => e);
    expect((err as BrokerError).kind).toBe('AUTH_EXPIRED');
    expect(http.count).toBe(1);
  });

  it('maps an IP rejection, sends one request, and records staticIpOk=false', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(403, DHAN_IP_ERROR)),
    });
    const err = await adapter.placeOrder(order(), KEY).catch((e: unknown) => e);
    expect((err as BrokerError).kind).toBe('IP_NOT_WHITELISTED');
    expect(http.count).toBe(1);
    await expect(adapter.getSessionStatus()).resolves.toMatchObject({ staticIpOk: false });
  });

  it('records staticIpOk=true after an order call succeeds', async () => {
    const { adapter } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_ORDER_ACK)),
    });
    await expect(adapter.getSessionStatus()).resolves.not.toHaveProperty('staticIpOk');
    await adapter.placeOrder(order(), KEY);
    await expect(adapter.getSessionStatus()).resolves.toMatchObject({ staticIpOk: true });
  });

  it('maps rate limiting and unknown instruments from the wire', async () => {
    const rate = makeAdapter({
      http: new FakeHttpClient(jsonResponse(429, DHAN_RATE_LIMIT_ERROR)),
    });
    await expect(rate.adapter.listOrders()).rejects.toMatchObject({ kind: 'RATE_LIMITED' });

    const unknown = makeAdapter({
      http: new FakeHttpClient(jsonResponse(400, DHAN_INSTRUMENT_ERROR)),
    });
    await expect(unknown.adapter.placeOrder(order(), KEY)).rejects.toMatchObject({
      kind: 'INSTRUMENT_UNKNOWN',
    });
  });

  it('propagates a transport failure untouched', async () => {
    const boom = new BrokerError('NETWORK', 'Dhan request timed out after 10000ms');
    const { adapter } = makeAdapter({ http: new FakeHttpClient(boom) });
    await expect(adapter.getFunds()).rejects.toBe(boom);
  });

  it('refuses a malformed ack rather than returning a partial OrderAck', async () => {
    const { adapter } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, { orderStatus: 'PENDING' })),
    });
    const err = await adapter.placeOrder(order(), KEY).catch((e: unknown) => e);
    expect((err as BrokerError).kind).toBe('UNKNOWN');
    expect((err as BrokerError).message).toContain('malformed response');
  });
});

// ---------------------------------------------------------------------------
// Portfolio price enrichment
// ---------------------------------------------------------------------------

describe('portfolio last-price enrichment', () => {
  it('fetches a quote snapshot when holdings carry no last price', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(
        jsonResponse(200, DHAN_HOLDINGS_NO_LTP),
        jsonResponse(200, DHAN_QUOTE),
      ),
    });
    const holdings = await adapter.getHoldings();
    expect(http.count).toBe(2);
    expect(http.at(1).url).toBe(`${TEST_BASE_URL}/marketfeed/quote`);
    expect(http.bodyAt(1)).toEqual({ NSE_EQ: [11536] });
    expect(holdings[0]).toMatchObject({ lastPrice: 2950.5, pnl: 1010 });
  });

  it('makes no extra call when the payload already prices every row', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_HOLDINGS)),
    });
    await adapter.getHoldings();
    expect(http.count).toBe(1);
  });

  it('refuses a ₹0 valuation when no price can be found', async () => {
    const { adapter } = makeAdapter({
      http: new FakeHttpClient(
        jsonResponse(200, DHAN_HOLDINGS_NO_LTP),
        jsonResponse(200, { data: { NSE_EQ: {} } }),
      ),
    });
    const err = await adapter.getHoldings().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect((err as BrokerError).message).toMatch(/No last traded price for NSE:EQ:RELIANCE/);
  });

  it('never calls the quote endpoint when enrichment is disabled', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_HOLDINGS_NO_LTP)),
      deps: { enrichPortfolioPrices: false },
    });
    await expect(adapter.getHoldings()).rejects.toThrow(/No last traded price/);
    expect(http.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Session status
// ---------------------------------------------------------------------------

describe('getSessionStatus', () => {
  const expiresAt = TEST_SESSION.expiresAt!;

  it('is connected well before expiry', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.getSessionStatus()).resolves.toEqual({
      broker: 'dhan',
      connected: true,
      expiresAt,
    });
  });

  it('is disconnected inside the safety margin (expiring)', async () => {
    const { adapter } = makeAdapter({ now: new Date(Date.parse(expiresAt) - 60_000) });
    await expect(adapter.getSessionStatus()).resolves.toMatchObject({ connected: false });
  });

  it('is disconnected after expiry', async () => {
    const { adapter } = makeAdapter({ now: new Date(Date.parse(expiresAt) + 1) });
    await expect(adapter.getSessionStatus()).resolves.toMatchObject({ connected: false });
  });

  it('honours a custom margin and makes no HTTP call at all', async () => {
    const { adapter, http } = makeAdapter({
      now: new Date(Date.parse(expiresAt) - 60_000),
      deps: { sessionMarginMs: 1000 },
    });
    await expect(adapter.getSessionStatus()).resolves.toMatchObject({ connected: true });
    expect(http.count).toBe(0);
  });

  it('re-reads the session accessor on every call (daily token rotation)', async () => {
    let token = 'first-test-token';
    const http = new FakeHttpClient(jsonResponse(200, DHAN_FUNDS), jsonResponse(200, DHAN_FUNDS));
    const adapter = new DhanAdapter({
      http,
      session: () => ({ ...TEST_SESSION, accessToken: token }),
      instruments: makeAdapter().instruments,
      clock: () => FIXED_NOW,
      baseUrl: TEST_BASE_URL,
    });
    await adapter.getFunds();
    token = 'second-test-token';
    await adapter.getFunds();
    expect(http.at(0).headers['access-token']).toBe('first-test-token');
    expect(http.at(1).headers['access-token']).toBe('second-test-token');
  });
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

describe('miscellaneous guards', () => {
  it('rejects an interval Dhan has no chart for', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.getHistorical({
        symbol: RELIANCE,
        interval: '30m' as '15m',
        from: '2026-01-13T03:45:00.000Z',
        to: '2026-01-13T10:00:00.000Z',
      }),
    ).rejects.toThrow(/no intraday interval/);
  });

  it('rejects an unparseable from/to timestamp', () => {
    expect(() => toIstParts('not-a-date', 'historical')).toThrow(/unparseable timestamp/);
    expect(toIstParts('2026-01-13T18:31:00.000Z', 'historical')).toEqual({
      date: '2026-01-14',
      time: '00:01:00',
    });
  });

  it('refuses a chart request for an instrument with no instrument type', async () => {
    const { adapter } = makeAdapter({
      instruments: (() => {
        const master = makeAdapter().instruments;
        master.loadFromCsv(
          'EXCH_ID,SEGMENT,SECURITY_ID,TRADING_SYMBOL,LOT_SIZE,TICK_SIZE\nNSE,D,46285,NIFTY24DEC22000CE,75,0.05',
          FIXED_NOW,
        );
        return master;
      })(),
    });
    await expect(
      adapter.getHistorical({
        symbol: NIFTY_CE,
        interval: '1d',
        from: '2026-01-13T03:45:00.000Z',
        to: '2026-01-13T10:00:00.000Z',
      }),
    ).rejects.toThrow(/no instrument type/);
  });

  it('passes a configured timeout to every request', async () => {
    const { adapter, http } = makeAdapter({
      http: new FakeHttpClient(jsonResponse(200, DHAN_FUNDS)),
      deps: { timeoutMs: 3000 },
    });
    await adapter.getFunds();
    expect(http.last.timeoutMs).toBe(3000);
  });
});
