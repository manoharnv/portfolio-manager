import { BrokerError, UnsupportedMappingError } from '@pm/core';
import { describe, expect, it } from 'vitest';
import {
  DHAN_BASE_URL,
  DHAN_ORDER_STATUS_MAP,
  buildCancelOrderRequest,
  buildFundsRequest,
  buildGetOrderRequest,
  buildHistoricalChartRequest,
  buildHoldingsRequest,
  buildIntradayChartRequest,
  buildListOrdersRequest,
  buildMarketQuoteRequest,
  buildModifyOrderRequest,
  buildPlaceOrderRequest,
  buildPositionsRequest,
  decodeJson,
  dhanHeaders,
  dhanTimeToIso,
  ensureOk,
  epochSecondsToIso,
  mapDhanOrderStatus,
  parseChartsResponse,
  parseFundsResponse,
  parseHoldingsResponse,
  parseLastPrices,
  parseMarketQuoteResponse,
  parseOrderAckResponse,
  parseOrderListResponse,
  parseOrderResponse,
  parsePositionsResponse,
  quoteKey,
  toHolding,
  toPosition,
  type DhanWireContext,
} from './wire.js';
import {
  DHAN_AUTH_ERROR,
  DHAN_CHART,
  DHAN_CHART_ISO,
  DHAN_FUNDS,
  DHAN_HOLDINGS,
  DHAN_HOLDINGS_NO_LTP,
  DHAN_ORDER_ACK,
  DHAN_ORDER_ROW,
  DHAN_POSITIONS,
  DHAN_QUOTE,
  DHAN_REJECTED_ORDER_ROW,
  EXPECTED_HEADERS,
  RELIANCE,
  TEST_BASE_URL,
  TEST_SESSION,
  jsonResponse,
  textResponse,
} from './test-utils.js';

const ctx: DhanWireContext = {
  baseUrl: TEST_BASE_URL,
  clientId: TEST_SESSION.clientId,
  accessToken: TEST_SESSION.accessToken,
};

describe('headers and base url', () => {
  it('sends access-token, dhanClientId and a JSON content type (docs/02 §2.6)', () => {
    expect(dhanHeaders(ctx)).toEqual(EXPECTED_HEADERS);
  });

  it('defaults to the documented v2 base url', () => {
    expect(DHAN_BASE_URL).toBe('https://api.dhan.co/v2');
  });
});

