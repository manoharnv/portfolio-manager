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
  symbolKey,
  BrokerError,
  UnsupportedMappingError,
  type CanonicalSymbol,
  type InstrumentRef,
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
 * Minimal hand-rolled CSV parser — no dependency. Handles quoted fields
 * (including embedded commas and escaped `""` quotes) and both LF and CRLF
 * line endings.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
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
  loadFromCsv(text: string, loadedAt: Date): void {
    const rows = parseCsv(text);
    const header = rows[0];
    if (header === undefined) {
      this.byKey = new Map();
      this.loadedAt = loadedAt;
      return;
    }

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
    for (let r = 1; r < rows.length; r += 1) {
      const cols = rows[r];
      if (cols === undefined) continue;
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
