/**
 * Fixtures and fakes. Test-only: excluded from the build (`tsconfig.build.json`)
 * and from coverage.
 *
 * No credentials, real or realistic, appear anywhere in this package — the test
 * client id and token below are obviously synthetic on purpose (docs/00 §0.7.7).
 */

import type { CanonicalSymbol } from '@pm/core';
import { DhanAdapter, type DhanAdapterDeps } from './adapter.js';
import type { DhanSession } from './auth.js';
import type { HttpClient, HttpRequest, HttpResponse } from './http.js';
import { DhanInstrumentMaster } from './instruments.js';

// ---------------------------------------------------------------------------
// Clock & session
// ---------------------------------------------------------------------------

/** A Tuesday, 10:00 IST — inside the NSE session (matches core's fixture). */
export const FIXED_NOW = new Date('2026-01-13T04:30:00.000Z');
/** The instrument master was loaded at 08:00 IST the same morning. */
export const MASTER_LOADED_AT = new Date('2026-01-13T02:30:00.000Z');

export const fixedClock =
  (now: Date = FIXED_NOW) =>
  (): Date =>
    now;

export const TEST_SESSION: DhanSession = {
  clientId: 'TEST-CLIENT-ID',
  accessToken: 'test-access-token-not-a-real-jwt',
  expiresAt: '2026-01-14T02:30:00.000Z',
};

export const TEST_BASE_URL = 'https://dhan.test/v2';

export const RELIANCE: CanonicalSymbol = {
  exchange: 'NSE',
  segment: 'EQ',
  tradingSymbol: 'RELIANCE',
};
export const RELIANCE_BSE: CanonicalSymbol = {
  exchange: 'BSE',
  segment: 'EQ',
  tradingSymbol: 'RELIANCE',
};
export const NIFTY_CE: CanonicalSymbol = {
  exchange: 'NSE',
  segment: 'FNO',
  tradingSymbol: 'NIFTY24DEC22000CE',
};
export const UNKNOWN_SYMBOL: CanonicalSymbol = {
  exchange: 'NSE',
  segment: 'EQ',
  tradingSymbol: 'NOTLISTED',
};

// ---------------------------------------------------------------------------
// HTTP fake
// ---------------------------------------------------------------------------

export function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    bodyText: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

export function textResponse(status: number, bodyText: string): HttpResponse {
  return { status, headers: { 'content-type': 'text/plain' }, bodyText };
}

/**
 * Records every request and replays scripted responses in order. An unscripted
 * call throws, so a test can never accidentally assert against a default 200.
 */
export class FakeHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];
  private readonly scripted: (HttpResponse | Error)[] = [];

  constructor(...responses: (HttpResponse | Error)[]) {
    this.scripted.push(...responses);
  }

  /** Queue more responses (FIFO). */
  respondWith(...responses: (HttpResponse | Error)[]): this {
    this.scripted.push(...responses);
    return this;
  }

  respondJson(status: number, body: unknown): this {
    return this.respondWith(jsonResponse(status, body));
  }

  request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const next = this.scripted.shift();
    if (next === undefined) {
      return Promise.reject(
        new Error(
          `FakeHttpClient: unscripted ${req.method} ${req.url} (request #${this.requests.length})`,
        ),
      );
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }

  get count(): number {
    return this.requests.length;
  }

  at(i: number): HttpRequest {
    const req = this.requests[i];
    if (req === undefined) throw new Error(`FakeHttpClient: no request at index ${i}`);
    return req;
  }

  get last(): HttpRequest {
    return this.at(this.requests.length - 1);
  }

  /** The JSON body of the request at `i` (default: the only/first one). */
  bodyAt(i = 0): unknown {
    const body = this.at(i).body;
    if (body === undefined) throw new Error(`FakeHttpClient: request ${i} has no body`);
    return JSON.parse(body) as unknown;
  }
}

// ---------------------------------------------------------------------------
// Scrip master fixtures
// ---------------------------------------------------------------------------

/**
 * Legacy `SEM_*` header family. Five data rows: NSE equity, BSE equity (finer
 * tick), an NSE index option (lot 75), a currency row that must be skipped, and
 * a row with an unusable tick size that must also be skipped. The custom-symbol
 * column carries a quoted comma on purpose.
 */
