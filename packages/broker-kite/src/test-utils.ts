/**
 * Fixture builders for tests only. Excluded from the build
 * (`tsconfig.build.json`) and from coverage — nothing in `dist/` imports this
 * file (docs/00-dev-conventions.md §0.5).
 */

import type { CanonicalSymbol } from '@pm/core';
import type { HttpClient, HttpRequest, HttpResponse } from './http.js';
import { KiteInstrumentMaster } from './instruments.js';
import type { KiteSession } from './auth.js';

// ---------------------------------------------------------------------------
// FakeHttpClient — records every request, returns scripted responses. Never
// touches the network.
// ---------------------------------------------------------------------------

type ResponseSource = HttpResponse | ((req: HttpRequest) => HttpResponse | Promise<HttpResponse>);

export class FakeHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];
  private readonly queue: ResponseSource[] = [];
  private handler: ((req: HttpRequest) => HttpResponse | Promise<HttpResponse>) | undefined;

  /** Queue one response (or response-computing function), FIFO. */
  enqueue(res: ResponseSource): void {
    this.queue.push(res);
  }

  /**
   * Alternative to `enqueue`: compute a response per request (e.g. by
   * inspecting `req.url`). Takes priority over anything queued.
   */
  onRequest(handler: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>): void {
    this.handler = handler;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    if (this.handler !== undefined) {
      return this.handler(req);
    }
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error(`FakeHttpClient: no scripted response queued for ${req.method} ${req.url}`);
    }
    return typeof next === 'function' ? next(req) : next;
  }
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    bodyText: JSON.stringify(body),
  };
}

export function kiteSuccess(data: unknown, status = 200): HttpResponse {
  return jsonResponse(status, { status: 'success', data });
}