describe('request builders — one per docs/02 §2.6 endpoint row', () => {
  it('placeOrder → POST /orders', () => {
    const body = {
      dhanClientId: ctx.clientId,
      transactionType: 'BUY' as const,
      exchangeSegment: 'NSE_EQ',
      productType: 'CNC',
      orderType: 'LIMIT',
      validity: 'DAY',
      securityId: '11536',
      quantity: 10,
      price: 2950.5,
      triggerPrice: 0,
      disclosedQuantity: 0,
      correlationId: 'prop-0001',
    };
    const req = buildPlaceOrderRequest(ctx, body);
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${TEST_BASE_URL}/orders`);
    expect(req.headers).toEqual(EXPECTED_HEADERS);
    expect(JSON.parse(req.body!)).toEqual(body);
  });

  it('modifyOrder → PUT /orders/{id}', () => {
    const req = buildModifyOrderRequest(ctx, '112111182198', {
      dhanClientId: ctx.clientId,
      orderId: '112111182198',
      orderType: 'LIMIT',
      validity: 'DAY',
      quantity: 5,
    });
    expect(req.method).toBe('PUT');
    expect(req.url).toBe(`${TEST_BASE_URL}/orders/112111182198`);
    expect(JSON.parse(req.body!)).toMatchObject({ orderId: '112111182198', quantity: 5 });
  });

  it('cancelOrder → DELETE /orders/{id}, no body', () => {
    const req = buildCancelOrderRequest(ctx, '112111182198');
    expect(req.method).toBe('DELETE');
    expect(req.url).toBe(`${TEST_BASE_URL}/orders/112111182198`);
    expect(req.body).toBeUndefined();
  });

  it('getOrder → GET /orders/{id}, url-encoding the id', () => {
    const req = buildGetOrderRequest(ctx, 'a/b c');
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${TEST_BASE_URL}/orders/a%2Fb%20c`);
  });

  it('listOrders → GET /orders', () => {
    expect(buildListOrdersRequest(ctx)).toEqual({
      method: 'GET',
      url: `${TEST_BASE_URL}/orders`,
      headers: EXPECTED_HEADERS,
    });
  });

  it('getHoldings → GET /holdings', () => {
    expect(buildHoldingsRequest(ctx).url).toBe(`${TEST_BASE_URL}/holdings`);
  });

  it('getPositions → GET /positions', () => {
    expect(buildPositionsRequest(ctx).url).toBe(`${TEST_BASE_URL}/positions`);
  });

  it('getFunds → GET /fundlimit', () => {
    expect(buildFundsRequest(ctx)).toEqual({
      method: 'GET',
      url: `${TEST_BASE_URL}/fundlimit`,
      headers: EXPECTED_HEADERS,
    });
  });

  it('getHistorical → POST /charts/historical', () => {
    const req = buildHistoricalChartRequest(ctx, {
      securityId: '11536',
      exchangeSegment: 'NSE_EQ',
      instrument: 'EQUITY',
      expiryCode: 0,
      oi: false,
      fromDate: '2026-01-01',
      toDate: '2026-01-13',
    });
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${TEST_BASE_URL}/charts/historical`);
    expect(JSON.parse(req.body!)).toMatchObject({ securityId: '11536', expiryCode: 0 });
  });

  it('getHistorical (intraday) → POST /charts/intraday', () => {
    const req = buildIntradayChartRequest(ctx, {
      securityId: '11536',
      exchangeSegment: 'NSE_EQ',
      instrument: 'EQUITY',
      interval: '5',
      oi: false,
      fromDate: '2026-01-13 09:15:00',
      toDate: '2026-01-13 15:30:00',
    });
    expect(req.url).toBe(`${TEST_BASE_URL}/charts/intraday`);
    expect(JSON.parse(req.body!)).toMatchObject({ interval: '5' });
  });

  it('getQuote → POST /marketfeed/quote with ids grouped by segment', () => {
    const req = buildMarketQuoteRequest(ctx, { NSE_EQ: [11536, 1333], NSE_FNO: [46285] });
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${TEST_BASE_URL}/marketfeed/quote`);
    expect(JSON.parse(req.body!)).toEqual({ NSE_EQ: [11536, 1333], NSE_FNO: [46285] });
  });
});

describe('ensureOk / decodeJson', () => {
  it('turns a non-2xx into a classified BrokerError', () => {
    try {
      ensureOk(jsonResponse(401, DHAN_AUTH_ERROR), 'holdings');
      expect.unreachable();
    } catch (err) {
      expect((err as BrokerError).kind).toBe('AUTH_EXPIRED');
    }
  });

  it('treats a 200 {"status":"failed"} envelope as a failure', () => {
    expect(() =>
      ensureOk(
        jsonResponse(200, { status: 'failed', remarks: { error_message: 'nope' } }),
        'place',
      ),
    ).toThrow(BrokerError);
  });

  it('rejects an empty or non-JSON body', () => {
    expect(() => decodeJson(textResponse(200, ''), 'holdings')).toThrow(/empty response body/);
    expect(() => decodeJson(textResponse(200, '<html>'), 'holdings')).toThrow(/not JSON/);
  });
});

describe('timestamps', () => {
  it('attaches IST to Dhan wall-clock strings', () => {
    expect(dhanTimeToIso('2026-01-13 09:35:12', 'x')).toBe('2026-01-13T09:35:12+05:30');
    expect(dhanTimeToIso('13/01/2026 10:00:00', 'x')).toBe('2026-01-13T10:00:00+05:30');
    expect(dhanTimeToIso('2026-01-13', 'x')).toBe('2026-01-13T00:00:00+05:30');
    expect(dhanTimeToIso('2026-01-13 09:35', 'x')).toBe('2026-01-13T09:35:00+05:30');
  });

  it('passes a value that already carries a timezone straight through', () => {
    expect(dhanTimeToIso('2026-01-13T04:05:06.000Z', 'x')).toBe('2026-01-13T04:05:06.000Z');
    expect(dhanTimeToIso('2026-01-13 04:05:06+05:30', 'x')).toBe('2026-01-13T04:05:06+05:30');
  });

  it('throws rather than guessing an unknown format', () => {
    expect(() => dhanTimeToIso('yesterday', 'order')).toThrow(/unrecognised timestamp/);
  });

  it('converts epoch seconds and refuses implausible ones', () => {
    expect(epochSecondsToIso(1768275900, 'chart')).toBe('2026-01-13T03:45:00.000Z');
    expect(() => epochSecondsToIso(1.768e15, 'chart')).toThrow(/implausible epoch/);
  });
});

