import {
  driftPct,
  duration,
  inr,
  inrSigned,
  inrWhole,
  istDateTime,
  istTime,
  orderLine,
  pct,
  qty,
  relativeAge,
  sideLabel,
  symbolLabel,
} from './format';
import { SYMBOL } from '../test-utils';

describe('money', () => {
  it('groups with Indian digit grouping', () => {
    expect(inr(123456.78)).toBe('₹1,23,456.78');
    expect(inrWhole(123456.78)).toBe('₹1,23,457');
  });

  it('puts the sign before the rupee symbol, never after', () => {
    expect(inr(-1234)).toBe('-₹1,234.00');
    expect(inrWhole(-1234)).toBe('-₹1,234');
  });

  it('signs P&L explicitly', () => {
    expect(inrSigned(1234)).toBe('+₹1,234.00');
    expect(inrSigned(-1234)).toBe('-₹1,234.00');
    expect(inrSigned(0)).toBe('+₹0.00');
  });

  it('renders a dash for a non-finite amount rather than NaN', () => {
    expect(inr(Number.NaN)).toBe('—');
    expect(inrWhole(Number.POSITIVE_INFINITY)).toBe('—');
    expect(inrSigned(Number.NaN)).toBe('—');
    expect(qty(Number.NaN)).toBe('—');
    expect(pct(Number.NaN)).toBe('—');
  });
});

describe('quantities and percentages', () => {
  it('formats them', () => {
    expect(qty(1000)).toBe('1,000');
    expect(pct(1.2345)).toBe('1.23%');
    expect(pct(1.2345, 0)).toBe('1%');
  });
});

describe('IST times', () => {
  it('renders in Asia/Kolkata, not the device zone', () => {
    // 00:30 UTC is 06:00 IST — the daily broker token expiry in docs/06 §6.3.
    expect(istTime('2026-02-03T00:30:00.000Z')).toBe('06:00 am');
    expect(istDateTime('2026-02-03T03:50:00.000Z')).toBe('03 feb, 09:20 am');
  });

  it('accepts a Date as well as an ISO string', () => {
    expect(istTime(new Date('2026-02-03T00:30:00.000Z'))).toBe('06:00 am');
  });

  it('renders a dash for an unparseable instant', () => {
    expect(istTime('not-a-date')).toBe('—');
    expect(istDateTime('not-a-date')).toBe('—');
  });
});

describe('durations', () => {
  it('renders minutes and seconds', () => {
    expect(duration(134)).toBe('2m 14s');
    expect(duration(41)).toBe('41s');
  });

  it('clamps at zero', () => {
    expect(duration(0)).toBe('0s');
    expect(duration(-5)).toBe('0s');
    expect(duration(Number.NaN)).toBe('0s');
  });

  it('renders relative ages by magnitude', () => {
    expect(relativeAge(12)).toBe('12s ago');
    expect(relativeAge(240)).toBe('4m ago');
    expect(relativeAge(7200)).toBe('2h ago');
    expect(relativeAge(-1)).toBe('—');
  });
});

describe('order descriptors', () => {
  it('names the symbol by exchange and trading symbol', () => {
    expect(symbolLabel(SYMBOL)).toBe('NSE:INFY');
  });

  it('passes the side through untouched', () => {
    expect(sideLabel('SELL')).toBe('SELL');
  });

  it('describes a LIMIT order with its price', () => {
    expect(
      orderLine({
        symbol: { ...SYMBOL },
        side: 'BUY',
        quantity: 10,
        orderType: 'LIMIT',
        product: 'DELIVERY',
        validity: 'DAY',
        limitPrice: 1500,
      }),
    ).toBe('LIMIT · @ ₹1,500.00 · DELIVERY · DAY');
  });

  it('describes an SL order with both prices', () => {
    expect(
      orderLine({
        symbol: { ...SYMBOL },
        side: 'SELL',
        quantity: 5,
        orderType: 'SL',
        product: 'INTRADAY',
        validity: 'IOC',
        limitPrice: 1400,
        triggerPrice: 1410,
      }),
    ).toBe('SL · @ ₹1,400.00 · trigger ₹1,410.00 · INTRADAY · IOC');
  });
});

describe('driftPct', () => {
  it('is signed relative to the earlier price', () => {
    expect(driftPct(100, 105)).toBeCloseTo(5);
    expect(driftPct(100, 95)).toBeCloseTo(-5);
  });

  it('refuses to divide by a non-price', () => {
    expect(driftPct(0, 100)).toBeUndefined();
    expect(driftPct(Number.NaN, 100)).toBeUndefined();
    expect(driftPct(100, Number.NaN)).toBeUndefined();
  });
});
