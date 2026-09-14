/**
 * Presentation-only formatting. Deliberately NOT in `@pm/core`: core's
 * `formatInr` is a terse audit-string helper with no digit grouping, and money
 * on a screen needs Indian grouping (`₹1,23,456.78`).
 *
 * Every function takes its inputs explicitly — no `Date.now()` in here, so the
 * tests pin an instant (docs/00 §0.5 "no wall-clock time").
 */
import type { CanonicalSymbol, NormalizedOrder, Side } from '@pm/core';

const INR = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});
const INR_WHOLE = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const QTY = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** `₹1,23,456.78`. Negative values render as `-₹1,234.00`, never `₹-1,234.00`. */
export function inr(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  const sign = amount < 0 ? '-' : '';
  return `${sign}₹${INR.format(Math.abs(amount))}`;
}

/** `₹1,23,457` — for headline numbers where paise are noise. */
export function inrWhole(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  const sign = amount < 0 ? '-' : '';
  return `${sign}₹${INR_WHOLE.format(Math.abs(amount))}`;
}

/** Signed, for P&L: `+₹1,234.00` / `-₹1,234.00`. */
export function inrSigned(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  return amount >= 0 ? `+${inr(amount)}` : inr(amount);
}

export function qty(n: number): string {
  return Number.isFinite(n) ? QTY.format(n) : '—';
}

export function pct(value: number, digits = 2): string {
  return Number.isFinite(value) ? `${value.toFixed(digits)}%` : '—';
}

/** `NSE:EQ:INFY` — the same key `@pm/core`'s `symbolKey` builds. */
export function symbolLabel(symbol: CanonicalSymbol): string {
  return `${symbol.exchange}:${symbol.tradingSymbol}`;
}

const IST_TIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});
const IST_DATETIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

/** `06:00 am` in IST — the market's timezone, never the device's. */
export function istTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return Number.isNaN(d.getTime()) ? '—' : IST_TIME.format(d).toLowerCase();
}

/** `31 Jan, 09:20 am` IST. */
export function istDateTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return Number.isNaN(d.getTime()) ? '—' : IST_DATETIME.format(d).toLowerCase();
}

/** `2m 14s` / `41s` / `0s`. Never negative. */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

/** `12s ago` / `4m ago` / `2h ago` — for the LTP age (docs/06 §6.6). */
export function relativeAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function sideLabel(side: Side): string {
  return side;
}

/** `LIMIT @ ₹1,450.00 · DELIVERY · DAY` — the one-line order descriptor. */
export function orderLine(order: NormalizedOrder): string {
  const parts: string[] = [order.orderType];
  if (order.limitPrice !== undefined) parts.push(`@ ${inr(order.limitPrice)}`);
  if (order.triggerPrice !== undefined) parts.push(`trigger ${inr(order.triggerPrice)}`);
  parts.push(order.product, order.validity);
  return parts.join(' · ');
}

/** Signed % drift of `now` from `then`; `undefined` when either is unusable. */
export function driftPct(then: number, now: number): number | undefined {
  if (!Number.isFinite(then) || !Number.isFinite(now) || then <= 0) return undefined;
  return ((now - then) / then) * 100;
}