describe('order status mapping', () => {
  it('maps every documented Dhan state', () => {
    expect(mapDhanOrderStatus('TRANSIT')).toBe('SUBMITTED');
    expect(mapDhanOrderStatus('pending')).toBe('OPEN');
    expect(mapDhanOrderStatus('PART_TRADED')).toBe('PARTIAL');
    expect(mapDhanOrderStatus('TRADED')).toBe('COMPLETE');
    expect(mapDhanOrderStatus('CANCELLED')).toBe('CANCELLED');
    expect(mapDhanOrderStatus('REJECTED')).toBe('REJECTED');
    expect(mapDhanOrderStatus('EXPIRED')).toBe('EXPIRED');
    expect(Object.keys(DHAN_ORDER_STATUS_MAP).length).toBeGreaterThan(10);
  });

  it('never invents a terminal state for an unknown code', () => {
    expect(mapDhanOrderStatus('SOMETHING_NEW')).toBe('UNKNOWN');
    expect(mapDhanOrderStatus(undefined)).toBe('UNKNOWN');
  });
});

describe('order parsing', () => {
  it('parses an ack and keeps the raw payload', () => {
    const ack = parseOrderAckResponse(jsonResponse(200, DHAN_ORDER_ACK), 'place order');
    expect(ack).toEqual({
      brokerOrderId: '112111182198',
      status: 'OPEN',
      raw: DHAN_ORDER_ACK,
    });
  });

  it('accepts a numeric orderId and a {data:{…}} wrapper', () => {
    const ack = parseOrderAckResponse(
      jsonResponse(200, { data: { orderId: 112111182198, orderStatus: 'TRANSIT' } }),
      'place order',
    );
    expect(ack.brokerOrderId).toBe('112111182198');
    expect(ack.status).toBe('SUBMITTED');
  });

  it('refuses an ack with no order id', () => {
    expect(() =>
      parseOrderAckResponse(jsonResponse(200, { orderStatus: 'PENDING' }), 'place'),
    ).toThrow(/orderId/);
  });

  it('parses a single order, deriving pending qty and rejection reason', () => {
    const status = parseOrderResponse(jsonResponse(200, DHAN_ORDER_ROW), 'get order');
    expect(status).toMatchObject({
      brokerOrderId: '112111182198',
      status: 'PARTIAL',
      filledQty: 4,
      pendingQty: 6,
      avgPrice: 2950.25,
      updatedAt: '2026-01-13T09:35:12+05:30',
    });
    expect(status.rejectionReason).toBeUndefined();
    expect(status.raw).toMatchObject({ orderId: '112111182198' });
  });

  it('accepts the single-element-array shape Dhan also documents', () => {
    expect(parseOrderResponse(jsonResponse(200, [DHAN_ORDER_ROW]), 'get order').status).toBe(
      'PARTIAL',
    );
  });

  it('reports the rejection reason and no average price for a rejected order', () => {
    const status = parseOrderResponse(jsonResponse(200, DHAN_REJECTED_ORDER_ROW), 'get order');
    expect(status.status).toBe('REJECTED');
    expect(status.avgPrice).toBeUndefined();
    expect(status.rejectionReason).toContain('Insufficient funds');
  });

  it('computes pendingQty from quantity when Dhan omits remainingQuantity', () => {
    const { remainingQuantity: _drop, ...row } = DHAN_ORDER_ROW;
    const status = parseOrderResponse(jsonResponse(200, row), 'get order');
    expect(status.pendingQty).toBe(6);
  });

  it('throws when no timestamp is present at all', () => {
    const { updateTime: _u, createTime: _c, exchangeTime: _e, ...row } = DHAN_ORDER_ROW;
    expect(() => parseOrderResponse(jsonResponse(200, row), 'get order')).toThrow(
      /no updateTime\/exchangeTime\/createTime/,
    );
  });

  it('parses the order book and rejects a non-array body', () => {
    const list = parseOrderListResponse(
      jsonResponse(200, [DHAN_ORDER_ROW, DHAN_REJECTED_ORDER_ROW]),
      'list orders',
    );
    expect(list.map((o) => o.status)).toEqual(['PARTIAL', 'REJECTED']);
    expect(() => parseOrderListResponse(jsonResponse(200, { orders: [] }), 'list orders')).toThrow(
      /expected a JSON array/,
    );
    expect(() => parseOrderResponse(jsonResponse(200, []), 'get order')).toThrow(
      /empty order list/,
    );
  });
});

