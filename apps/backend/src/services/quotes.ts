/**
 * `GET /v1/quotes?symbols=…` — live quotes for arbitrary symbols.
 *
 * The approval screen needs an LTP for whatever a proposal names, which is not
 * necessarily something the user already holds, so the cached portfolio read
 * model cannot answer it. This is a pure **read** path: it goes through the same
 * broker gateway as everything else, which means it works unchanged in dry-run
 * (the simulator delegates reads to the real adapter) and it can never place an
 * order — `BrokerReadAdapter` has no method that could.
 */

import { BrokerError } from '@pm/core';
import type { BrokerErrorKind, CanonicalSymbol, Exchange, Quote, Segment } from '@pm/core';
import { SessionUnavailableError, type BrokerGateway } from '../ports/index.js';

/** Matching core's `symbolKey`: `EXCHANGE:SEGMENT:TRADINGSYMBOL`, case-sensitive. */
const EXCHANGES: readonly string[] = ['NSE', 'BSE', 'MCX'];
const SEGMENTS: readonly string[] = ['EQ', 'FNO', 'CURRENCY', 'COMMODITY'];

/** Broker quote APIs are batched; this keeps one request to one batch. */
export const MAX_QUOTE_SYMBOLS = 20;

export type ParseSymbolsResult =
  { ok: true; symbols: CanonicalSymbol[] } | { ok: false; detail: string };

/**
 * Parse the `symbols` query parameter. Strict on purpose: a lower-cased or
 * half-formed key is a client bug, and silently "correcting" it could fetch a
 * quote for the wrong instrument.
 */
export function parseSymbolKeys(raw: string): ParseSymbolsResult {
  const keys = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (keys.length === 0) return { ok: false, detail: 'no symbols supplied' };
  if (keys.length > MAX_QUOTE_SYMBOLS) {
    return {
      ok: false,
      detail: `${keys.length} symbols requested, at most ${MAX_QUOTE_SYMBOLS} per call`,
    };
  }

  const symbols: CanonicalSymbol[] = [];
  for (const key of keys) {
    const parts = key.split(':');
    if (parts.length !== 3) {
      return {
        ok: false,
        detail: `malformed symbol '${key}': expected EXCHANGE:SEGMENT:TRADINGSYMBOL`,
      };
    }
    const [exchange, segment, tradingSymbol] = parts as [string, string, string];
    if (!EXCHANGES.includes(exchange)) {
      return { ok: false, detail: `unknown exchange '${exchange}' in '${key}'` };
    }
    if (!SEGMENTS.includes(segment)) {
      return { ok: false, detail: `unknown segment '${segment}' in '${key}'` };
    }
    if (tradingSymbol.length === 0) {
      return { ok: false, detail: `empty trading symbol in '${key}'` };
    }
    symbols.push({
      exchange: exchange as Exchange,
      segment: segment as Segment,
      tradingSymbol,
    });
  }
  return { ok: true, symbols };
}

export type QuotesResult =
  | { ok: true; quotes: Quote[] }
  | { ok: false; reason: 'INVALID_PAYLOAD'; detail: string }
  | { ok: false; reason: 'SESSION_INVALID'; detail: string }
  | { ok: false; reason: 'BROKER_ERROR'; detail: string; kind: BrokerErrorKind };

export interface QuotesDeps {
  broker: BrokerGateway;
}

export interface QuotesService {
  /** `symbols` is the raw, comma-separated query parameter. */
  getQuotes(uid: string, symbols: string): Promise<QuotesResult>;
}

export function createQuotesService(deps: QuotesDeps): QuotesService {
  return {
    async getQuotes(uid: string, symbols: string): Promise<QuotesResult> {
      const parsed = parseSymbolKeys(symbols);
      if (!parsed.ok) return { ok: false, reason: 'INVALID_PAYLOAD', detail: parsed.detail };

      let quotes: Quote[];
      try {
        const ctx = await deps.broker.forUser(uid);
        quotes = await ctx.adapter.getQuote(parsed.symbols);
      } catch (err) {
        if (err instanceof SessionUnavailableError) {
          return { ok: false, reason: 'SESSION_INVALID', detail: err.message };
        }
        const kind: BrokerErrorKind = err instanceof BrokerError ? err.kind : 'UNKNOWN';
        const detail = err instanceof Error ? err.message : String(err);
        if (kind === 'AUTH_EXPIRED') {
          return { ok: false, reason: 'SESSION_INVALID', detail };
        }
        return { ok: false, reason: 'BROKER_ERROR', detail, kind };
      }
      return { ok: true, quotes };
    },
  };
}
