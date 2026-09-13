/**
 * Tick planning — docs/05-strategy-engine.md §5.5.
 *
 * | Tick     | When (IST)                      |
 * |----------|---------------------------------|
 * | pre-open | 09:00                           |
 * | intraday | every N min, 09:15–15:30        |
 * | eod      | 15:45                           |
 *
 * Pure: `now` is always a parameter and the holiday list is injected, never
 * hard-coded (same rule core's `isMarketOpen` follows). `index.ts` is the only
 * place that turns these into real cron timers.
 */

import { istDateKey, istMinuteOfDay } from '@pm/core';
import type { Strategy, StrategyDef, Tick } from './types.js';
import { STRATEGY_REGISTRY } from './strategies/index.js';
import { istWeekday } from './strategies/util.js';

export interface ScheduleConfig {
  preOpenMinuteIst: number;
  intradayStartMinuteIst: number;
  intradayEndMinuteIst: number;
  intradayIntervalMinutes: number;
  eodMinuteIst: number;
  /** IST `YYYY-MM-DD` exchange holidays. */
  holidays: readonly string[];
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  preOpenMinuteIst: 9 * 60, // 09:00
  intradayStartMinuteIst: 9 * 60 + 15, // 09:15
  intradayEndMinuteIst: 15 * 60 + 30, // 15:30
  intradayIntervalMinutes: 5,
  eodMinuteIst: 15 * 60 + 45, // 15:45
  holidays: [],
};

export function resolveSchedule(cfg?: Partial<ScheduleConfig> | undefined): ScheduleConfig {
  return { ...DEFAULT_SCHEDULE, ...cfg };
}

/** Weekday in IST and not on the injected holiday list. */
export function isTradingDay(now: Date | string, holidays: readonly string[] = []): boolean {
  const weekday = istWeekday(now);
  if (weekday === 0 || weekday === 6) return false;
  return !holidays.includes(istDateKey(now));
}

/**
 * The ticks due at exactly this instant (minute granularity). Empty on
 * weekends, holidays, and every minute that is not a scheduled slot.
 */
export function planTicks(now: Date | string, cfg?: Partial<ScheduleConfig> | undefined): Tick[] {
  const s = resolveSchedule(cfg);
  if (!isTradingDay(now, s.holidays)) return [];

  const minute = istMinuteOfDay(now);
  const ticks: Tick[] = [];

  if (minute === s.preOpenMinuteIst) ticks.push('pre-open');

  const interval = s.intradayIntervalMinutes;
  if (
    interval > 0 &&
    minute >= s.intradayStartMinuteIst &&
    minute <= s.intradayEndMinuteIst &&
    (minute - s.intradayStartMinuteIst) % interval === 0
  ) {
    ticks.push('intraday');
  }

  if (minute === s.eodMinuteIst) ticks.push('eod');

  return ticks;
}

/** Is this specific tick due now? The gate `index.ts` applies before running. */
export function isTickDue(
  now: Date | string,
  tick: Tick,
  cfg?: Partial<ScheduleConfig> | undefined,
): boolean {
  return planTicks(now, cfg).includes(tick);
}

/**
 * Cron expressions (IST) for the three timers. The intraday expression is
 * deliberately *coarser* than the real schedule — `isTickDue` narrows it at fire
 * time, so a config change never needs a different cron string.
 */
export function cronExpressions(cfg?: Partial<ScheduleConfig> | undefined): Record<Tick, string> {
  const s = resolveSchedule(cfg);
  const hh = (m: number): number => Math.floor(m / 60);
  const mm = (m: number): number => m % 60;
  return {
    'pre-open': `${mm(s.preOpenMinuteIst)} ${hh(s.preOpenMinuteIst)} * * 1-5`,
    intraday:
      `*/${s.intradayIntervalMinutes} ` +
      `${hh(s.intradayStartMinuteIst)}-${hh(s.intradayEndMinuteIst)} * * 1-5`,
    eod: `${mm(s.eodMinuteIst)} ${hh(s.eodMinuteIst)} * * 1-5`,
  };
}

// ---------------------------------------------------------------------------
// Strategy selection
// ---------------------------------------------------------------------------

export interface SelectedStrategy {
  def: StrategyDef;
  strategy: Strategy;
}

export interface StrategySelection {
  selected: SelectedStrategy[];
  /** Defs naming a strategy this build does not contain — fail closed, audited. */
  unresolved: StrategyDef[];
  /** Disabled, or not scheduled for this tick. */
  skipped: { def: StrategyDef; reason: string }[];
}

/**
 * Which defs run on this tick. A def may override the implementation's default
 * tick membership with its own `ticks` array.
 */
export function strategiesForTick(
  defs: readonly StrategyDef[],
  tick: Tick,
  registry: ReadonlyMap<string, Strategy> = STRATEGY_REGISTRY,
): StrategySelection {
  const selected: SelectedStrategy[] = [];
  const unresolved: StrategyDef[] = [];
  const skipped: { def: StrategyDef; reason: string }[] = [];

  for (const def of defs) {
    if (!def.enabled) {
      skipped.push({ def, reason: 'disabled' });
      continue;
    }
    const strategy = registry.get(def.id);
    if (strategy === undefined) {
      unresolved.push(def);
      continue;
    }
    const ticks: readonly Tick[] = def.ticks ?? strategy.schedule;
    if (!ticks.includes(tick)) {
      skipped.push({ def, reason: `not scheduled for '${tick}' (runs on ${ticks.join(', ')})` });
      continue;
    }
    selected.push({ def, strategy });
  }

  return { selected, unresolved, skipped };
}
