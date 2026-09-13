/**
 * docs/00 §0.7.3 — "code ceilings beat config". The app's clamp is the weakest
 * of the three, but it must still never produce a draft above `ABS_MAX_*`.
 */
import {
  ABS_MAX_DAILY_NOTIONAL_INR,
  ABS_MAX_ORDERS_PER_DAY,
  ABS_MAX_ORDER_VALUE_INR,
} from '@pm/core';
import {
  ALL_PRODUCTS,
  ALL_SEGMENTS,
  MAX_PRICE_COLLAR_PCT,
  MAX_PROPOSAL_TTL_SECONDS,
  MIN_PROPOSAL_TTL_SECONDS,
  ceilingWarnings,
  clampGuardrailDraft,
  formatSymbolList,
  parseNumberField,
  parseSymbolList,
  toggleMember,
} from './guardrailEdit';
import { buildConfig } from '../test-utils';

const base = buildConfig().guardrails;

describe('clampGuardrailDraft', () => {
  it('cannot raise a cap above the code ceiling', () => {
    const clamped = clampGuardrailDraft({
      ...base,
      maxOrderValueInr: 10_000_000,
      maxDailyNotionalInr: 99_000_000,
      maxOrdersPerDay: 5_000,
    });

    expect(clamped.maxOrderValueInr).toBe(ABS_MAX_ORDER_VALUE_INR);
    expect(clamped.maxDailyNotionalInr).toBe(ABS_MAX_DAILY_NOTIONAL_INR);
    expect(clamped.maxOrdersPerDay).toBe(ABS_MAX_ORDERS_PER_DAY);
  });

  it('leaves a value already under the ceiling alone', () => {
    expect(clampGuardrailDraft(base)).toEqual(base);
  });

  it('refuses negative caps', () => {
    const clamped = clampGuardrailDraft({
      ...base,
      maxOrderValueInr: -1,
      maxOrdersPerDay: -5,
      priceCollarPct: -2,
    });
    expect(clamped.maxOrderValueInr).toBe(0);
    expect(clamped.maxOrdersPerDay).toBe(0);
    expect(clamped.priceCollarPct).toBe(0);
  });

  it('refuses a non-finite entry', () => {
    expect(clampGuardrailDraft({ ...base, maxOrderValueInr: Number.NaN }).maxOrderValueInr).toBe(0);
  });

  it('bounds the collar and the TTL', () => {
    expect(clampGuardrailDraft({ ...base, priceCollarPct: 99 }).priceCollarPct).toBe(
      MAX_PRICE_COLLAR_PCT,
    );
    expect(clampGuardrailDraft({ ...base, proposalTtlSeconds: 1 }).proposalTtlSeconds).toBe(
      MIN_PROPOSAL_TTL_SECONDS,
    );
    expect(clampGuardrailDraft({ ...base, proposalTtlSeconds: 10 ** 9 }).proposalTtlSeconds).toBe(
      MAX_PROPOSAL_TTL_SECONDS,
    );
  });

  it('keeps orders-per-day an integer', () => {
    expect(clampGuardrailDraft({ ...base, maxOrdersPerDay: 7.9 }).maxOrdersPerDay).toBe(7);
  });

  it('canonicalises segment and product order and drops unknown entries', () => {
    const clamped = clampGuardrailDraft({
      ...base,
      allowedSegments: ['COMMODITY', 'EQ', 'NOPE' as never],
      allowedProducts: ['MTF', 'DELIVERY'],
    });
    expect(clamped.allowedSegments).toEqual(['EQ', 'COMMODITY']);
    expect(clamped.allowedProducts).toEqual(['DELIVERY', 'MTF']);
  });

  it('normalises an empty allowlist to null ("no allowlist filter")', () => {
    expect(clampGuardrailDraft({ ...base, symbolAllowlist: [] }).symbolAllowlist).toBeNull();
    expect(clampGuardrailDraft({ ...base, symbolAllowlist: null }).symbolAllowlist).toBeNull();
    expect(clampGuardrailDraft({ ...base, symbolAllowlist: ['INFY'] }).symbolAllowlist).toEqual([
      'INFY',
    ]);
  });
});

describe('ceilingWarnings', () => {
  it('names every field the ceilings will pull back', () => {
    const warnings = ceilingWarnings({
      ...base,
      maxOrderValueInr: 10_000_000,
      maxOrdersPerDay: 999,
      priceCollarPct: 80,
    });
    expect(warnings.map((w) => w.field)).toEqual([
      'maxOrderValueInr',
      'maxOrdersPerDay',
      'priceCollarPct',
    ]);
    expect(warnings[0]).toEqual({
      field: 'maxOrderValueInr',
      requested: 10_000_000,
      ceiling: ABS_MAX_ORDER_VALUE_INR,
    });
  });

  it('is empty for a compliant draft', () => {
    expect(ceilingWarnings(base)).toEqual([]);
  });
});

describe('field parsing', () => {
  it('strips grouping and currency noise', () => {
    expect(parseNumberField('₹1,00,000', 0)).toBe(100000);
    expect(parseNumberField(' 42 ', 0)).toBe(42);
  });

  it('falls back on blank or junk input', () => {
    expect(parseNumberField('', 7)).toBe(7);
    expect(parseNumberField('abc', 7)).toBe(7);
  });

  it('parses and formats symbol lists', () => {
    expect(parseSymbolList('infy, tcs ,, ')).toEqual(['INFY', 'TCS']);
    expect(parseSymbolList('')).toEqual([]);
    expect(formatSymbolList(['INFY', 'TCS'])).toBe('INFY, TCS');
    expect(formatSymbolList(null)).toBe('');
  });
});

describe('toggleMember', () => {
  it('adds and removes while preserving canonical order', () => {
    expect(toggleMember(['EQ'], ALL_SEGMENTS, 'COMMODITY')).toEqual(['EQ', 'COMMODITY']);
    expect(toggleMember(['EQ', 'FNO'], ALL_SEGMENTS, 'EQ')).toEqual(['FNO']);
    expect(toggleMember([], ALL_PRODUCTS, 'MTF')).toEqual(['MTF']);
  });
});
