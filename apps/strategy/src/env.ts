/**
 * Process environment → typed engine settings. Pure: the env is a parameter,
 * so this is testable without touching `process.env` (docs/00 §0.5).
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { INSTRUMENT_MASTER_FILE } from '@pm/core';
import type { Broker, Segment } from '@pm/core';

export interface EngineEnv {
  uid: string;
  /** Secret Manager resource name holding the broker's READ credentials. */
  brokerSecret: string;
  /**
   * Directory holding both brokers' cached instrument masters — the backend's
   * `INSTRUMENTS_CACHE_DIR` — so the engine can follow an active-broker switch
   * without a restart. Preferred on the VM.
   */
  instrumentsDir?: string | undefined;
  /**
   * A single master URL (`file://` or `http(s)://`) when no directory is
   * configured — one broker only; local runs.
   */
  instrumentsUrl?: string | undefined;
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

/** Where `broker`'s instrument master comes from, per the configured source. */
export function instrumentSource(
  env: Pick<EngineEnv, 'instrumentsDir' | 'instrumentsUrl'>,
  broker: Broker,
): string {
  if (env.instrumentsDir !== undefined) {
    return pathToFileURL(join(env.instrumentsDir, INSTRUMENT_MASTER_FILE[broker])).href;
  }
  if (env.instrumentsUrl !== undefined) return env.instrumentsUrl;
  throw new Error('neither PM_INSTRUMENTS_DIR nor PM_INSTRUMENTS_URL is set');
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): EngineEnv {
  const interval = Number(env['PM_INTRADAY_INTERVAL_MINUTES'] ?? '5');
  const instrumentsDir = optional(env, 'PM_INSTRUMENTS_DIR');
  const instrumentsUrl = optional(env, 'PM_INSTRUMENTS_URL');
  if (instrumentsDir === undefined && instrumentsUrl === undefined) {
    throw new Error('Set PM_INSTRUMENTS_DIR (the backend cache directory) or PM_INSTRUMENTS_URL');
  }
  return {
    uid: required(env, 'PM_UID'),
    brokerSecret: required(env, 'PM_BROKER_SECRET'),
    ...(instrumentsDir === undefined ? {} : { instrumentsDir }),
    ...(instrumentsUrl === undefined ? {} : { instrumentsUrl }),
    holidays: (env['PM_HOLIDAYS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    segments: parseSegments(env['PM_INSTRUMENT_SEGMENTS']),
    prettyLogs: env['PM_PRETTY_LOGS'] === 'true',
    intradayIntervalMinutes: Number.isFinite(interval) && interval > 0 ? interval : 5,
  };
}