describe('portfolio parsing', () => {
  it('parses holdings, defaulting the "ALL" exchange to NSE equity', () => {
    const rows = parseHoldingsResponse(jsonResponse(200, DHAN_HOLDINGS), 'holdings');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      symbol: RELIANCE,
      securityId: '11536',
      exchangeSegment: 'NSE_EQ',
      quantity: 20,
      avgCostPrice: 2900,
      lastPrice: 2950,
    });
  });

  it('honours an explicit default exchange and an explicit segment', () => {
    const bse = parseHoldingsResponse(jsonResponse(200, DHAN_HOLDINGS), 'holdings', {
      defaultExchange: 'BSE',
    });
    expect(bse[0]!.symbol.exchange).toBe('BSE');
    const explicit = parseHoldingsResponse(
      jsonResponse(200, [{ ...DHAN_HOLDINGS[0], exchange: 'BSE' }]),
      'holdings',
    );
    expect(explicit[0]!.exchangeSegment).toBe('BSE_EQ');
  });

  it('leaves lastPrice undefined when Dhan omits it', () => {
    const rows = parseHoldingsResponse(jsonResponse(200, DHAN_HOLDINGS_NO_LTP), 'holdings');
    expect(rows[0]!.lastPrice).toBeUndefined();
  });

  it('rejects a holding with no quantity and a non-array body', () => {
    expect(() =>
      parseHoldingsResponse(
        jsonResponse(200, [{ tradingSymbol: 'X', securityId: '1', avgCostPrice: 1 }]),
        'holdings',
      ),
    ).toThrow(/no quantity field/);
    expect(() => parseHoldingsResponse(jsonResponse(200, {}), 'holdings')).toThrow(
      /expected a JSON array/,
    );
  });

  it('rejects an unrecognised holdings exchange rather than guessing', () => {
    expect(() =>
      parseHoldingsResponse(
        jsonResponse(200, [{ ...DHAN_HOLDINGS[0], exchange: 'NYSE' }]),
        'holdings',
      ),
    ).toThrow(UnsupportedMappingError);
  });

  it('parses positions and maps the product back to the neutral name', () => {
    const rows = parsePositionsResponse(jsonResponse(200, DHAN_POSITIONS), 'positions');
    expect(rows[0]).toMatchObject({
      symbol: RELIANCE,
      netQty: 10,
      product: 'INTRADAY',
      avgPrice: 2900,
      realizedPnl: 0,
      unrealizedPnl: 500,
    });
  });

  it('refuses a position with no cost price or an unknown product', () => {
    const { costPrice: _c, buyAvg: _b, ...row } = DHAN_POSITIONS[0]!;
    expect(() => parsePositionsResponse(jsonResponse(200, [row]), 'positions')).toThrow(
      /no cost price/,
    );
    expect(() =>
      parsePositionsResponse(
        jsonResponse(200, [{ ...DHAN_POSITIONS[0], productType: 'WEIRD' }]),
        'positions',
      ),
    ).toThrow(UnsupportedMappingError);
    expect(() => parsePositionsResponse(jsonResponse(200, {}), 'positions')).toThrow(
      /expected a JSON array/,
    );
  });

  it('derives holding P&L from the last price', () => {
    const [row] = parseHoldingsResponse(jsonResponse(200, DHAN_HOLDINGS), 'holdings');
    expect(toHolding(row!, 2950)).toMatchObject({ lastPrice: 2950, pnl: 1000 });
    const [pos] = parsePositionsResponse(jsonResponse(200, DHAN_POSITIONS), 'positions');
    expect(toPosition(pos!, 2950)).toMatchObject({ lastPrice: 2950, unrealizedPnl: 500 });
  });

  it('maps fundlimit onto the neutral Funds shape', () => {
    expect(parseFundsResponse(jsonResponse(200, DHAN_FUNDS), 'funds')).toEqual({
      availableCash: 120000.5,
      usedMargin: 4999.25,
      availableMargin: 125000.75,
      raw: DHAN_FUNDS,
    });
  });

  it('accepts the correctly-spelled balance field and falls back for cash', () => {
    const funds = parseFundsResponse(
      jsonResponse(200, { availableBalance: 100, utilizedAmount: 10 }),
      'funds',
    );
    expect(funds).toMatchObject({ availableMargin: 100, availableCash: 100, usedMargin: 10 });
  });

  it('refuses a funds payload missing a balance or the utilised amount', () => {
    expect(() => parseFundsResponse(jsonResponse(200, { utilizedAmount: 1 }), 'funds')).toThrow(
      /availabelBalance/,
    );
    expect(() => parseFundsResponse(jsonResponse(200, { availabelBalance: 1 }), 'funds')).toThrow(
      /utilizedAmount/,
    );
  });
});

