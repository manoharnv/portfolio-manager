/**
 * Dhan scrip-master (instrument master) — docs/02 §2.9.
 *
 * `resolveInstrument` is the single choke point that turns a `CanonicalSymbol`
 * into a Dhan `securityId` + lot size + tick size, which is what every
 * pre-flight order validation is measured against. Consequences:
 *
 *   - a row without a usable lot size / tick size is **not indexed**, so it
 *     surfaces as `INSTRUMENT_UNKNOWN` rather than as an order priced against a
 *     zero tick grid (fail closed, docs/00 §0.7.1);
 *   - `isStale()` is asked by the caller before every trading session — a master
 *     of unknown age is stale.
 *
 * Loading is injected (`loadFromCsv` takes the text and the instant it was
 * fetched) so nothing here reads the clock or the network.
 */

import {
  BrokerError,
  fromDhanExchangeSegment,
  symbolKey,
  toDhanExchangeSegment,
  type CanonicalSymbol,
  type InstrumentRef,
  parseCsvRows,
  type Segment,
} from '@pm/core';
import { dhanHttpError, dhanParseError } from './errors.js';
import type { HttpClient } from './http.js';

/**
 * VERIFY-LIVE: confirm the scrip-master URL and whether the compact or the
 * `-detailed` file carries the columns below (the detailed file is ~10× larger).
 */
export const DHAN_SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';
export const DHAN_SCRIP_MASTER_DETAILED_URL =
  'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';

