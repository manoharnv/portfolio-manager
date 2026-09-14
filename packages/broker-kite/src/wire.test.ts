import { describe, expect, it } from 'vitest';
import {
  BrokerError,
  UnsupportedMappingError,
  type CanonicalSymbol,
  type InstrumentRef,
  type NormalizedOrder,
} from '@pm/core';
import {
  KITE_BASE_URL,
  buildAuthHeaders,
  cancelRegularOrder,
  fetchFunds,
  fetchHistoricalCandles,
  fetchHoldings,
  fetchOrderHistory,
  fetchOrders,
  fetchPositions,
  fetchQuotes,
  formEncode,
  modifyRegularOrder,
  parseKiteEnvelope,
  placeRegularOrder,
  toKiteDateParam,
  toKiteInterval,
  type KiteWireContext,
} from './wire.js';
import {
  BSE_TATASTEEL,
  FakeHttpClient,
  NSE_RELIANCE,
  kiteError,
  kiteSuccess,
  sampleHistoricalResponse,
  sampleHoldingsResponse,
  sampleMarginsResponse,
  sampleOrderEntry,
  sampleOrderHistoryResponse,
  sampleOrderIdResponse,
  sampleOrdersListResponse,
  samplePositionsResponse,
  sampleQuoteResponse,
} from './test-utils.js';

const RELIANCE_REF: InstrumentRef = {
  broker: 'kite',
  canonical: NSE_RELIANCE,
  brokerInstrumentId: '738561',
  exchangeSegmentCode: 'NSE',
  lotSize: 1,
  tickSize: 0.05,
};

const TAG = 'a1b2c3d4e5f6a7b8c9d0'; // 20 chars, as kiteTagFor would produce

function makeCtx(http: FakeHttpClient, baseUrl: string = KITE_BASE_URL): KiteWireContext {
  return { http, apiKey: 'my-key', accessToken: 'my-token', baseUrl };
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

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

describe('formEncode', () => {
  it('skips undefined values', () => {
    expect(formEncode({ a: 1, b: undefined, c: 'x' })).toBe('a=1&c=x');
  });

  it('URL-encodes keys and values', () => {
    expect(formEncode({ 'a b': 'c&d=e' })).toBe('a%20b=c%26d%3De');
  });

  it('preserves insertion order', () => {
    expect(formEncode({ z: 1, a: 2 })).toBe('z=1&a=2');
  });

  it('stringifies numbers and booleans', () => {
    expect(formEncode({ n: 10, b: true })).toBe('n=10&b=true');
  });
});

describe('buildAuthHeaders', () => {
  it('builds the base auth headers with no Content-Type by default', () => {
    expect(buildAuthHeaders('k', 't')).toEqual({
      Authorization: 'token k:t',
      'X-Kite-Version': '3',
    });
  });

  it('adds Content-Type: form when requested', () => {
    expect(buildAuthHeaders('k', 't', { form: true })).toEqual({
      Authorization: 'token k:t',
      'X-Kite-Version': '3',
      'Content-Type': 'application/x-www-form-urlencoded',
    });
  });
});

describe('parseKiteEnvelope', () => {
  it('returns `data` on status: success', () => {
    const data = parseKiteEnvelope({
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ status: 'success', data: { x: 1 } }),
    });
    expect(data).toEqual({ x: 1 });
  });

  it('throws a mapped BrokerError for status: error', () => {
    expect(() =>
      parseKiteEnvelope({
        status: 400,
        headers: {},
        bodyText: JSON.stringify({ status: 'error', error_type: 'InputException', message: 'bad' }),
      }),
    ).toThrow(BrokerError);
  });

  it('throws UNKNOWN for a non-JSON body', () => {
    expect(() =>
      parseKiteEnvelope({ status: 200, headers: {}, bodyText: 'not json' }),
    ).toThrowError(/not valid JSON/);
  });

  it('throws UNKNOWN when the body does not match the envelope shape', () => {
    expect(() =>
      parseKiteEnvelope({ status: 200, headers: {}, bodyText: JSON.stringify({ foo: 1 }) }),
    ).toThrowError(/envelope shape/);
  });

  it('treats a non-2xx HTTP status as an error even if the body claims success (defensive)', () => {
    expect(() =>
      parseKiteEnvelope({
        status: 500,
        headers: {},
        bodyText: JSON.stringify({ status: 'success', data: {} }),
      }),
    ).toThrow(BrokerError);
  });
});