export const SCRIP_MASTER_CSV = [
  'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_TICK_SIZE',
  'NSE,E,11536,EQUITY,0,RELIANCE,1,"RELIANCE INDUSTRIES LTD, EQ",0.05',
  'BSE,E,500325,EQUITY,0,RELIANCE,1,"RELIANCE INDUSTRIES LTD, A GROUP",0.01',
  'NSE,D,46285,OPTIDX,1,NIFTY24DEC22000CE,75,"NIFTY 26 DEC 22000 CALL",0.05',
  'NSE,C,10001,FUTCUR,1,USDINR24DECFUT,1000,"USD INR, DEC FUT",0.0025',
  'NSE,E,99999,EQUITY,0,BADTICK,1,"BAD TICK LTD",0',
  '',
].join('\n');

/** Same instruments, newer plain header family — exercises the column aliases. */
export const SCRIP_MASTER_CSV_NEW_HEADERS = [
  'EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,TRADING_SYMBOL,LOT_SIZE,TICK_SIZE',
  'NSE,EQUITY,11536,EQUITY,RELIANCE,1,0.05',
  'NSE,DERIVATIVE,46285,OPTIDX,NIFTY24DEC22000CE,75,0.05',
].join('\n');

export function makeMaster(csv: string = SCRIP_MASTER_CSV): DhanInstrumentMaster {
  const master = new DhanInstrumentMaster();
  master.loadFromCsv(csv, MASTER_LOADED_AT);
  return master;
}

// ---------------------------------------------------------------------------
// Response fixtures (docs/02 §2.6 endpoint table)
// ---------------------------------------------------------------------------

export const DHAN_ORDER_ACK = { orderId: '112111182198', orderStatus: 'PENDING' };

export const DHAN_ORDER_ROW = {
  dhanClientId: 'TEST-CLIENT-ID',
  orderId: '112111182198',
  correlationId: 'prop-0001',
  orderStatus: 'PART_TRADED',
  transactionType: 'BUY',
  exchangeSegment: 'NSE_EQ',
  productType: 'CNC',
  orderType: 'LIMIT',
  validity: 'DAY',
  tradingSymbol: 'RELIANCE',
  securityId: '11536',
  quantity: 10,
  disclosedQuantity: 0,
  price: 2950.5,
  triggerPrice: 0,
  filledQty: 4,
  remainingQuantity: 6,
  averageTradedPrice: 2950.25,
  createTime: '2026-01-13 09:31:00',
  updateTime: '2026-01-13 09:35:12',
  exchangeTime: '2026-01-13 09:35:12',
};

export const DHAN_REJECTED_ORDER_ROW = {
  ...DHAN_ORDER_ROW,
  orderId: '112111182199',
  orderStatus: 'REJECTED',
  filledQty: 0,
  remainingQuantity: 0,
  averageTradedPrice: 0,
  omsErrorCode: 'DH-906',
  omsErrorDescription: 'RMS: Insufficient funds for this order',
};

export const DHAN_HOLDINGS = [
  {
    exchange: 'ALL',
    tradingSymbol: 'RELIANCE',
    securityId: '11536',
    isin: 'INE002A01018',
    totalQty: 20,
    dpQty: 20,
    t1Qty: 0,
    availableQty: 20,
    collateralQty: 0,
    avgCostPrice: 2900,
    lastTradedPrice: 2950,
  },
];

/** The same holding as Dhan's own sample documents it: no last traded price. */
export const DHAN_HOLDINGS_NO_LTP = [
  {
    exchange: 'ALL',
    tradingSymbol: 'RELIANCE',
    securityId: '11536',
    isin: 'INE002A01018',
    totalQty: 20,
    availableQty: 20,
    collateralQty: 0,
    avgCostPrice: 2900,
  },
];

export const DHAN_POSITIONS = [
  {
    dhanClientId: 'TEST-CLIENT-ID',
    tradingSymbol: 'RELIANCE',
    securityId: '11536',
    positionType: 'LONG',
    exchangeSegment: 'NSE_EQ',
    productType: 'INTRADAY',
    buyAvg: 2900,
    buyQty: 10,
    costPrice: 2900,
    sellAvg: 0,
    sellQty: 0,
    netQty: 10,
    realizedProfit: 0,
    unrealizedProfit: 500,
    multiplier: 1,
  },
];