describe('chart parsing', () => {
  it('turns the columnar payload into candles', () => {
    const candles = parseChartsResponse(jsonResponse(200, DHAN_CHART), 'historical chart');
    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({
      ts: DHAN_CHART_ISO[0],
      open: 2900,
      high: 2960,
      low: 2890,
      close: 2945,
      volume: 1200000,
    });
  });

  it('accepts the start_Time column name and a {data:{…}} wrapper', () => {
    const { timestamp, ...rest } = DHAN_CHART;
    const candles = parseChartsResponse(
      jsonResponse(200, { data: { ...rest, start_Time: timestamp } }),
      'historical chart',
    );
    expect(candles).toHaveLength(2);
  });

  it('refuses ragged columns rather than misaligning price and time', () => {
    expect(() =>
      parseChartsResponse(jsonResponse(200, { ...DHAN_CHART, close: [1] }), 'historical chart'),
    ).toThrow(/ragged chart columns/);
  });

  it('refuses a payload with no timestamp column', () => {
    const { timestamp: _t, ...rest } = DHAN_CHART;
    expect(() => parseChartsResponse(jsonResponse(200, rest), 'historical chart')).toThrow(
      /no timestamp\/start_Time column/,
    );
  });
});

describe('quote parsing', () => {
  const index = new Map([[quoteKey('NSE_EQ', '11536'), RELIANCE]]);

  it('maps a snapshot back onto the requested canonical symbols', () => {
    const quotes = parseMarketQuoteResponse(jsonResponse(200, DHAN_QUOTE), 'quote', index);
    expect(quotes).toEqual([
      {
        symbol: RELIANCE,
        ltp: 2950.5,
        open: 2940,
        high: 2975,
        low: 2930,
        close: 2945,
        volume: 1234567,
        ts: '2026-01-13T10:00:00+05:30',
      },
    ]);
  });

  it('omits a symbol Dhan did not answer for instead of zero-filling it', () => {
    const quotes = parseMarketQuoteResponse(
      jsonResponse(200, { data: { NSE_EQ: {} } }),
      'quote',
      index,
    );
    expect(quotes).toEqual([]);
  });

  it('refuses a quote with no trade time — a stale quote must be detectable', () => {
    const payload = {
      data: {
        NSE_EQ: {
          '11536': { last_price: 1, volume: 1, ohlc: { open: 1, high: 1, low: 1, close: 1 } },
        },
      },
    };
    expect(() => parseMarketQuoteResponse(jsonResponse(200, payload), 'quote', index)).toThrow(
      /no last_trade_time/,
    );
  });

  it('refuses a quote with no ohlc block', () => {
    const payload = { data: { NSE_EQ: { '11536': { last_price: 1 } } } };
    expect(() => parseMarketQuoteResponse(jsonResponse(200, payload), 'quote', index)).toThrow(
      BrokerError,
    );
  });

  it('reads last prices for portfolio enrichment without needing a trade time', () => {
    const prices = parseLastPrices(
      jsonResponse(200, { data: { NSE_EQ: { '11536': { last_price: 2950.5 }, '1': 'junk' } } }),
      'enrichment',
    );
    expect(prices.get(quoteKey('NSE_EQ', '11536'))).toBe(2950.5);
    expect(prices.size).toBe(1);
  });
});