describe('toKiteInterval', () => {
  it.each([
    ['1m', 'minute'],
    ['5m', '5minute'],
    ['15m', '15minute'],
    ['1h', '60minute'],
    ['1d', 'day'],
  ] as const)('%s -> %s', (neutral, expected) => {
    expect(toKiteInterval(neutral)).toBe(expected);
  });
});

describe('toKiteDateParam', () => {
  it('throws a typed error for an unparseable ISO string', () => {
    expect(() => toKiteDateParam('not-a-date')).toThrowError(BrokerError);
    try {
      toKiteDateParam('not-a-date');
    } catch (err) {
      expect(err).toBeInstanceOf(BrokerError);
      expect((err as BrokerError).kind).toBe('UNKNOWN');
    }
  });
});

// ---------------------------------------------------------------------------
// POST /orders/regular
// ---------------------------------------------------------------------------

describe('placeRegularOrder', () => {
  const ORDER_TYPES: NormalizedOrder['orderType'][] = ['MARKET', 'LIMIT', 'SL', 'SL-M'];
  const SIDES: NormalizedOrder['side'][] = ['BUY', 'SELL'];
  const PRODUCTS: { neutral: NormalizedOrder['product']; kite: string }[] = [
    { neutral: 'DELIVERY', kite: 'CNC' },
    { neutral: 'INTRADAY', kite: 'MIS' },
    { neutral: 'MARGIN', kite: 'NRML' },
  ];
  const KITE_ORDER_TYPE: Record<string, string> = {
    MARKET: 'MARKET',
    LIMIT: 'LIMIT',
    SL: 'SL',
    'SL-M': 'SL-M',
  };

  const combos: {
    orderType: NormalizedOrder['orderType'];
    side: NormalizedOrder['side'];
    neutral: NormalizedOrder['product'];
    kiteProduct: string;
  }[] = [];
  for (const orderType of ORDER_TYPES) {
    for (const side of SIDES) {
      for (const { neutral, kite } of PRODUCTS) {
        combos.push({ orderType, side, neutral, kiteProduct: kite });
      }
    }
  }

  it.each(combos)(
    'places a $orderType $side $neutral order with the exact Kite form body',
    async ({ orderType, side, neutral, kiteProduct }) => {
      const http = new FakeHttpClient();
      http.enqueue(sampleOrderIdResponse('OID1'));

      const order = baseOrder({
        side,
        orderType,
        product: neutral,
        limitPrice: orderType === 'LIMIT' || orderType === 'SL' ? 2950.5 : undefined,
        triggerPrice: orderType === 'SL' || orderType === 'SL-M' ? 2900 : undefined,
      });

      const ack = await placeRegularOrder(makeCtx(http), order, RELIANCE_REF, TAG);

      expect(http.requests).toHaveLength(1);
      const req = http.requests[0];
      expect(req?.method).toBe('POST');
      expect(req?.url).toBe(`${KITE_BASE_URL}/orders/regular`);
      expect(req?.headers['Authorization']).toBe('token my-key:my-token');
      expect(req?.headers['X-Kite-Version']).toBe('3');
      expect(req?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const parts = [
        'tradingsymbol=RELIANCE',
        'exchange=NSE',
        `transaction_type=${side}`,
        `order_type=${KITE_ORDER_TYPE[orderType]}`,
        'quantity=10',
        `product=${kiteProduct}`,
      ];
      if (order.limitPrice !== undefined) parts.push(`price=${String(order.limitPrice)}`);
      if (order.triggerPrice !== undefined)
        parts.push(`trigger_price=${String(order.triggerPrice)}`);
      parts.push('validity=DAY');
      parts.push(`tag=${TAG}`);
      expect(req?.body).toBe(parts.join('&'));

      expect(ack).toEqual({
        brokerOrderId: 'OID1',
        status: 'SUBMITTED',
        raw: { order_id: 'OID1' },
      });
    },
  );

  it('includes disclosed_quantity only when provided', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleOrderIdResponse());
    await placeRegularOrder(makeCtx(http), baseOrder({ disclosedQuantity: 5 }), RELIANCE_REF, TAG);
    expect(http.requests[0]?.body).toContain('disclosed_quantity=5');

    const http2 = new FakeHttpClient();
    http2.enqueue(sampleOrderIdResponse());
    await placeRegularOrder(makeCtx(http2), baseOrder(), RELIANCE_REF, TAG);
    expect(http2.requests[0]?.body).not.toContain('disclosed_quantity');
  });

  it('uses the resolved InstrumentRef exchange code, not a re-derived one', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleOrderIdResponse());
    const bseRef: InstrumentRef = {
      ...RELIANCE_REF,
      canonical: BSE_TATASTEEL,
      exchangeSegmentCode: 'BSE',
    };
    await placeRegularOrder(makeCtx(http), baseOrder({ symbol: BSE_TATASTEEL }), bseRef, TAG);
    expect(http.requests[0]?.body).toContain('exchange=BSE');
  });

  it('throws UnsupportedMappingError for MTF with ZERO HTTP calls', async () => {
    const http = new FakeHttpClient();
    const order = baseOrder({ product: 'MTF' });
    await expect(placeRegularOrder(makeCtx(http), order, RELIANCE_REF, TAG)).rejects.toBeInstanceOf(
      UnsupportedMappingError,
    );
    expect(http.requests).toHaveLength(0);
  });

  it('throws a typed error when Kite rejects the order', async () => {
    const http = new FakeHttpClient();
    http.enqueue(kiteError(400, 'OrderException', 'RMS rejected: margin exceeded'));
    await expect(
      placeRegularOrder(makeCtx(http), baseOrder(), RELIANCE_REF, TAG),
    ).rejects.toMatchObject({ kind: 'RISK_REJECTED' });
  });

  it('maps a transport failure to NETWORK', async () => {
    const http = new FakeHttpClient();
    http.onRequest(() => {
      throw new TypeError('socket hang up');
    });
    await expect(
      placeRegularOrder(makeCtx(http), baseOrder(), RELIANCE_REF, TAG),
    ).rejects.toMatchObject({
      kind: 'NETWORK',
    });
  });

  it('throws a typed error for a malformed success payload', async () => {
    const http = new FakeHttpClient();
    http.enqueue(kiteSuccess({ not_an_order_id: true }));
    await expect(
      placeRegularOrder(makeCtx(http), baseOrder(), RELIANCE_REF, TAG),
    ).rejects.toMatchObject({
      kind: 'UNKNOWN',
    });
  });
});

