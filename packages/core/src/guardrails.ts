/**
 * The guardrail suite — docs/04-execution-backend.md §4.5.
 *
 * Pure functions only. The same library runs in two places:
 *   - the strategy engine, as a pre-filter (don't bother the human with
 *     impossible proposals);
 *   - the execution backend, authoritatively, against LIVE quote/funds/session.
 *
 * Two rules govern the whole file:
 *   1. **Fail closed.** A check whose evidence is missing (no quote, no funds,
 *      no instrument, no session, no idempotency key) FAILS. "Unknown" is never
 *      "fine".
 *   2. **Code ceilings win.** The effective cap is always
 *      `min(config value, ABS_* constant)`; `runGuardrails` re-clamps internally
 *      so a caller that forgets {@link clampConfigToCeilings} is still safe.
 */

import type { Funds, InstrumentRef, NormalizedOrder, Quote, SessionStatus } from './domain.js';
import { symbolKey } from './domain.js';
import type { Config, ProposalStatus } from './schemas.js';
import { EXECUTABLE_STATUSES } from './proposal-state.js';

// ---------------------------------------------------------------------------
// Code-level absolute ceilings (constants, NOT user-editable) — docs/04 §4.5.
// A compromised or mis-set config can never authorise more than these.
// ---------------------------------------------------------------------------

export const ABS_MAX_ORDER_VALUE_INR = 500_000;
export const ABS_MAX_DAILY_NOTIONAL_INR = 2_000_000;
export const ABS_MAX_ORDERS_PER_DAY = 50;

/** Refuse to place if the broker token dies within this margin (docs/04 §4.6). */
export const SESSION_EXPIRY_MARGIN_SECONDS = 120;

// ---------------------------------------------------------------------------
// Market hours (NSE). Mon–Fri 09:15–15:30 IST, compared at minute granularity.
// ---------------------------------------------------------------------------

export const IST_OFFSET_MINUTES = 330;
export const MARKET_OPEN_MINUTES_IST = 9 * 60 + 15; // 555
export const MARKET_CLOSE_MINUTES_IST = 15 * 60 + 30; // 930

/** Optional trading-calendar hook. Holidays are IST `YYYY-MM-DD` dates. */
export interface MarketCalendar {
  holidays: readonly string[];
}

interface IstParts {
  dateKey: string;
  /** 0 = Sunday … 6 = Saturday, in IST. */
  weekday: number;
  minuteOfDay: number;
  clock: string;
}

function resolveNow(now: Date | string): Date {
  const d = typeof now === 'string' ? new Date(now) : now;
  if (Number.isNaN(d.getTime())) {
    throw new TypeError(`Invalid 'now': ${JSON.stringify(now)}`);
  }
  return d;
}

const pad = (n: number): string => String(n).padStart(2, '0');

function istParts(now: Date | string): IstParts {
  const shifted = new Date(resolveNow(now).getTime() + IST_OFFSET_MINUTES * 60_000);
  const minuteOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return {
    dateKey: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    weekday: shifted.getUTCDay(),
    minuteOfDay,
    clock: `${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)} IST`,
  };
}

/** IST trading date (`YYYY-MM-DD`) for an instant — the key for daily aggregates. */
export function istDateKey(now: Date | string): string {
  return istParts(now).dateKey;
}

/** Minutes since IST midnight. */
export function istMinuteOfDay(now: Date | string): number {
  return istParts(now).minuteOfDay;
}

/**
 * NSE session test. Weekends are closed; `calendar.holidays` (IST `YYYY-MM-DD`)
 * closes additional days. Holidays are deliberately NOT hard-coded — the list is
 * supplied by the caller so it can be refreshed without a code change.
 */
export function isMarketOpen(now: Date | string, calendar?: MarketCalendar | undefined): boolean {
  const { dateKey, weekday, minuteOfDay } = istParts(now);
  if (weekday === 0 || weekday === 6) return false;
  if (calendar?.holidays.includes(dateKey) === true) return false;
  return minuteOfDay >= MARKET_OPEN_MINUTES_IST && minuteOfDay <= MARKET_CLOSE_MINUTES_IST;
}