export function kiteError(
  status: number,
  errorType: string,
  message: string,
  httpStatus: number = status,
): HttpResponse {
  return jsonResponse(httpStatus, { status: 'error', error_type: errorType, message });
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/** A Tuesday, 10:00 IST (04:30 UTC) — well after the 06:00 IST rollover. */
export const FIXED_NOW_ISO = '2026-01-13T04:30:00.000Z';

export function fixedClock(iso: string = FIXED_NOW_ISO): () => Date {
  const instant = new Date(iso);
  return () => instant;
}

export function makeSession(patch?: Partial<KiteSession>): KiteSession {
  return {
    apiKey: 'test-api-key',
    accessToken: 'test-access-token',
    expiresAt: '2026-01-13T18:30:00.000Z',
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// Instrument master fixture — ≥3 instruments across NSE/BSE/NFO (plus MCX),
// with different lot/tick sizes. One field carries an embedded quoted comma
// to exercise the CSV parser.
// ---------------------------------------------------------------------------

export const KITE_INSTRUMENTS_CSV =
  'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n' +
  '738561,2885,RELIANCE,"Reliance Industries, Ltd.",2950.5,,0,0.05,1,EQ,NSE,NSE\n' +
  '500400,1348,TATASTEEL,Tata Steel Limited,145.3,,0,0.05,1,EQ,BSE,BSE\n' +
  '12345678,54321,NIFTY24DEC22000CE,NIFTY 24 DEC 22000 CE,120.15,2024-12-26,22000,0.05,25,CE,NFO-OPT,NFO\n' +
  '9999999,8888,GOLDPETAL26FEBFUT,GOLD PETAL FUT,5800,2026-02-28,0,1,1,FUT,MCX-FUT,MCX\n' +
  // A row on a segment @pm/core has no mapping for (currency) — must be
  // skipped at load time rather than failing the whole parse.
  '1111111,2222,USDINR26FEBFUT,USDINR FUT,83.5,2026-02-28,0,0.0025,1,FUT,CDS-FUT,CDS\n';

export const NSE_RELIANCE: CanonicalSymbol = {
  exchange: 'NSE',
  segment: 'EQ',
  tradingSymbol: 'RELIANCE',
};
export const BSE_TATASTEEL: CanonicalSymbol = {
  exchange: 'BSE',
  segment: 'EQ',
  tradingSymbol: 'TATASTEEL',
};
/** NFO options/futures map to neutral (NSE, FNO) — Kite has no separate NFO exchange enum value. */
export const NFO_NIFTY_CE: CanonicalSymbol = {
  exchange: 'NSE',
  segment: 'FNO',
  tradingSymbol: 'NIFTY24DEC22000CE',
};
export const MCX_GOLDPETAL: CanonicalSymbol = {
  exchange: 'MCX',
  segment: 'COMMODITY',
  tradingSymbol: 'GOLDPETAL26FEBFUT',
};

export function makeLoadedInstrumentMaster(loadedAt: Date = fixedClock()()): KiteInstrumentMaster {
  const master = new KiteInstrumentMaster();
  master.loadFromCsv(KITE_INSTRUMENTS_CSV, loadedAt);
  return master;
}

// ---------------------------------------------------------------------------
// Sample Kite response payloads — one builder per endpoint's `data` shape.
// ---------------------------------------------------------------------------

export function sampleOrderIdResponse(orderId = '151220000000000'): HttpResponse {
  return kiteSuccess({ order_id: orderId });
}

export interface SampleOrderEntryPatch {
  order_id?: string;
  status?: string;
  filled_quantity?: number;
  pending_quantity?: number;
  average_price?: number | null;
  status_message?: string | null;
  order_timestamp?: string | null;
  exchange_update_timestamp?: string | null;
}

export function sampleOrderEntry(patch?: SampleOrderEntryPatch): Record<string, unknown> {
  return {
    order_id: '151220000000000',
    tradingsymbol: 'RELIANCE',
    exchange: 'NSE',
    order_type: 'LIMIT',
    transaction_type: 'BUY',
    validity: 'DAY',
    product: 'CNC',
    quantity: 10,
    price: 2950.5,
    trigger_price: 0,
    status: 'COMPLETE',
    filled_quantity: 10,
    pending_quantity: 0,
    average_price: 2950.5,
    status_message: null,
    order_timestamp: '2026-01-13 09:20:00',
    exchange_update_timestamp: '2026-01-13 09:20:05',
    tag: 'abc123',
    ...patch,
  };
}

export function sampleOrderHistoryResponse(entries?: Record<string, unknown>[]): HttpResponse {
  return kiteSuccess(
    entries ?? [sampleOrderEntry({ status: 'OPEN', filled_quantity: 0 }), sampleOrderEntry()],
  );
}

export function sampleOrdersListResponse(entries?: Record<string, unknown>[]): HttpResponse {
  return kiteSuccess(entries ?? [sampleOrderEntry()]);
}

export function sampleHoldingsResponse(): HttpResponse {
  return kiteSuccess([
    {
      tradingsymbol: 'RELIANCE',
      exchange: 'NSE',
      isin: 'INE002A01018',
      quantity: 10,
      average_price: 2900,
      last_price: 2950.5,
      close_price: 2945,
      pnl: 505,
      product: 'CNC',
    },
  ]);
}

export function samplePositionsResponse(): HttpResponse {
  return kiteSuccess({
    net: [
      {
        tradingsymbol: 'RELIANCE',
        exchange: 'NSE',
        product: 'MIS',
        quantity: 5,
        average_price: 2900,
        last_price: 2950.5,
        realised: 0,
        unrealised: 252.5,
      },
    ],
    day: [],
  });
}

export function sampleMarginsResponse(): HttpResponse {
  return kiteSuccess({
    equity: {
      enabled: true,
      net: 495_000,
      available: {
        adhoc_margin: 0,
        cash: 500_000,
        opening_balance: 500_000,
        live_balance: 495_000,
        collateral: 0,
        intraday_payin: 0,
      },
      utilised: {
        debits: 5_000,
        exposure: 0,
        span: 0,
      },
    },
    commodity: {
      enabled: false,
      net: 0,
      available: { cash: 0 },
      utilised: { debits: 0 },
    },
  });
}

export function sampleHistoricalResponse(): HttpResponse {
  return kiteSuccess({
    candles: [
      ['2026-01-12T09:15:00+0530', 2940, 2955, 2935, 2950, 120_000],
      ['2026-01-12T09:16:00+0530', 2950, 2958, 2948, 2952.5, 98_000],
    ],
  });
}

export function sampleQuoteResponse(): HttpResponse {
  return kiteSuccess({
    'NSE:RELIANCE': {
      instrument_token: 738561,
      last_price: 2950.5,
      last_trade_time: '2026-01-13 09:59:58',
      timestamp: '2026-01-13 10:00:00',
      volume: 1_000_000,
      ohlc: { open: 2940, high: 2960, low: 2930, close: 2945 },
    },
  });
}

export function sampleSessionTokenResponse(patch?: Record<string, unknown>): HttpResponse {
  return kiteSuccess({
    user_id: 'AB1234',
    access_token: 'daily-access-token',
    public_token: 'pub-token',
    refresh_token: '',
    user_name: 'Test User',
    login_time: '2026-01-13 09:00:00',
    ...patch,
  });
}
