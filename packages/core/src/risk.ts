/**
 * Portfolio risk manager — docs/10-multi-strategy.md §10.6.
 *
 * Per-book limits are not enough: correlated books can sink the whole account.
 * These controls sit *above* the books and extend the guardrail suite. Pure
 * checks over plain numbers and records — no I/O, no clock of its own.
 *
 * Boundary semantics: every control trips when the metric **reaches** its limit,
 * not only when it exceeds it. Ties go to safety.
 */

import type { Product } from './domain.js';
import { COORDINATOR_DEFAULTS } from './coordinator.js';
import { MARKET_CLOSE_MINUTES_IST, istMinuteOfDay, type GuardrailCheck } from './guardrails.js';
import type { Book, Config, Horizon } from './schemas.js';

/** MIS positions this close to the session end must be squared off. */
export const DEFAULT_SQUARE_OFF_BUFFER_MINUTES = 15;
/** Below this % of free margin, intraday books get throttled first. */
export const DEFAULT_MARGIN_HEADROOM_PCT = 20;

export const RISK_CONTROL_NAMES = [
  'portfolioDailyLossStop',
  'bookDailyLossStop',
  'grossExposureCap',
  'symbolConcentrationCap',
  'marginHeadroom',
  'intradaySquareOff',
] as const;

export type RiskControlName = (typeof RISK_CONTROL_NAMES)[number];

export interface OpenIntradayPosition {
  bookId: string;
  symbolKey: string;
  product: Product;
  /** Signed; a zero qty is ignored. */
  qty: number;
}

export interface SquareOffFlag extends OpenIntradayPosition {
  minutesToClose: number;
}

export interface RiskLimits {
  /** Portfolio-wide day loss (positive rupee number) that trips the kill switch. */
  portfolioDailyLossStopInr: number;
  /** Σ |position value| across books. */
  maxGrossExposureInr: number;
  /** Per-symbol exposure cap, as a % of `config.totalManagedCapitalInr`. */
  maxSymbolConcentrationPct: number;
  marginHeadroomPct?: number | undefined;
  squareOffBufferMinutes?: number | undefined;
}

export interface RiskInput {
  config: Config;
  books: readonly Book[];
  limits: RiskLimits;
  /** Realized + unrealized day P&L per bookId. Negative = loss. */
  bookDayPnlInr: Readonly<Record<string, number>>;
  /** Realized + unrealized day P&L across all books. Negative = loss. */
  portfolioDayPnlInr: number;
  grossExposureInr: number;
  /** |position value| per symbolKey. */
  exposureBySymbolInr: Readonly<Record<string, number>>;
  availableMarginInr: number;
  /** Combined margin the intraday books need right now. */
  requiredIntradayMarginInr: number;
  openIntradayPositions?: readonly OpenIntradayPosition[] | undefined;
  now: Date | string;
}

export interface RiskAssessment {
  /** `false` when any hard control tripped (kill switch, pause, exposure block). */
  ok: boolean;
  /** Portfolio daily-loss stop breached → halt ALL new orders. */
  tripKillSwitch: boolean;
  /** Books to pause for the day. */
  pauseBooks: string[];
  /** Gross exposure cap breached → block new exposure. */
  blockNewExposure: boolean;
  /** Symbols at/over the concentration cap → block adds to these names. */
  blockedSymbols: string[];
  /** Intraday books to throttle first when margin headroom is thin. */
  throttleBooks: string[];
  /** MIS positions inside the square-off window. */
  squareOffDue: SquareOffFlag[];
  checks: GuardrailCheck[];
}

const check = (name: RiskControlName, ok: boolean, detail: string): GuardrailCheck => ({
  name,
  ok,
  detail,
});

function intradayPrecedenceLast(config: Config): readonly Horizon[] {
  const precedence = config.coordinator?.precedence ?? COORDINATOR_DEFAULTS.precedence;
  return [...precedence].reverse();
}