// ---------------------------------------------------------------------------
// Result shapes (structurally identical to GuardrailResultSchema in schemas.ts,
// so a result can be written straight into `proposals.guardrailPrecheck`).
// ---------------------------------------------------------------------------

export const GUARDRAIL_NAMES = [
  'killSwitch',
  'tradingEnabled',
  'marketHours',
  'sessionValid',
  'proposalFresh',
  'maxOrderValue',
  'dailyNotional',
  'dailyOrderCount',
  'segmentAllowed',
  'productAllowed',
  'symbolAllowBlock',
  'priceCollar',
  'tickLotValidity',
  'fundsSufficient',
  'idempotencyUnused',
] as const;

export type GuardrailName = (typeof GUARDRAIL_NAMES)[number];

export interface GuardrailCheck {
  name: GuardrailName | string;
  ok: boolean;
  detail: string;
}

export interface GuardrailResult {
  passed: boolean;
  checks: GuardrailCheck[];
}

export interface TodayAggregates {
  /** Orders already submitted today (IST), from the audit log. */
  orderCount: number;
  /** Notional already committed today (IST), from the audit log. */
  notionalInr: number;
}

export interface ProposalRef {
  status: ProposalStatus;
  /** ISO-8601. */
  ttlExpiresAt: string;
}

export interface IdempotencyRef {
  key: string;
  /** `true` when this key already exists in the idempotency store. */
  used: boolean;
}

export interface GuardrailInput {
  config: Config;
  order: NormalizedOrder;
  /** Proposal freshness inputs. Absent ⇒ `proposalFresh` fails. */
  proposal?: ProposalRef | undefined;
  /** Live quote for the order's symbol. Absent ⇒ price-dependent checks fail. */
  quote?: Quote | undefined;
  /** Live funds. Absent ⇒ `fundsSufficient` fails. */
  funds?: Funds | undefined;
  /** Resolved instrument (lot/tick). Absent ⇒ `tickLotValidity` fails. */
  instrument?: InstrumentRef | undefined;
  /** Broker session status. Absent ⇒ `sessionValid` fails. */
  session?: SessionStatus | undefined;
  today: TodayAggregates;
  /**
   * Absent ⇒ `idempotencyUnused` fails. The strategy-engine pre-filter passes its
   * dedupe intent key here (docs/05 §5.4); the backend passes the app's key.
   */
  idempotency?: IdempotencyRef | undefined;
  now: Date | string;
  calendar?: MarketCalendar | undefined;
  /** Overrides {@link SESSION_EXPIRY_MARGIN_SECONDS}. */
  sessionExpiryMarginSeconds?: number | undefined;
  /** Broker-computed margin requirement; defaults to a conservative estimate. */
  requiredMarginInr?: number | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic, ICU-free money formatting for audit strings. */
export function formatInr(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return `₹${rounded}`;
}

/** Float-safe `value % step === 0`. */
export function isMultipleOf(value: number, step: number, epsilon = 1e-6): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return false;
  const ratio = value / step;
  return Math.abs(ratio - Math.round(ratio)) < epsilon;
}

/**
 * Conservative notional: quantity × the highest price the order could transact at
 * (limit, trigger or live LTP). `undefined` when no price is known at all.
 */
export function estimateOrderNotionalInr(
  order: NormalizedOrder,
  ltp?: number | undefined,
): number | undefined {
  const prices = [order.limitPrice, order.triggerPrice, ltp].filter(
    (p): p is number => typeof p === 'number' && Number.isFinite(p) && p > 0,
  );
  if (prices.length === 0) return undefined;
  return order.quantity * Math.max(...prices);
}

/**
 * Conservative margin estimate when the caller has no broker margin number:
 * a BUY needs the full notional; a SELL needs nothing for DELIVERY (you are
 * delivering stock the ledger says the book owns) and the full notional for any
 * leveraged/short product. Callers with a margin API should pass
 * `requiredMarginInr` explicitly.
 */
export function estimateRequiredMarginInr(order: NormalizedOrder, notionalInr: number): number {
  if (order.side === 'BUY') return notionalInr;
  return order.product === 'DELIVERY' ? 0 : notionalInr;
}