// ---------------------------------------------------------------------------
// PUT /orders/regular/{id}
// ---------------------------------------------------------------------------

describe('modifyRegularOrder', () => {
  it('PUTs only the provided fields, in a fixed order', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleOrderIdResponse('OID9'));
    const ack = await modifyRegularOrder(makeCtx(http), 'OID9', {
      quantity: 20,
      limitPrice: 2999.95,
      validity: 'IOC',
    });

    const req = http.requests[0];
    expect(req?.method).toBe('PUT');
    expect(req?.url).toBe(`${KITE_BASE_URL}/orders/regular/OID9`);
    expect(req?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(req?.body).toBe('quantity=20&price=2999.95&validity=IOC');
    expect(ack).toEqual({ brokerOrderId: 'OID9', status: 'SUBMITTED', raw: { order_id: 'OID9' } });
  });

  it('maps orderType/validity via core when provided', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleOrderIdResponse());
    await modifyRegularOrder(makeCtx(http), 'OID1', { orderType: 'SL-M', triggerPrice: 100 });
    expect(http.requests[0]?.body).toBe('trigger_price=100&order_type=SL-M');
  });

  it('URL-encodes the order id', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleOrderIdResponse());
    await modifyRegularOrder(makeCtx(http), 'OID/5', { quantity: 1 });
    expect(http.requests[0]?.url).toBe(`${KITE_BASE_URL}/orders/regular/OID%2F5`);
  });
});

// ---------------------------------------------------------------------------
// DELETE /orders/regular/{id}
// ---------------------------------------------------------------------------