export const DHAN_FUNDS = {
  dhanClientId: 'TEST-CLIENT-ID',
  availabelBalance: 125000.75,
  sodLimit: 130000,
  collateralAmount: 0,
  receiveableAmount: 0,
  utilizedAmount: 4999.25,
  blockedPayoutAmount: 0,
  withdrawableBalance: 120000.5,
};

/** Two daily candles; timestamps are UNIX seconds (09:15 IST on 12 & 13 Jan 2026). */
export const DHAN_CHART = {
  open: [2900, 2940],
  high: [2960, 2975],
  low: [2890, 2930],
  close: [2945, 2950],
  volume: [1200000, 990000],
  timestamp: [1768189500, 1768275900],
};

/** ISO equivalents of {@link DHAN_CHART}'s timestamps. */
export const DHAN_CHART_ISO = ['2026-01-12T03:45:00.000Z', '2026-01-13T03:45:00.000Z'];

export const DHAN_QUOTE = {
  status: 'success',
  data: {
    NSE_EQ: {
      '11536': {
        last_price: 2950.5,
        last_quantity: 10,
        last_trade_time: '13/01/2026 10:00:00',
        volume: 1234567,
        ohlc: { open: 2940, high: 2975, low: 2930, close: 2945 },
      },
    },
  },
};

export const DHAN_RENEW_TOKEN = {
  accessToken: 'renewed-test-token-not-a-real-jwt',
  expiresAt: '2026-01-14 09:00:00',
};

// Error payloads, one per taxonomy row (docs/02 §2.10).
export const DHAN_AUTH_ERROR = {
  errorType: 'Invalid_Authentication',
  errorCode: 'DH-901',
  errorMessage: 'Client ID or user generated access token is invalid or expired.',
};
export const DHAN_IP_ERROR = {
  errorType: 'Invalid_Authorization',
  errorCode: 'DH-903',
  errorMessage: 'Your IP address is not whitelisted for order placement.',
};
export const DHAN_RATE_LIMIT_ERROR = {
  errorType: 'Rate_Limit',
  errorCode: 'DH-904',
  errorMessage: 'Too many requests on a particular endpoint.',
};
export const DHAN_FUNDS_ERROR = {
  status: 'failed',
  remarks: { error_code: 'DH-906', error_message: 'Insufficient funds to place this order' },
  data: {},
};
export const DHAN_RMS_ERROR = {
  status: 'failed',
  remarks: { error_code: 'DH-906', error_message: 'RMS: blocked for trading in this scrip' },
  data: {},
};
export const DHAN_INSTRUMENT_ERROR = {
  errorType: 'Input_Exception',
  errorCode: 'DH-905',
  errorMessage: 'Invalid security id provided in the request',
};

// ---------------------------------------------------------------------------
// Adapter builder
// ---------------------------------------------------------------------------

export interface TestAdapterOverrides {
  http?: FakeHttpClient | undefined;
  session?: DhanSession | undefined;
  instruments?: DhanInstrumentMaster | undefined;
  now?: Date | undefined;
  deps?: Partial<DhanAdapterDeps> | undefined;
}

export interface TestAdapter {
  adapter: DhanAdapter;
  http: FakeHttpClient;
  instruments: DhanInstrumentMaster;
  session: DhanSession;
}

export function makeAdapter(overrides: TestAdapterOverrides = {}): TestAdapter {
  const http = overrides.http ?? new FakeHttpClient();
  const instruments = overrides.instruments ?? makeMaster();
  const session = overrides.session ?? TEST_SESSION;
  const adapter = new DhanAdapter({
    http,
    session: () => session,
    instruments,
    clock: fixedClock(overrides.now ?? FIXED_NOW),
    baseUrl: TEST_BASE_URL,
    ...overrides.deps,
  });
  return { adapter, http, instruments, session };
}

/** Headers every Dhan call must carry (docs/02 §2.6). */
export const EXPECTED_HEADERS = {
  'access-token': TEST_SESSION.accessToken,
  dhanClientId: TEST_SESSION.clientId,
  'Content-Type': 'application/json',
};
