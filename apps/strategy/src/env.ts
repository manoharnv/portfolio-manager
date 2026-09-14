/**
 * Process environment → typed engine settings. Pure: the env is a parameter,
 * so this is testable without touching `process.env` (docs/00 §0.5).
 */

import type { Segment } from '@pm/core';

export interface EngineEnv {
  uid: string;
  /** Secret Manager resource name holding the broker's READ credentials. */
  brokerSecret: string;
  /** Instrument-master CSV URL for the active broker (file:// on the VM). */
  instrumentsUrl: string;
  holidays: string[];
  /** Neutral segments the instrument master indexes (memory: docs/11 §11.6). */
  segments: Segment[];
  prettyLogs: boolean;
  intradayIntervalMinutes: number;
}

const SEGMENTS: readonly Segment[] = ['EQ', 'FNO', 'CURRENCY', 'COMMODITY'];

/** `PM_INSTRUMENT_SEGMENTS` — comma-separated; blank ⇒ `EQ`; anything unknown is an error. */
export function parseSegments(value: string | undefined): Segment[] {
  const wanted = (value ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  if (wanted.length === 0) return ['EQ'];
  return wanted.map((s) => {
    const found = SEGMENTS.find((known) => known === s);
    if (found === undefined) {
      throw new Error(
        `PM_INSTRUMENT_SEGMENTS: unknown segment '${s}' (expected any of ${SEGMENTS.join(', ')})`,
      );
    }
    return found;
  });
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): EngineEnv {
  const interval = Number(env['PM_INTRADAY_INTERVAL_MINUTES'] ?? '5');
  return {
    uid: required(env, 'PM_UID'),
    brokerSecret: required(env, 'PM_BROKER_SECRET'),
    instrumentsUrl: required(env, 'PM_INSTRUMENTS_URL'),
    holidays: (env['PM_HOLIDAYS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    segments: parseSegments(env['PM_INSTRUMENT_SEGMENTS']),
    prettyLogs: env['PM_PRETTY_LOGS'] === 'true',
    intradayIntervalMinutes: Number.isFinite(interval) && interval > 0 ? interval : 5,
  };
}