/** Run every portfolio-level risk control. */
export function assessPortfolioRisk(input: RiskInput): RiskAssessment {
  const { limits } = input;
  const checks: GuardrailCheck[] = [];

  // 1. Portfolio daily-loss stop → kill switch -------------------------------
  const portfolioLoss = -input.portfolioDayPnlInr;
  const tripKillSwitch =
    limits.portfolioDailyLossStopInr > 0 && portfolioLoss >= limits.portfolioDailyLossStopInr;
  checks.push(
    check(
      'portfolioDailyLossStop',
      !tripKillSwitch,
      `portfolio day P&L ₹${input.portfolioDayPnlInr} vs stop ₹${limits.portfolioDailyLossStopInr}` +
        (tripKillSwitch ? ' — KILL SWITCH' : ''),
    ),
  );

  // 2. Per-book daily-loss stop → pause the book ----------------------------
  const pauseBooks: string[] = [];
  for (const book of input.books) {
    const pnl = input.bookDayPnlInr[book.id] ?? 0;
    const stop = book.risk.dailyLossStopInr;
    if (stop > 0 && -pnl >= stop) pauseBooks.push(book.id);
  }
  checks.push(
    check(
      'bookDailyLossStop',
      pauseBooks.length === 0,
      pauseBooks.length === 0
        ? 'no book has breached its daily loss stop'
        : `books paused for the day: ${pauseBooks.join(', ')}`,
    ),
  );

  // 3. Gross exposure cap ---------------------------------------------------
  const blockNewExposure = input.grossExposureInr >= limits.maxGrossExposureInr;
  checks.push(
    check(
      'grossExposureCap',
      !blockNewExposure,
      `gross exposure ₹${input.grossExposureInr} vs cap ₹${limits.maxGrossExposureInr}`,
    ),
  );

  // 4. Per-symbol concentration cap -----------------------------------------
  const basis = input.config.totalManagedCapitalInr;
  const blockedSymbols: string[] = [];
  for (const [sym, exposure] of Object.entries(input.exposureBySymbolInr)) {
    if (!(exposure > 0)) continue;
    if (basis <= 0) {
      // No capital basis to measure against: fail closed.
      blockedSymbols.push(sym);
      continue;
    }
    const pct = (exposure / basis) * 100;
    if (pct >= limits.maxSymbolConcentrationPct) blockedSymbols.push(sym);
  }
  blockedSymbols.sort();
  checks.push(
    check(
      'symbolConcentrationCap',
      blockedSymbols.length === 0,
      blockedSymbols.length === 0
        ? `no symbol is at the ${limits.maxSymbolConcentrationPct}% concentration cap`
        : `at/over the ${limits.maxSymbolConcentrationPct}% cap: ${blockedSymbols.join(', ')}`,
    ),
  );

  // 5. Margin headroom → throttle intraday books first ----------------------
  const headroomPct =
    input.availableMarginInr > 0
      ? ((input.availableMarginInr - input.requiredIntradayMarginInr) / input.availableMarginInr) *
        100
      : 0;
  const headroomLimit = limits.marginHeadroomPct ?? DEFAULT_MARGIN_HEADROOM_PCT;
  const throttle = headroomPct <= headroomLimit;
  const intradayOrder = intradayPrecedenceLast(input.config);
  const throttleBooks = throttle
    ? input.books
        .filter((b) => b.enabled && b.product === 'INTRADAY')
        .sort((a, b) => intradayOrder.indexOf(a.id) - intradayOrder.indexOf(b.id))
        .map((b) => b.id)
    : [];
  checks.push(
    check(
      'marginHeadroom',
      !throttle,
      `margin headroom ${headroomPct.toFixed(2)}% vs floor ${headroomLimit}%` +
        (throttle && throttleBooks.length > 0 ? ` — throttle ${throttleBooks.join(', ')}` : ''),
    ),
  );

  // 6. Intraday square-off guard -------------------------------------------
  const buffer = limits.squareOffBufferMinutes ?? DEFAULT_SQUARE_OFF_BUFFER_MINUTES;
  const minutesToClose = MARKET_CLOSE_MINUTES_IST - istMinuteOfDay(input.now);
  const squareOffDue: SquareOffFlag[] =
    minutesToClose >= 0 && minutesToClose <= buffer
      ? (input.openIntradayPositions ?? [])
          .filter((p) => p.product === 'INTRADAY' && p.qty !== 0)
          .map((p) => ({ ...p, minutesToClose }))
      : [];
  checks.push(
    check(
      'intradaySquareOff',
      squareOffDue.length === 0,
      squareOffDue.length === 0
        ? `${minutesToClose} min to close; nothing to square off`
        : `${squareOffDue.length} MIS position(s) open with ${minutesToClose} min to close ` +
            `(buffer ${buffer} min)`,
    ),
  );

  return {
    ok:
      !tripKillSwitch &&
      pauseBooks.length === 0 &&
      !blockNewExposure &&
      blockedSymbols.length === 0,
    tripKillSwitch,
    pauseBooks,
    blockNewExposure,
    blockedSymbols,
    throttleBooks,
    squareOffDue,
    checks,
  };
}
