/**
 * The strategy registry.
 *
 * Long-term, swing and day-trade only — **no scalp strategies**: docs/10 §10.7
 * records the decision "C → A", scalping deferred, and no mandate/auto-exec path
 * is planned. Adding one here would still only write proposals, but the decision
 * is to not build it yet.
 *
 * Each module also exports its own `describe()` rationale builder; those are
 * imported from the module directly rather than re-exported here, so the names
 * cannot collide.
 */

import type { Strategy } from '../types.js';
import { DCA_STRATEGY_ID, dcaStrategy } from './long_term/dca.js';
import {
  REBALANCE_DRIFT_STRATEGY_ID,
  rebalanceDriftStrategy,
} from './long_term/rebalance-drift.js';
import {
  STOP_TARGET_MONITOR_STRATEGY_ID,
  stopTargetMonitorStrategy,
} from './swing/stop-target-monitor.js';
import { BREAKOUT_ENTRY_STRATEGY_ID, breakoutEntryStrategy } from './swing/breakout-entry.js';
import {
  OPENING_RANGE_BREAKOUT_STRATEGY_ID,
  openingRangeBreakoutStrategy,
} from './day_trade/opening-range-breakout.js';
import { EOD_SQUARE_OFF_STRATEGY_ID, eodSquareOffStrategy } from './day_trade/eod-square-off.js';

export {
  DCA_STRATEGY_ID,
  dcaStrategy,
  REBALANCE_DRIFT_STRATEGY_ID,
  rebalanceDriftStrategy,
  STOP_TARGET_MONITOR_STRATEGY_ID,
  stopTargetMonitorStrategy,
  BREAKOUT_ENTRY_STRATEGY_ID,
  breakoutEntryStrategy,
  OPENING_RANGE_BREAKOUT_STRATEGY_ID,
  openingRangeBreakoutStrategy,
  EOD_SQUARE_OFF_STRATEGY_ID,
  eodSquareOffStrategy,
};

export const ALL_STRATEGIES: readonly Strategy[] = [
  dcaStrategy,
  rebalanceDriftStrategy,
  stopTargetMonitorStrategy,
  breakoutEntryStrategy,
  openingRangeBreakoutStrategy,
  eodSquareOffStrategy,
];

export const STRATEGY_REGISTRY: ReadonlyMap<string, Strategy> = new Map(
  ALL_STRATEGIES.map((s) => [s.id, s]),
);