describe('cancelRegularOrder', () => {
  it('DELETEs with no body and no Content-Type header', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleOrderIdResponse('OID5'));
    const ack = await cancelRegularOrder(makeCtx(http), 'OID5');

    const req = http.requests[0];
    expect(req?.method).toBe('DELETE');
    expect(req?.url).toBe(`${KITE_BASE_URL}/orders/regular/OID5`);
    expect(req?.body).toBeUndefined();
    expect(req?.headers['Content-Type']).toBeUndefined();
    expect(req?.headers['Authorization']).toBe('token my-key:my-token');
    expect(ack).toEqual({ brokerOrderId: 'OID5', status: 'CANCELLED', raw: { order_id: 'OID5' } });
  });
});

// ---------------------------------------------------------------------------
// GET /orders/{id} and GET /orders
// ---------------------------------------------------------------------------

describe('fetchOrderHistory', () => {
  it('GETs /orders/{id} and returns the LATEST entry', async () => {
    const http = new FakeHttpClient();
    http.enqueue(
      sampleOrderHistoryResponse([
        sampleOrderEntry({ status: 'OPEN', filled_quantity: 0, pending_quantity: 10 }),
        sampleOrderEntry({ status: 'COMPLETE', filled_quantity: 10, pending_quantity: 0 }),
      ]),
    );
    const status = await fetchOrderHistory(makeCtx(http), 'OID1');
    expect(http.requests[0]).toMatchObject({ method: 'GET', url: `${KITE_BASE_URL}/orders/OID1` });
    expect(status.status).toBe('COMPLETE');
    expect(status.filledQty).toBe(10);
    expect(status.pendingQty).toBe(0);
  });

  it('throws a typed error for an empty history array', async () => {
    const http = new FakeHttpClient();
    http.enqueue(kiteSuccess([]));
    await expect(fetchOrderHistory(makeCtx(http), 'OID1')).rejects.toMatchObject({
      kind: 'UNKNOWN',
    });
  });
});

describe('fetchOrders', () => {
  it('GETs /orders and maps every entry', async () => {
    const http = new FakeHttpClient();
    http.enqueue(
      sampleOrdersListResponse([
        sampleOrderEntry(),
        sampleOrderEntry({ order_id: 'OID2', status: 'REJECTED', status_message: 'RMS blocked' }),
      ]),
    );
    const list = await fetchOrders(makeCtx(http));
    expect(http.requests[0]).toMatchObject({ method: 'GET', url: `${KITE_BASE_URL}/orders` });
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({
      brokerOrderId: 'OID2',
      status: 'REJECTED',
      rejectionReason: 'RMS blocked',
    });
  });

  it.each([
    ['COMPLETE', 10, 0, 'COMPLETE'],
    ['REJECTED', 0, 0, 'REJECTED'],
    ['CANCELLED', 3, 0, 'CANCELLED'],
    ['EXPIRED', 0, 5, 'EXPIRED'],
    ['OPEN', 0, 10, 'OPEN'],
    ['OPEN', 4, 6, 'PARTIAL'],
    ['TRIGGER PENDING', 0, 10, 'OPEN'],
    ['TRIGGER PENDING', 2, 8, 'PARTIAL'],
    ['VALIDATION PENDING', 0, 0, 'SUBMITTED'],
    ['MODIFY PENDING', 0, 0, 'SUBMITTED'],
    ['PUT ORDER REQ RECEIVED', 0, 0, 'SUBMITTED'],
    ['SOME_UNRECOGNISED_STATE', 0, 0, 'UNKNOWN'],
  ] as const)(
    'maps Kite status %s (filled=%d, pending=%d) to %s',
    async (kiteStatus, filled, pending, expected) => {
      const http = new FakeHttpClient();
      http.enqueue(
        sampleOrdersListResponse([
          sampleOrderEntry({
            status: kiteStatus,
            filled_quantity: filled,
            pending_quantity: pending,
          }),
        ]),
      );
      const [status] = await fetchOrders(makeCtx(http));
      expect(status?.status).toBe(expected);
    },
  );

  it('maps null average_price/status_message to undefined', async () => {
    const http = new FakeHttpClient();
    http.enqueue(
      sampleOrdersListResponse([sampleOrderEntry({ average_price: null, status_message: null })]),
    );
    const [status] = await fetchOrders(makeCtx(http));
    expect(status?.avgPrice).toBeUndefined();
    expect(status?.rejectionReason).toBeUndefined();
  });

  it('prefers exchange_update_timestamp, then falls back down the chain', async () => {
    const http = new FakeHttpClient();
    http.enqueue(
      sampleOrdersListResponse([
        sampleOrderEntry({
          exchange_update_timestamp: null,
          order_timestamp: '2026-01-13 09:00:00',
        }),
      ]),
    );
    const [status] = await fetchOrders(makeCtx(http));
    expect(status?.updatedAt).toBe('2026-01-13T09:00:00+05:30');
  });

  it('throws a typed error when no timestamp field is present at all', async () => {
    const http = new FakeHttpClient();
    http.enqueue(
      sampleOrdersListResponse([
        sampleOrderEntry({ exchange_update_timestamp: null, order_timestamp: null }),
      ]),
    );
    await expect(fetchOrders(makeCtx(http))).rejects.toMatchObject({ kind: 'UNKNOWN' });
  });
});

