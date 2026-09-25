/**
 * Client-side editing rules for `config.guardrails` (docs/06 §6.3 (6)).
 *
 * docs/00 §0.7.3 — "code ceilings beat config" — is enforced in three places:
 * `runGuardrails` re-clamps internally, `clampConfigToCeilings` clamps what the
 * backend persists, and this module clamps what the app will even *send*. The
 * app's clamp is the weakest of the three by design; it exists so the human
 * sees the real limit while typing, not so the system depends on it.
 */
import {
  ABS_MAX_DAILY_NOTIONAL_INR,
  ABS_MAX_ORDERS_PER_DAY,
  ABS_MAX_ORDER_VALUE_INR,
  type GuardrailConfig,
  type Product,
  type Segment,
} from '@pm/core';

export const CEILINGS = {
  maxOrderValueInr: ABS_MAX_ORDER_VALUE_INR,
  maxDailyNotionalInr: ABS_MAX_DAILY_NOTIONAL_INR,
  maxOrdersPerDay: ABS_MAX_ORDERS_PER_DAY,
} as const;

/** A collar wider than this is not a collar. Not a code ceiling — a sanity one. */
export const MAX_PRICE_COLLAR_PCT = 25;
/** One trading day; a TTL longer than that is a bug, not a preference. */
export const MAX_PROPOSAL_TTL_SECONDS = 6 * 60 * 60;
export const MIN_PROPOSAL_TTL_SECONDS = 30;

export const ALL_SEGMENTS: readonly Segment[] = ['EQ', 'FNO', 'CURRENCY', 'COMMODITY'];
export const ALL_PRODUCTS: readonly Product[] = ['DELIVERY', 'INTRADAY', 'MARGIN', 'MTF'];

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Parses a free-text number field; a blank or junk entry falls back. */
export function parseNumberField(text: string, fallback: number): number {
  const cleaned = text.replace(/[,\s₹]/g, '');
  if (cleaned === '') return fallback;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : fallback;
}

/** `"INFY, TCS"` → `['INFY','TCS']`; empty text → `[]`. */
export function parseSymbolList(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s !== '');
}

export function formatSymbolList(list: readonly string[] | null): string {
  return list === null ? '' : list.join(', ');
}

/** Every ceiling applied. The single function the UI and the tests share. */
export function clampGuardrailDraft(draft: GuardrailConfig): GuardrailConfig {
  return {
    ...draft,
    maxOrderValueInr: clampNumber(draft.maxOrderValueInr, 0, CEILINGS.maxOrderValueInr),
    maxDailyNotionalInr: clampNumber(draft.maxDailyNotionalInr, 0, CEILINGS.maxDailyNotionalInr),
    maxOrdersPerDay: Math.floor(clampNumber(draft.maxOrdersPerDay, 0, CEILINGS.maxOrdersPerDay)),
    priceCollarPct: clampNumber(draft.priceCollarPct, 0, MAX_PRICE_COLLAR_PCT),
    proposalTtlSeconds: Math.floor(
      clampNumber(draft.proposalTtlSeconds, MIN_PROPOSAL_TTL_SECONDS, MAX_PROPOSAL_TTL_SECONDS),
    ),
    allowedSegments: ALL_SEGMENTS.filter((s) => draft.allowedSegments.includes(s)),
    allowedProducts: ALL_PRODUCTS.filter((p) => draft.allowedProducts.includes(p)),
    symbolAllowlist:
      draft.symbolAllowlist === null || draft.symbolAllowlist.length === 0
        ? null
        : draft.symbolAllowlist,
    symbolBlocklist: draft.symbolBlocklist,
  };
}

export interface CeilingWarning {
  field: keyof GuardrailConfig;
  requested: number;
  ceiling: number;
}

/** What the human typed that the ceilings pulled back, for an inline warning. */
export function ceilingWarnings(draft: GuardrailConfig): CeilingWarning[] {
  const warnings: CeilingWarning[] = [];
  const pairs: [keyof GuardrailConfig, number, number][] = [
    ['maxOrderValueInr', draft.maxOrderValueInr, CEILINGS.maxOrderValueInr],
    ['maxDailyNotionalInr', draft.maxDailyNotionalInr, CEILINGS.maxDailyNotionalInr],
    ['maxOrdersPerDay', draft.maxOrdersPerDay, CEILINGS.maxOrdersPerDay],
    ['priceCollarPct', draft.priceCollarPct, MAX_PRICE_COLLAR_PCT],
    ['proposalTtlSeconds', draft.proposalTtlSeconds, MAX_PROPOSAL_TTL_SECONDS],
  ];
  for (const [field, requested, ceiling] of pairs) {
    if (Number.isFinite(requested) && requested > ceiling) {
      warnings.push({ field, requested, ceiling });
    }
  }
  return warnings;
}

/** Toggle membership in an allow-list, preserving canonical order. */
export function toggleMember<T>(list: readonly T[], all: readonly T[], member: T): T[] {
  const next = list.includes(member) ? list.filter((item) => item !== member) : [...list, member];
  return all.filter((item) => next.includes(item));
}