/** One trading day; the master is re-downloaded every morning (docs/02 §2.9). */
export const DEFAULT_MASTER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A scrip-master row. Superset of core's `InstrumentRef`: the chart endpoints
 * need Dhan's `instrument` and `expiryCode`, which the neutral type has no
 * field for (see the report's "core changes" note).
 */
export interface DhanInstrument {
  canonical: CanonicalSymbol;
  securityId: string;
  /** `NSE_EQ` | `BSE_EQ` | `NSE_FNO` | `MCX_COMM`. */
  exchangeSegment: string;
  lotSize: number;
  tickSize: number;
  /** `EQUITY` | `INDEX` | `FUTIDX` | `OPTIDX` | `FUTSTK` | `OPTSTK` | … */
  instrumentType: string;
  expiryCode: number;
}

export interface MasterStats {
  /** Data rows seen (header excluded). */
  rows: number;
  /** Rows indexed into the lookup. */
  indexed: number;
  /** Rows dropped: unsupported segment, unusable lot/tick, or missing id. */
  skipped: number;
  /** Rows whose key was already present; the first row wins. */
  duplicates: number;
}

export interface LoadCsvOptions {
  /**
   * Divisor applied to the raw tick-size column.
   *
   * VERIFY-LIVE: Dhan has published `SEM_TICK_SIZE` in paise (`5` ⇒ ₹0.05) in
   * some vintages of the file and in rupees (`0.05`) in others. Check one NSE
   * equity row against a known tick before trusting the default of 1.
   */
  tickSizeDivisor?: number | undefined;
  /**
   * Neutral segments to index; rows on any other segment are skipped without
   * being materialised. The full file is ~200k rows, all but a few thousand
   * of them F&O contracts — indexing everything costs ~350 MB per process,
   * which the 1 GB VM cannot afford twice (docs/11 §11.6). `undefined` ⇒ all
   * supported segments.
   */
  segments?: readonly Segment[] | undefined;
}

// ---------------------------------------------------------------------------
// CSV — `@pm/core`'s streaming RFC-4180 reader; `parseCsv` is kept for
// callers and tests that want the whole (small) file at once.
// ---------------------------------------------------------------------------

export { parseCsv } from '@pm/core';

// ---------------------------------------------------------------------------
// Column resolution. Dhan has shipped two header families; both are accepted so
// a file swap does not silently produce an empty master.
// VERIFY-LIVE: confirm the exact header names in the file you download.
// ---------------------------------------------------------------------------

const COLUMN_ALIASES = {
  exchange: ['SEM_EXM_EXCH_ID', 'EXCH_ID', 'EXCHANGE'],
  segment: ['SEM_SEGMENT', 'SEGMENT'],
  securityId: ['SEM_SMST_SECURITY_ID', 'SECURITY_ID'],
  tradingSymbol: ['SEM_TRADING_SYMBOL', 'TRADING_SYMBOL', 'SYMBOL_NAME'],
  lotSize: ['SEM_LOT_UNITS', 'LOT_SIZE', 'LOT_UNITS'],
  tickSize: ['SEM_TICK_SIZE', 'TICK_SIZE'],
  instrumentType: ['SEM_INSTRUMENT_NAME', 'INSTRUMENT', 'INSTRUMENT_TYPE'],
  expiryCode: ['SEM_EXPIRY_CODE', 'EXPIRY_CODE'],
} as const;

type ColumnName = keyof typeof COLUMN_ALIASES;

/** Header name → column index, resolved through {@link COLUMN_ALIASES}. */
function resolveColumns(header: readonly string[]): Partial<Record<ColumnName, number>> {
  const index = new Map<string, number>();
  header.forEach((raw, i) => {
    const name = raw.trim().toUpperCase();
    if (name.length > 0 && !index.has(name)) index.set(name, i);
  });
  const out: Partial<Record<ColumnName, number>> = {};
  for (const [column, aliases] of Object.entries(COLUMN_ALIASES) as [
    ColumnName,
    readonly string[],
  ][]) {
    for (const alias of aliases) {
      const at = index.get(alias);
      if (at !== undefined) {
        out[column] = at;
        break;
      }
    }
  }
  return out;
}

/**
 * CSV `(exchange, segment)` → Dhan `exchangeSegment` code. The segment column is
 * a single letter in the legacy file (`E`/`D`/`C`/`M`) and a word in the newer
 * one; a file that already holds the full code (`NSE_EQ`) passes straight
 * through. Anything else is an instrument we do not trade and is skipped.
 */
export function toExchangeSegmentCode(exchange: string, segment: string): string | undefined {
  const ex = exchange.trim().toUpperCase();
  const seg = segment.trim().toUpperCase();
  if (seg.includes('_')) return seg;

  const family =
    seg === 'E' || seg === 'EQ' || seg === 'EQUITY'
      ? 'EQ'
      : seg === 'D' || seg === 'DERIVATIVE' || seg === 'FNO' || seg === 'F&O'
        ? 'FNO'
        : seg === 'M' || seg === 'COMM' || seg === 'COMMODITY'
          ? 'COMM'
          : undefined;
  if (family === undefined) return undefined;
  if (family === 'EQ' && (ex === 'NSE' || ex === 'BSE')) return `${ex}_EQ`;
  if (family === 'FNO' && ex === 'NSE') return 'NSE_FNO';
  if (family === 'COMM' && ex === 'MCX') return 'MCX_COMM';
  return undefined;
}

const indexKey = (exchangeSegment: string, tradingSymbol: string): string =>
  `${exchangeSegment}|${tradingSymbol.trim().toUpperCase()}`;

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ---------------------------------------------------------------------------

/**
 * In-memory instrument master. Construct once per process, reload daily.
 * Immutable from the outside: `resolve` never mutates, and the class holds no
 * clock — `isStale` is asked with the caller's `now`.
 */
export class DhanInstrumentMaster {
  private readonly byKey = new Map<string, DhanInstrument>();
  private loaded: Date | undefined;
  private stats: MasterStats = { rows: 0, indexed: 0, skipped: 0, duplicates: 0 };

  /** Instant the current contents were fetched, or `undefined` if never loaded. */
  get loadedAt(): Date | undefined {
    return this.loaded;
  }

  get size(): number {
    return this.byKey.size;
  }

  getStats(): MasterStats {
    return { ...this.stats };
  }

  /**
   * Replace the contents from a scrip-master CSV. Throws when the file has no
   * header or lacks the columns we depend on — an empty master would otherwise
   * masquerade as "every symbol is unknown".
   */
  loadFromCsv(text: string, loadedAt: Date, opts: LoadCsvOptions = {}): MasterStats {
    const divisor = opts.tickSizeDivisor ?? 1;
    if (!Number.isFinite(divisor) || divisor <= 0) {
      throw new BrokerError('UNKNOWN', `Invalid tickSizeDivisor: ${String(opts.tickSizeDivisor)}`);
    }

    const segments = opts.segments === undefined ? undefined : new Set<Segment>(opts.segments);

    const rows = parseCsvRows(text);
    const first = rows.next();
    if (first.done === true) {
      throw dhanParseError('scrip master', 'the CSV is empty', text.slice(0, 200));
    }
    const header = first.value;
    const cols = resolveColumns(header);
    const required: ColumnName[] = ['exchange', 'segment', 'securityId', 'tradingSymbol'];
    const missing = required.filter((c) => cols[c] === undefined);
    if (missing.length > 0) {
      throw dhanParseError(
        'scrip master',
        `missing required column(s): ${missing.join(', ')} (header: ${header.join(',')})`,
        header,
      );
    }

    const next = new Map<string, DhanInstrument>();
    const stats: MasterStats = { rows: 0, indexed: 0, skipped: 0, duplicates: 0 };

    for (const row of rows) {
      if (row.length === 1 && (row[0] ?? '').trim() === '') continue;
      stats.rows += 1;

      const at = (c: ColumnName): string | undefined => {
        const i = cols[c];
        return i === undefined ? undefined : row[i];
      };

      // Segment first: for the bulk of the file (F&O) nothing else is looked at.
      const exchangeSegment = toExchangeSegmentCode(at('exchange') ?? '', at('segment') ?? '');
      if (exchangeSegment === undefined) {
        stats.skipped += 1;
        continue;
      }
      let neutral: ReturnType<typeof fromDhanExchangeSegment>;
      try {
        neutral = fromDhanExchangeSegment(exchangeSegment);
      } catch {
        stats.skipped += 1;
        continue;
      }
      if (segments !== undefined && !segments.has(neutral.segment)) {
        stats.skipped += 1;
        continue;
      }

      const tradingSymbol = (at('tradingSymbol') ?? '').trim();
      const securityId = (at('securityId') ?? '').trim();
      const lotSize = num(at('lotSize')) ?? 1;
      const rawTick = num(at('tickSize'));
      const tickSize = rawTick === undefined ? undefined : rawTick / divisor;

      if (
        tradingSymbol.length === 0 ||
        securityId.length === 0 ||
        !Number.isInteger(lotSize) ||
        lotSize < 1 ||
        tickSize === undefined ||
        tickSize <= 0
      ) {
        stats.skipped += 1;
        continue;
      }

      const canonical: CanonicalSymbol = { ...neutral, tradingSymbol };

      const key = indexKey(exchangeSegment, tradingSymbol);
      if (next.has(key)) {
        stats.duplicates += 1;
        continue;
      }
      next.set(key, {
        canonical,
        securityId,
        exchangeSegment,
        lotSize,
        tickSize,
        instrumentType: (at('instrumentType') ?? '').trim().toUpperCase(),
        expiryCode: num(at('expiryCode')) ?? 0,
      });
      stats.indexed += 1;
    }

    this.byKey.clear();
    for (const [key, value] of next) this.byKey.set(key, value);
    this.loaded = loadedAt;
    this.stats = stats;
    return this.getStats();
  }

  /** The Dhan-flavoured row, used internally for chart/quote requests. */
  resolveDhan(sym: CanonicalSymbol): DhanInstrument {
    if (this.loaded === undefined) {
      throw new BrokerError(
        'INSTRUMENT_UNKNOWN',
        `Dhan instrument master not loaded; cannot resolve ${symbolKey(sym)}`,
        sym,
      );
    }
    const exchangeSegment = toDhanExchangeSegment(sym);
    const found = this.byKey.get(indexKey(exchangeSegment, sym.tradingSymbol));
    if (found === undefined) {
      throw new BrokerError(
        'INSTRUMENT_UNKNOWN',
        `No Dhan instrument for ${symbolKey(sym)} (${exchangeSegment})`,
        sym,
      );
    }
    return found;
  }

  /** The neutral handle handed back across the adapter boundary (docs/02 §2.2). */
  resolve(sym: CanonicalSymbol): InstrumentRef {
    const row = this.resolveDhan(sym);
    return {
      broker: 'dhan',
      canonical: row.canonical,
      brokerInstrumentId: row.securityId,
      exchangeSegmentCode: row.exchangeSegment,
      lotSize: row.lotSize,
      tickSize: row.tickSize,
    };
  }

  /** `true` when never loaded (unknown age is stale) or older than `maxAgeMs`. */
  isStale(now: Date, maxAgeMs: number = DEFAULT_MASTER_MAX_AGE_MS): boolean {
    if (this.loaded === undefined) return true;
    return now.getTime() - this.loaded.getTime() > maxAgeMs;
  }
}

/**
 * Download the scrip master. Kept separate from the parser so the master can be
 * loaded from disk, Firestore or a fixture without going near the network.
 */
export async function fetchCsv(
  http: HttpClient,
  url: string = DHAN_SCRIP_MASTER_URL,
): Promise<string> {
  const res = await http.request({ method: 'GET', url, headers: { Accept: 'text/csv' } });
  if (res.status < 200 || res.status >= 300) {
    throw dhanHttpError(res, 'scrip master download');
  }
  if (res.bodyText.trim().length === 0) {
    throw dhanParseError('scrip master download', 'empty body', res.bodyText);
  }
  return res.bodyText;
}