// ---------------------------------------------------------------------------
// GET /portfolio/holdings, GET /portfolio/positions
// ---------------------------------------------------------------------------

describe('fetchHoldings', () => {
  it('GETs /portfolio/holdings and maps to neutral Holding[]', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleHoldingsResponse());
    const holdings = await fetchHoldings(makeCtx(http));
    expect(http.requests[0]).toMatchObject({
      method: 'GET',
      url: `${KITE_BASE_URL}/portfolio/holdings`,
    });
    expect(holdings).toEqual([
      {
        symbol: NSE_RELIANCE,
        quantity: 10,
        avgCostPrice: 2900,
        lastPrice: 2950.5,
        pnl: 505,
        raw: expect.objectContaining({ tradingsymbol: 'RELIANCE' }) as unknown,
      },
    ]);
  });
});

describe('fetchPositions', () => {
  it('GETs /portfolio/positions and uses only `net`', async () => {
    const http = new FakeHttpClient();
    http.enqueue(samplePositionsResponse());
    const positions = await fetchPositions(makeCtx(http));
    expect(http.requests[0]).toMatchObject({
      method: 'GET',
      url: `${KITE_BASE_URL}/portfolio/positions`,
    });
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      symbol: NSE_RELIANCE,
      netQty: 5,
      product: 'INTRADAY',
      avgPrice: 2900,
      lastPrice: 2950.5,
      realizedPnl: 0,
      unrealizedPnl: 252.5,
    });
  });
});

// ---------------------------------------------------------------------------
// GET /user/margins
// ---------------------------------------------------------------------------

describe('fetchFunds', () => {
  it('GETs /user/margins and uses the equity segment', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleMarginsResponse());
    const funds = await fetchFunds(makeCtx(http));
    expect(http.requests[0]).toMatchObject({ method: 'GET', url: `${KITE_BASE_URL}/user/margins` });
    expect(funds.availableCash).toBe(500_000);
    expect(funds.usedMargin).toBe(5_000);
    expect(funds.availableMargin).toBe(495_000);
  });
});

// ---------------------------------------------------------------------------
// GET /instruments/historical/{token}/{interval}
// ---------------------------------------------------------------------------

describe('fetchHistoricalCandles', () => {
  it('GETs the historical endpoint with the mapped interval and IST from/to', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleHistoricalResponse());
    const candles = await fetchHistoricalCandles(
      makeCtx(http),
      '738561',
      '1d',
      '2026-01-12T00:00:00.000Z',
      '2026-01-13T00:00:00.000Z',
    );
    const req = http.requests[0];
    expect(req?.method).toBe('GET');
    expect(req?.url).toBe(
      `${KITE_BASE_URL}/instruments/historical/738561/day?from=2026-01-12+05%3A30%3A00&to=2026-01-13+05%3A30%3A00`,
    );
    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({
      ts: '2026-01-12T09:15:00+05:30',
      open: 2940,
      high: 2955,
      low: 2935,
      close: 2950,
      volume: 120_000,
    });
  });

  it('URL-encodes the instrument token', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleHistoricalResponse());
    await fetchHistoricalCandles(
      makeCtx(http),
      '73/8561',
      '1m',
      '2026-01-12T00:00:00.000Z',
      '2026-01-13T00:00:00.000Z',
    );
    expect(http.requests[0]?.url).toContain('/instruments/historical/73%2F8561/minute');
  });

  it('passes an already-ISO timestamp (colon offset or Z) through unchanged', async () => {
    const http = new FakeHttpClient();
    http.enqueue(
      kiteSuccess({
        candles: [
          ['2026-01-12T09:15:00+05:30', 1, 2, 3, 4, 5],
          ['2026-01-12T03:45:00.000Z', 1, 2, 3, 4, 5],
        ],
      }),
    );
    const candles = await fetchHistoricalCandles(
      makeCtx(http),
      '1',
      '1d',
      '2026-01-12T00:00:00.000Z',
      '2026-01-13T00:00:00.000Z',
    );
    expect(candles[0]?.ts).toBe('2026-01-12T09:15:00+05:30');
    expect(candles[1]?.ts).toBe('2026-01-12T03:45:00.000Z');
  });

  it('throws a typed error for a malformed candle row', async () => {
    const http = new FakeHttpClient();
    http.enqueue(
      kiteSuccess({ candles: [['2026-01-12T09:15:00+0530', 'not-a-number', 1, 1, 1, 1]] }),
    );
    await expect(
      fetchHistoricalCandles(
        makeCtx(http),
        '1',
        '1d',
        '2026-01-12T00:00:00.000Z',
        '2026-01-13T00:00:00.000Z',
      ),
    ).rejects.toMatchObject({ kind: 'UNKNOWN' });
  });
});

