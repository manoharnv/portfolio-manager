import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULE,
  cronExpressions,
  isTickDue,
  isTradingDay,
  planTicks,
  resolveSchedule,
  strategiesForTick,
} from './schedule.js';
import { defineStrategy, type Strategy, type Tick } from './types.js';
import { z } from 'zod';
import { makeDef } from './test-utils/index.js';
import { STRATEGY_REGISTRY } from './strategies/index.js';

/** 13 Jan 2026 is a Tuesday. UTC = IST − 5:30. */
const ist = (hh: number, mm: number, day = 13): string => {
  const utcMinutes = hh * 60 + mm - 330;
  const h = Math.floor(utcMinutes / 60);
  const m = utcMinutes % 60;
  return `2026-01-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
};

function stub(id: string, schedule: readonly Tick[], horizon: 'long_term' | 'swing'): Strategy {
  return defineStrategy({
    id,
    horizon,
    schedule,
    paramsSchema: z.record(z.string(), z.unknown()),
    run: () => Promise.resolve({ proposals: [] }),
  });
}

describe('resolveSchedule', () => {
  it('fills in the documented defaults (docs/05 §5.5)', () => {
    const s = resolveSchedule();
    expect(s.preOpenMinuteIst).toBe(9 * 60);
    expect(s.intradayStartMinuteIst).toBe(9 * 60 + 15);
    expect(s.intradayEndMinuteIst).toBe(15 * 60 + 30);
    expect(s.eodMinuteIst).toBe(15 * 60 + 45);
    expect(s).toEqual(DEFAULT_SCHEDULE);
  });

  it('accepts partial overrides', () => {
    expect(resolveSchedule({ intradayIntervalMinutes: 15 }).intradayIntervalMinutes).toBe(15);
  });
});

describe('isTradingDay', () => {
  it('is false on Saturday and Sunday in IST', () => {
    expect(isTradingDay(ist(10, 0, 17))).toBe(false); // Saturday
    expect(isTradingDay(ist(10, 0, 18))).toBe(false); // Sunday
  });

  it('is false on an injected holiday', () => {
    expect(isTradingDay(ist(10, 0), ['2026-01-13'])).toBe(false);
    expect(isTradingDay(ist(10, 0), ['2026-01-14'])).toBe(true);
  });

  it('uses the IST calendar day, not UTC', () => {
    // 2026-01-17T19:00Z is Sunday 00:30 IST → not a trading day.
    expect(isTradingDay('2026-01-17T19:00:00.000Z')).toBe(false);
    // 2026-01-12T19:00Z is Tuesday 00:30 IST → a weekday.
    expect(isTradingDay('2026-01-12T19:00:00.000Z')).toBe(true);
  });
});

describe('planTicks', () => {
  it('fires pre-open at exactly 09:00 IST', () => {
    expect(planTicks(ist(9, 0))).toEqual(['pre-open']);
    expect(planTicks(ist(8, 59))).toEqual([]);
    expect(planTicks(ist(9, 1))).toEqual([]);
  });

  it('fires intraday on the interval grid between 09:15 and 15:30 inclusive', () => {
    expect(planTicks(ist(9, 15))).toEqual(['intraday']);
    expect(planTicks(ist(9, 20))).toEqual(['intraday']);
    expect(planTicks(ist(15, 30))).toEqual(['intraday']);
    expect(planTicks(ist(9, 16))).toEqual([]);
    expect(planTicks(ist(9, 14))).toEqual([]);
    expect(planTicks(ist(15, 35))).toEqual([]);
  });

  it('respects a custom interval', () => {
    const cfg = { intradayIntervalMinutes: 15 };
    expect(planTicks(ist(9, 30), cfg)).toEqual(['intraday']);
    expect(planTicks(ist(9, 20), cfg)).toEqual([]);
  });

  it('fires eod at 15:45 IST', () => {
    expect(planTicks(ist(15, 45))).toEqual(['eod']);
  });

  it('is empty on weekends and holidays at every slot', () => {
    expect(planTicks(ist(9, 0, 17))).toEqual([]);
    expect(planTicks(ist(9, 20, 17))).toEqual([]);
    expect(planTicks(ist(9, 20), { holidays: ['2026-01-13'] })).toEqual([]);
  });

  it('never fires intraday when the interval is zero', () => {
    expect(planTicks(ist(9, 15), { intradayIntervalMinutes: 0 })).toEqual([]);
  });
});

describe('isTickDue', () => {
  it('narrows a coarse cron fire to the real slot', () => {
    expect(isTickDue(ist(9, 20), 'intraday')).toBe(true);
    expect(isTickDue(ist(9, 21), 'intraday')).toBe(false);
    expect(isTickDue(ist(9, 20), 'eod')).toBe(false);
  });
});

describe('cronExpressions', () => {
  it('emits one weekday pattern per tick', () => {
    const patterns = cronExpressions();
    expect(patterns['pre-open']).toBe('0 9 * * 1-5');
    expect(patterns.eod).toBe('45 15 * * 1-5');
    expect(patterns.intraday).toBe('*/5 9-15 * * 1-5');
  });

  it('reflects a custom interval', () => {
    expect(cronExpressions({ intradayIntervalMinutes: 15 }).intraday).toBe('*/15 9-15 * * 1-5');
  });
});

describe('strategiesForTick', () => {
  const registry = new Map<string, Strategy>([
    ['a', stub('a', ['intraday'], 'long_term')],
    ['b', stub('b', ['eod'], 'swing')],
  ]);

  it('selects only strategies scheduled for that tick', () => {
    const defs = [makeDef({ id: 'a' }), makeDef({ id: 'b', horizon: 'swing', bookId: 'swing' })];
    const intraday = strategiesForTick(defs, 'intraday', registry);
    expect(intraday.selected.map((s) => s.def.id)).toEqual(['a']);
    expect(intraday.skipped.map((s) => s.def.id)).toEqual(['b']);

    const eod = strategiesForTick(defs, 'eod', registry);
    expect(eod.selected.map((s) => s.def.id)).toEqual(['b']);
  });

  it('skips disabled defs', () => {
    const defs = [makeDef({ id: 'a', enabled: false })];
    const out = strategiesForTick(defs, 'intraday', registry);
    expect(out.selected).toEqual([]);
    expect(out.skipped[0]?.reason).toBe('disabled');
  });

  it('reports a def naming a strategy this build does not have', () => {
    const out = strategiesForTick([makeDef({ id: 'ghost' })], 'intraday', registry);
    expect(out.unresolved.map((d) => d.id)).toEqual(['ghost']);
    expect(out.selected).toEqual([]);
  });

  it("honours a def's tick override", () => {
    const defs = [makeDef({ id: 'a', ticks: ['eod'] })];
    expect(strategiesForTick(defs, 'eod', registry).selected).toHaveLength(1);
    expect(strategiesForTick(defs, 'intraday', registry).selected).toHaveLength(0);
  });

  it('defaults to the shipped registry', () => {
    const out = strategiesForTick([makeDef({ id: 'dca' })], 'intraday');
    expect(out.selected[0]?.strategy).toBe(STRATEGY_REGISTRY.get('dca'));
  });
});
