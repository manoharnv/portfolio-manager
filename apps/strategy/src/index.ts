/**
 * Strategy-engine process entry point — the composition root.
 *
 * This is the **only** file that touches the outside world: environment,
 * Secret Manager, Firestore, the broker's HTTP API and the wall clock. Every
 * other module takes what it needs as a parameter (docs/00 §0.5).
 *
 * The broker handle is built with `createDhanReadAdapter` /
 * `createKiteReadAdapter` — read-only factories whose result has no order
 * methods on it at runtime. The full-adapter factories are never imported here,
 * and `eslint.config.js` + `policy.test.ts` enforce that mechanically
 * (docs/05 §5.1).
 */

import { Cron } from 'croner';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { DhanInstrumentMaster, createDhanReadAdapter } from '@pm/broker-dhan';
import { KiteInstrumentMaster, createKiteReadAdapter } from '@pm/broker-kite';
import type { BrokerCreds, BrokerReadAdapter } from '@pm/core';
import { createLogger } from './logger.js';
import { readInstrumentsSource } from './instruments-source.js';
import { runTick, type HarnessDeps } from './harness.js';
import { TICKS, type Tick } from './types.js';
import { cronExpressions, isTickDue, resolveSchedule, type ScheduleConfig } from './schedule.js';
import {
  createBrokerMarketData,
  createBrokerPortfolioSource,
  createBrokerSessionSource,
} from './adapters/broker.js';
import {
  createFirestoreAggregatesSource,
  createFirestoreAuditLog,
  createFirestoreBookRepo,
  createFirestoreConfigRepo,
  createFirestoreLedgerRepo,
  createFirestoreProposalRepo,
  createFirestoreStrategyDefsRepo,
  type FirestoreLike,
} from './adapters/firestore/index.js';

const IST = 'Asia/Kolkata';

export interface EngineEnv {
  uid: string;
  /** Secret Manager resource name holding the broker's READ credentials. */
  brokerSecret: string;
  /** Instrument-master CSV URL for the active broker. */
  instrumentsUrl: string;
  holidays: string[];
  prettyLogs: boolean;
  intradayIntervalMinutes: number;
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
    prettyLogs: env['PM_PRETTY_LOGS'] === 'true',
    intradayIntervalMinutes: Number.isFinite(interval) && interval > 0 ? interval : 5,
  };
}

async function loadSecret(name: string): Promise<string> {
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name });
  const data = version.payload?.data;
  if (data === null || data === undefined) {
    throw new Error(`Secret ${name} has no payload`);
  }
  return typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
}

/** Read-only broker handle. Order capability is not reachable from this process. */
async function buildReadAdapter(
  creds: BrokerCreds,
  instrumentsUrl: string,
  now: Date,
): Promise<BrokerReadAdapter> {
  // file:// on the VM (the backend's local cache), http(s):// for local runs.
  const csv = await readInstrumentsSource(instrumentsUrl);
  if (creds.broker === 'dhan') {
    const instruments = new DhanInstrumentMaster();
    instruments.loadFromCsv(csv, now);
    return createDhanReadAdapter(creds, { instruments });
  }
  const instruments = new KiteInstrumentMaster();
  instruments.loadFromCsv(csv, now);
  return createKiteReadAdapter(creds, { instruments });
}

export async function main(): Promise<void> {
  const env = readEnv();
  const logger = createLogger({ pretty: env.prettyLogs, name: 'strategy-engine' });

  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() });
  }
  const db: FirestoreLike = getFirestore();

  const creds = JSON.parse(await loadSecret(env.brokerSecret)) as BrokerCreds;
  const read = await buildReadAdapter(creds, env.instrumentsUrl, new Date());

  const deps: HarnessDeps = {
    configRepo: createFirestoreConfigRepo(db),
    defsRepo: createFirestoreStrategyDefsRepo(db),
    proposalRepo: createFirestoreProposalRepo(db),
    auditLog: createFirestoreAuditLog(db),
    portfolio: createBrokerPortfolioSource(read),
    market: createBrokerMarketData(read),
    ledgerRepo: createFirestoreLedgerRepo(db),
    bookRepo: createFirestoreBookRepo(db),
    sessions: createBrokerSessionSource(read),
    aggregates: createFirestoreAggregatesSource(db),
    clock: { now: (): Date => new Date() },
    ids: {
      next: (prefix: string): string => `${prefix}_${crypto.randomUUID()}`,
    },
    read,
    logger,
    holidays: env.holidays,
  };

  const schedule: ScheduleConfig = resolveSchedule({
    holidays: env.holidays,
    intradayIntervalMinutes: env.intradayIntervalMinutes,
  });
  const patterns = cronExpressions(schedule);

  for (const tick of TICKS) {
    const pattern = patterns[tick];
    new Cron(pattern, { timezone: IST, name: `strategy-${tick}` }, () => {
      void runOne(tick, env.uid, deps, schedule);
    });
    logger.info({ tick, pattern }, 'tick scheduled');
  }

  logger.info({ uid: env.uid, broker: read.broker }, 'strategy engine started (proposals only)');
}

async function runOne(
  tick: Tick,
  uid: string,
  deps: HarnessDeps,
  schedule: ScheduleConfig,
): Promise<void> {
  const now = deps.clock.now();
  if (!isTickDue(now, tick, schedule)) return;
  try {
    const summary = await runTick({ uid, tick, deps });
    deps.logger.info(
      { tick, written: summary.written.length, dropped: summary.dropped.length },
      'tick complete',
    );
  } catch (err) {
    deps.logger.error(
      { tick, err: err instanceof Error ? err.message : String(err) },
      'tick failed',
    );
  }
}

await main();