// ---------------------------------------------------------------------------
// GET /quote
// ---------------------------------------------------------------------------

describe('fetchQuotes', () => {
  it('GETs /quote with one URL-encoded i= param per symbol', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleQuoteResponse());
    const [quote] = await fetchQuotes(makeCtx(http), [NSE_RELIANCE]);
    expect(http.requests[0]).toMatchObject({
      method: 'GET',
      url: `${KITE_BASE_URL}/quote?i=NSE%3ARELIANCE`,
    });
    expect(quote).toEqual({
      symbol: NSE_RELIANCE,
      ltp: 2950.5,
      open: 2940,
      high: 2960,
      low: 2930,
      close: 2945,
      volume: 1_000_000,
      ts: '2026-01-13T09:59:58+05:30',
    });
  });

  it('joins multiple i= params with &, one per symbol, in order', async () => {
    const http = new FakeHttpClient();
    http.enqueue(
      kiteSuccess({
        'NSE:RELIANCE': {
          last_price: 1,
          volume: 1,
          last_trade_time: '2026-01-13 09:00:00',
          ohlc: { open: 1, high: 1, low: 1, close: 1 },
        },
        'BSE:TATASTEEL': {
          last_price: 2,
          volume: 2,
          last_trade_time: '2026-01-13 09:00:01',
          ohlc: { open: 2, high: 2, low: 2, close: 2 },
        },
      }),
    );
    await fetchQuotes(makeCtx(http), [NSE_RELIANCE, BSE_TATASTEEL]);
    expect(http.requests[0]?.url).toBe(`${KITE_BASE_URL}/quote?i=NSE%3ARELIANCE&i=BSE%3ATATASTEEL`);
  });

  it('falls back to `timestamp` when last_trade_time is null', async () => {
    const http = new FakeHttpClient();
    http.enqueue(
      kiteSuccess({
        'NSE:RELIANCE': {
          last_price: 1,
          volume: 1,
          last_trade_time: null,
          timestamp: '2026-01-13 10:00:00',
          ohlc: { open: 1, high: 1, low: 1, close: 1 },
        },
      }),
    );
    const [quote] = await fetchQuotes(makeCtx(http), [NSE_RELIANCE]);
    expect(quote?.ts).toBe('2026-01-13T10:00:00+05:30');
  });

  it('throws a typed error when the response is missing a requested symbol', async () => {
    const http = new FakeHttpClient();
    http.enqueue(kiteSuccess({}));
    await expect(fetchQuotes(makeCtx(http), [NSE_RELIANCE])).rejects.toMatchObject({
      kind: 'UNKNOWN',
    });
  });

  it('throws UnsupportedMappingError, with zero HTTP calls, for a segment Kite has no exchange code for', async () => {
    const http = new FakeHttpClient();
    const bad: CanonicalSymbol = { exchange: 'NSE', segment: 'CURRENCY', tradingSymbol: 'USDINR' };
    await expect(fetchQuotes(makeCtx(http), [bad])).rejects.toBeInstanceOf(UnsupportedMappingError);
    expect(http.requests).toHaveLength(0);
  });
});
