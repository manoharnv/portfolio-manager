/**
 * Kite instrument master — docs/02-broker-abstraction.md §2.9.
 *
 * Kite's `/instruments` dump is a CSV with (at least) these columns:
 * `instrument_token, exchange_token, tradingsymbol, name, last_price, expiry,
 * strike, tick_size, lot_size, instrument_type, segment, exchange`.
 *
 * We only rely on five of them (`instrument_token`, `tradingsymbol`,
 * `tick_size`, `lot_size`, `exchange`) — resolved by name via the header row,
 * not by position, so column reordering upstream doesn't break parsing.
 *
 * A row whose `exchange` has no neutral (Exchange, Segment) equivalent in
 * `@pm/core`'s mapping table (e.g. currency, BFO) is skipped rather than
 * failing the whole load: we simply never resolve symbols on segments this
 * system doesn't trade, which is the correct fail-closed behaviour for
 * `resolve()` regardless.
 */

import {
  fromKiteExchangeSegment,
  parseCsvRows,
  symbolKey,
  BrokerError,
  UnsupportedMappingError,
  type CanonicalSymbol,
  type InstrumentRef,
  type Segment,
} from '@pm/core';
import type { HttpClient } from './http.js';
import { mapTransportError } from './errors.js';

const REQUIRED_COLUMNS = [
  'instrument_token',
  'tradingsymbol',
  'tick_size',
  'lot_size',
  'exchange',
] as const;

/**
 * CSV parsing is `@pm/core`'s streaming RFC-4180 reader (quoted fields,
 * embedded commas, escaped `""`, LF/CRLF); `parseCsv` is kept for callers and
 * tests that want the whole (small) file at once.
 */
export { parseCsv } from '@pm/core';

export interface LoadCsvOptions {
  /**
   * Neutral segments to index; rows on any other segment are skipped without
   * being materialised. The dump is ~100k rows, mostly F&O — on the 1 GB VM
   * indexing everything is memory the backend does not have (docs/11 §11.6).
   * `undefined` ⇒ all supported segments.
   */
  segments?: readonly Segment[] | undefined;
}

function indexColumns(header: readonly string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  header.forEach((name, i) => {
    idx[name.trim()] = i;
  });
  return idx;
}

export class KiteInstrumentMaster {
  private byKey = new Map<string, InstrumentRef>();
  private loadedAt: Date | undefined = undefined;

  /** Parse a full `/instruments` CSV dump and replace the in-memory index. */
  loadFromCsv(text: string, loadedAt: Date, opts: LoadCsvOptions = {}): void {
    const segments = opts.segments === undefined ? undefined : new Set<Segment>(opts.segments);
    const rows = parseCsvRows(text);
    const first = rows.next();
    if (first.done === true) {
      this.byKey = new Map();
      this.loadedAt = loadedAt;
      return;
    }
    const header = first.value;

    const idx = indexColumns(header);
    const columnIndex = (name: string): number => {
      const i = idx[name];
      if (i === undefined) {
        throw new Error(`Kite instruments CSV is missing required column "${name}"`);
      }
      return i;
    };
    for (const name of REQUIRED_COLUMNS) columnIndex(name);
    const iToken = columnIndex('instrument_token');
    const iSymbol = columnIndex('tradingsymbol');
    const iTick = columnIndex('tick_size');
    const iLot = columnIndex('lot_size');
    const iExchange = columnIndex('exchange');

    const newMap = new Map<string, InstrumentRef>();
    for (const cols of rows) {
      if (cols.length === 1 && cols[0] === '') continue; // trailing blank line

      const exchangeCode = cols[iExchange] ?? '';
      const tradingSymbol = cols[iSymbol] ?? '';
      if (exchangeCode === '' || tradingSymbol === '') continue;

      let neutral: { exchange: CanonicalSymbol['exchange']; segment: CanonicalSymbol['segment'] };
      try {
        neutral = fromKiteExchangeSegment(exchangeCode);
      } catch (err) {
        if (err instanceof UnsupportedMappingError) continue; // segment we don't trade — skip
        throw err;
      }
      if (segments !== undefined && !segments.has(neutral.segment)) continue;

      const canonical: CanonicalSymbol = { ...neutral, tradingSymbol };
      const ref: InstrumentRef = {
        broker: 'kite',
        canonical,
        brokerInstrumentId: cols[iToken] ?? '',
        exchangeSegmentCode: exchangeCode,
        lotSize: Number(cols[iLot]) || 1,
        tickSize: Number(cols[iTick]) || 0.05,
      };
      newMap.set(symbolKey(canonical), ref);
    }

    this.byKey = newMap;
    this.loadedAt = loadedAt;
  }

  /** Throws `BrokerError('INSTRUMENT_UNKNOWN')` — never returns `undefined`. */
  resolve(sym: CanonicalSymbol): InstrumentRef {
    const ref = this.byKey.get(symbolKey(sym));
    if (ref === undefined) {
      throw new BrokerError('INSTRUMENT_UNKNOWN', `No Kite instrument for ${symbolKey(sym)}`, sym);
    }
    return ref;
  }

  has(sym: CanonicalSymbol): boolean {
    return this.byKey.has(symbolKey(sym));
  }

  get size(): number {
    return this.byKey.size;
  }

  /** `true` when never loaded, or loaded more than `maxAgeMs` before `now`. */
  isStale(now: Date, maxAgeMs: number): boolean {
    if (this.loadedAt === undefined) return true;
    return now.getTime() - this.loadedAt.getTime() > maxAgeMs;
  }
}

/** Injectable fetch of the raw CSV text — kept separate from parsing/loading. */
export async function fetchCsv(http: HttpClient, url: string): Promise<string> {
  let res;
  try {
    res = await http.request({ method: 'GET', url, headers: {} });
  } catch (err) {
    throw mapTransportError(err);
  }
  if (res.status < 200 || res.status >= 300) {
    // VERIFY-LIVE: confirm whether GET /instruments ever requires the
    // Authorization header, and what an error body looks like (plain
    // text/HTML vs. a JSON envelope) — inferred from public docs as an
    // unauthenticated, always-200-when-reachable endpoint.
    throw new BrokerError(
      'UNKNOWN',
      `Failed to fetch Kite instruments CSV: HTTP ${String(res.status)}`,
      res.bodyText,
    );
  }
  return res.bodyText;
}