/** Effective cap for a config value: `min(config, ceiling)`. */
function cap(configured: number, ceiling: number): number {
  return Number.isFinite(configured) ? Math.min(configured, ceiling) : ceiling;
}

/**
 * Clamp a config's guardrails down to the code-level absolute ceilings. Callers
 * should run this before persisting or displaying a config; `runGuardrails`
 * applies it internally regardless.
 */
export function clampConfigToCeilings(config: Config): Config {
  return {
    ...config,
    guardrails: {
      ...config.guardrails,
      maxOrderValueInr: cap(config.guardrails.maxOrderValueInr, ABS_MAX_ORDER_VALUE_INR),
      maxDailyNotionalInr: cap(config.guardrails.maxDailyNotionalInr, ABS_MAX_DAILY_NOTIONAL_INR),
      maxOrdersPerDay: cap(config.guardrails.maxOrdersPerDay, ABS_MAX_ORDERS_PER_DAY),
    },
  };
}

const check = (name: GuardrailName, ok: boolean, detail: string): GuardrailCheck => ({
  name,
  ok,
  detail,
});

function listMatches(list: readonly string[], key: string, tradingSymbol: string): boolean {
  return list.some((entry) => entry === key || entry === tradingSymbol);
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

/**
 * Run every guardrail. All checks always run (no short-circuit) so the app can
 * show the human every reason an order was refused.
 */
export function runGuardrails(input: GuardrailInput): GuardrailResult {
  const config = clampConfigToCeilings(input.config);
  const g = config.guardrails;
  const { order } = input;
  const now = resolveNow(input.now);
  const key = symbolKey(order.symbol);
  const ltp = input.quote?.ltp;
  const notional = estimateOrderNotionalInr(order, ltp);

  const checks: GuardrailCheck[] = [];

  // 1. Kill switch ----------------------------------------------------------
  checks.push(
    check(
      'killSwitch',
      config.killSwitch === false,
      config.killSwitch ? 'kill switch is ON — all orders refused' : 'kill switch off',
    ),
  );

  // 2. Trading enabled ------------------------------------------------------
  checks.push(
    check(
      'tradingEnabled',
      config.tradingEnabled === true,
      config.tradingEnabled ? 'trading enabled' : 'tradingEnabled is false',
    ),
  );

  // 3. Market hours ---------------------------------------------------------
  {
    const parts = istParts(now);
    const open = isMarketOpen(now, input.calendar);
    const why = open
      ? `market open (${parts.clock})`
      : parts.weekday === 0 || parts.weekday === 6
        ? `weekend (${parts.dateKey})`
        : input.calendar?.holidays.includes(parts.dateKey) === true
          ? `exchange holiday (${parts.dateKey})`
          : `outside 09:15–15:30 IST (${parts.clock})`;
    checks.push(check('marketHours', open, why));
  }

  // 4. Session valid --------------------------------------------------------
  {
    const s: SessionStatus | undefined = input.session;
    const marginMs = (input.sessionExpiryMarginSeconds ?? SESSION_EXPIRY_MARGIN_SECONDS) * 1000;
    let ok = false;
    let detail: string;
    if (s === undefined) {
      detail = 'no broker session supplied';
    } else if (s.broker !== config.activeBroker) {
      detail = `session is for '${s.broker}' but activeBroker is '${config.activeBroker}'`;
    } else if (!s.connected) {
      detail = `broker '${s.broker}' not connected — re-login required`;
    } else if (s.staticIpOk === false) {
      detail = 'last order call was IP-rejected (staticIpOk=false)';
    } else if (s.expiresAt === undefined) {
      detail = 'session token expiry unknown';
    } else {
      const expiresAt = new Date(s.expiresAt).getTime();
      if (Number.isNaN(expiresAt)) {
        detail = `unparseable session expiry: ${s.expiresAt}`;
      } else if (expiresAt - now.getTime() <= marginMs) {
        detail = `session expires at ${s.expiresAt}, within the ${marginMs / 1000}s safety margin`;
      } else {
        ok = true;
        detail = `session valid until ${s.expiresAt}`;
      }
    }
    checks.push(check('sessionValid', ok, detail));
  }

  // 5. Proposal fresh -------------------------------------------------------
  {
    const p = input.proposal;
    let ok = false;
    let detail: string;
    if (p === undefined) {
      detail = 'no proposal supplied';
    } else if (!EXECUTABLE_STATUSES.includes(p.status)) {
      detail = `proposal status '${p.status}' is not executable (expected pending|approved)`;
    } else {
      const ttl = new Date(p.ttlExpiresAt).getTime();
      if (Number.isNaN(ttl)) {
        detail = `unparseable ttlExpiresAt: ${p.ttlExpiresAt}`;
      } else if (now.getTime() >= ttl) {
        detail = `proposal expired at ${p.ttlExpiresAt}`;
      } else {
        ok = true;
        detail = `proposal '${p.status}', valid until ${p.ttlExpiresAt}`;
      }
    }
    checks.push(check('proposalFresh', ok, detail));
  }

  // 6. Max order value ------------------------------------------------------
  {
    const limit = g.maxOrderValueInr;
    if (notional === undefined) {
      checks.push(
        check('maxOrderValue', false, 'no price available (no limit/trigger price and no quote)'),
      );
    } else {
      const ok = notional <= limit;
      checks.push(
        check(
          'maxOrderValue',
          ok,
          ok
            ? `${formatInr(notional)} ≤ cap ${formatInr(limit)}`
            : `${formatInr(notional)} > cap ${formatInr(limit)}`,
        ),
      );
    }
  }

  // 7. Daily notional -------------------------------------------------------
  {
    const limit = g.maxDailyNotionalInr;
    const soFar = input.today.notionalInr;
    if (notional === undefined) {
      checks.push(check('dailyNotional', false, 'no price available to value this order'));
    } else if (!Number.isFinite(soFar) || soFar < 0) {
      checks.push(check('dailyNotional', false, `invalid today.notionalInr: ${soFar}`));
    } else {
      const total = soFar + notional;
      const ok = total <= limit;
      checks.push(
        check(
          'dailyNotional',
          ok,
          `${formatInr(soFar)} today + ${formatInr(notional)} = ${formatInr(total)} ` +
            `${ok ? '≤' : '>'} cap ${formatInr(limit)}`,
        ),
      );
    }
  }

  // 8. Daily order count ----------------------------------------------------
  {
    const limit = g.maxOrdersPerDay;
    const soFar = input.today.orderCount;
    if (!Number.isInteger(soFar) || soFar < 0) {
      checks.push(check('dailyOrderCount', false, `invalid today.orderCount: ${soFar}`));
    } else {
      const ok = soFar + 1 <= limit;
      checks.push(
        check(
          'dailyOrderCount',
          ok,
          `${soFar} placed today, this would be #${soFar + 1} ${ok ? '≤' : '>'} cap ${limit}`,
        ),
      );
    }
  }

  // 9. Segment allowed ------------------------------------------------------
  {
    const ok = g.allowedSegments.includes(order.symbol.segment);
    checks.push(
      check(
        'segmentAllowed',
        ok,
        `segment ${order.symbol.segment} ${ok ? 'in' : 'not in'} [${g.allowedSegments.join(', ')}]`,
      ),
    );
  }

  // 10. Product allowed -----------------------------------------------------
  {
    const ok = g.allowedProducts.includes(order.product);
    checks.push(
      check(
        'productAllowed',
        ok,
        `product ${order.product} ${ok ? 'in' : 'not in'} [${g.allowedProducts.join(', ')}]`,
      ),
    );
  }

  // 11. Symbol allow/block --------------------------------------------------
  {
    const ts = order.symbol.tradingSymbol;
    // Entries may be a full symbolKey or a bare trading symbol; the blocklist
    // wins over the allowlist.
    if (listMatches(g.symbolBlocklist, key, ts)) {
      checks.push(check('symbolAllowBlock', false, `${key} is blocklisted`));
    } else if (g.symbolAllowlist !== null && !listMatches(g.symbolAllowlist, key, ts)) {
      checks.push(check('symbolAllowBlock', false, `${key} is not in the symbol allowlist`));
    } else {
      checks.push(
        check(
          'symbolAllowBlock',
          true,
          g.symbolAllowlist === null
            ? `${key} not blocklisted (no allowlist configured)`
            : `${key} allowlisted and not blocklisted`,
        ),
      );
    }
  }

  // 12. Price collar --------------------------------------------------------
  {
    const q = input.quote;
    let ok = false;
    let detail: string;
    if (q === undefined || !Number.isFinite(q.ltp) || q.ltp <= 0) {
      // MARKET orders skip the collar but still REQUIRE a live quote — we never
      // fire a market order into an unknown price.
      detail = 'no usable live quote (ltp) for this symbol';
    } else if (symbolKey(q.symbol) !== key) {
      detail = `quote is for ${symbolKey(q.symbol)}, order is for ${key}`;
    } else if (order.orderType === 'MARKET' || order.orderType === 'SL-M') {
      ok = true;
      detail = `collar not applicable to ${order.orderType}; live LTP ${formatInr(q.ltp)} present`;
    } else if (order.limitPrice === undefined) {
      detail = `${order.orderType} order has no limitPrice to collar`;
    } else {
      const deviationPct = (Math.abs(order.limitPrice - q.ltp) / q.ltp) * 100;
      ok = deviationPct <= g.priceCollarPct;
      detail =
        `limit ${formatInr(order.limitPrice)} is ${deviationPct.toFixed(2)}% from LTP ` +
        `${formatInr(q.ltp)} (collar ±${g.priceCollarPct}%)`;
    }
    checks.push(check('priceCollar', ok, detail));
  }

  // 13. Tick / lot validity -------------------------------------------------
  {
    const inst = input.instrument;
    let ok = false;
    let detail: string;
    if (inst === undefined) {
      detail = 'instrument not resolved (lot/tick unknown)';
    } else if (symbolKey(inst.canonical) !== key) {
      detail = `instrument is for ${symbolKey(inst.canonical)}, order is for ${key}`;
    } else if (!(inst.lotSize > 0) || !(inst.tickSize > 0)) {
      detail = `invalid instrument lotSize=${inst.lotSize} tickSize=${inst.tickSize}`;
    } else if (order.quantity % inst.lotSize !== 0) {
      detail = `quantity ${order.quantity} is not a multiple of lot size ${inst.lotSize}`;
    } else if (order.limitPrice !== undefined && !isMultipleOf(order.limitPrice, inst.tickSize)) {
      detail = `limitPrice ${order.limitPrice} is not a multiple of tick size ${inst.tickSize}`;
    } else if (
      order.triggerPrice !== undefined &&
      !isMultipleOf(order.triggerPrice, inst.tickSize)
    ) {
      detail = `triggerPrice ${order.triggerPrice} is not a multiple of tick size ${inst.tickSize}`;
    } else {
      ok = true;
      detail = `qty ${order.quantity} × lot ${inst.lotSize}, prices on tick ${inst.tickSize}`;
    }
    checks.push(check('tickLotValidity', ok, detail));
  }

  // 14. Funds sufficient ----------------------------------------------------
  {
    const f = input.funds;
    let ok = false;
    let detail: string;
    if (f === undefined) {
      detail = 'no live funds snapshot supplied';
    } else if (notional === undefined) {
      detail = 'no price available to size the margin requirement';
    } else {
      const required = input.requiredMarginInr ?? estimateRequiredMarginInr(order, notional);
      ok = required <= f.availableMargin;
      detail = `requires ${formatInr(required)}, available margin ${formatInr(f.availableMargin)}`;
    }
    checks.push(check('fundsSufficient', ok, detail));
  }

  // 15. Idempotency ---------------------------------------------------------
  {
    const idem = input.idempotency;
    if (idem === undefined) {
      checks.push(check('idempotencyUnused', false, 'no idempotency key supplied'));
    } else {
      checks.push(
        check(
          'idempotencyUnused',
          !idem.used,
          idem.used
            ? `idempotency key '${idem.key}' already used — returning prior result`
            : `idempotency key '${idem.key}' unused`,
        ),
      );
    }
  }

  return { passed: checks.every((c) => c.ok), checks };
}

/** The failing checks of a result, in suite order — the docs/04 §4.3 error body. */
export function failedChecks(result: GuardrailResult): GuardrailCheck[] {
  return result.checks.filter((c) => !c.ok);
}
