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
import type { Broker, BrokerCreds, BrokerReadAdapter, Segment } from '@pm/core';
import { createLogger } from './logger.js';
import { instrumentSource, readEnv, type EngineEnv } from './env.js';
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

async function loadSecret(name: string): Promise<string> {
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name });
  const data = version.payload?.data;
  if (data === null || data === undefined) {
    throw new Error(`Secret ${name} has no payload`);
  }
  return typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A broker's parsed instrument master. The two brokers' masters are different
 * files; with `PM_INSTRUMENTS_DIR` the engine can load either on demand, with
 * only `PM_INSTRUMENTS_URL` it is pinned to one broker.
 */
type LoadedMaster =
  | { broker: 'dhan'; instruments: DhanInstrumentMaster }
  | { broker: 'kite'; instruments: KiteInstrumentMaster };

async function loadMaster(
  broker: Broker,
  source: string,
  segments: readonly Segment[],
  now: Date,
): Promise<LoadedMaster> {
  // file:// on the VM (the backend's local cache), http(s):// for local runs.
  const csv = await readInstrumentsSource(source);
  if (broker === 'dhan') {
    const instruments = new DhanInstrumentMaster();
    instruments.loadFromCsv(csv, now, { segments });
    return { broker, instruments };
  }
  const instruments = new KiteInstrumentMaster();
  instruments.loadFromCsv(csv, now, { segments });
  return { broker, instruments };
}

/** Read-only broker handle. Order capability is not reachable from this process. */
function buildReadAdapter(creds: BrokerCreds, master: LoadedMaster): BrokerReadAdapter {
  return master.broker === 'dhan'
    ? createDhanReadAdapter(creds, { instruments: master.instruments })
    : createKiteReadAdapter(creds, { instruments: master.instruments });
}

/** The credentials as last read from Secret Manager, and what was built from them. */
interface BrokerHandle {
  raw: string;
  creds: BrokerCreds;
  master: LoadedMaster;
  read: BrokerReadAdapter;
}

function parseCreds(raw: string): BrokerCreds {
  const creds = JSON.parse(raw) as BrokerCreds;
  if (creds.broker !== 'dhan' && creds.broker !== 'kite') {
    throw new Error(`read-creds secret names no known broker (got '${String(creds.broker)}')`);
  }
  return creds;
}

/**
 * Re-read the read-creds secret before a tick and rebuild the adapter when
 * its payload changed. The execution backend rewrites that secret after every
 * daily login and active-broker switch (apps/backend services/strategy-creds.ts),
 * and this process must not run the day on yesterday's token. One small
 * Secret Manager read per tick; nothing is rebuilt when nothing changed.
 *
 * A switch to the other broker loads that broker's master from
 * `PM_INSTRUMENTS_DIR`; with only `PM_INSTRUMENTS_URL` the switch is refused.
 *
 * Fail closed on trouble (docs/00 §0.7): a read, parse or load error keeps the
 * previous credentials — whose session check refuses ticks once they expire.
 */
async function refreshBroker(
  previous: BrokerHandle,
  env: EngineEnv,
  logger: HarnessDeps['logger'],
): Promise<BrokerHandle> {
  let raw: string;
  let creds: BrokerCreds;
  try {
    raw = await loadSecret(env.brokerSecret);
    if (raw === previous.raw) return previous;
    creds = parseCreds(raw);
  } catch (err) {
    logger.error(
      { err: message(err) },
      'could not re-read the broker read-creds secret — keeping the previous credentials',
    );
    return previous;
  }

  let master = previous.master;
  if (creds.broker !== master.broker) {
    if (env.instrumentsDir === undefined) {
      logger.error(
        { loaded: master.broker, wanted: creds.broker },
        "active broker changed but this process is pinned to the other broker's instrument master (PM_INSTRUMENTS_URL) — set PM_INSTRUMENTS_DIR or restart pm-strategy; keeping the previous credentials",
      );
      return previous;
    }
    try {
      master = await loadMaster(
        creds.broker,
        instrumentSource(env, creds.broker),
        env.segments,
        new Date(),
      );
      logger.info(
        { broker: creds.broker, segments: env.segments, size: master.instruments.size },
        'instrument master indexed for the new active broker',
      );
    } catch (err) {
      logger.error(
        { broker: creds.broker, err: message(err) },
        "could not load the new active broker's instrument master — keeping the previous credentials",
      );
      return previous;
    }
  }

  const read = buildReadAdapter(creds, master);
  logger.info(
    { broker: creds.broker, expiresAt: creds[creds.broker]?.expiresAt },
    'broker credentials refreshed',
  );
  return { raw, creds, master, read };
}

type BaseDeps = Omit<HarnessDeps, 'read' | 'portfolio' | 'market' | 'sessions'>;

/** Everything a tick needs that is not the broker: fixed for the process lifetime. */
function withBroker(base: BaseDeps, read: BrokerReadAdapter): HarnessDeps {
  return {
    ...base,
    read,
    portfolio: createBrokerPortfolioSource(read),
    market: createBrokerMarketData(read),
    sessions: createBrokerSessionSource(read),
  };
}

interface TickRunner {
  clock: HarnessDeps['clock'];
  logger: HarnessDeps['logger'];
  /** Refreshes the broker credentials, then hands back this tick's deps. */
  resolveDeps(): Promise<HarnessDeps>;
}

export async function main(): Promise<void> {
  const env = readEnv();
  const logger = createLogger({ pretty: env.prettyLogs, name: 'strategy-engine' });

  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() });
  }
  const db: FirestoreLike = getFirestore();

  const startedAt = new Date();
  const initialRaw = await loadSecret(env.brokerSecret);
  const initialCreds = parseCreds(initialRaw);
  const master = await loadMaster(
    initialCreds.broker,
    instrumentSource(env, initialCreds.broker),
    env.segments,
    startedAt,
  );
  logger.info(
    { broker: initialCreds.broker, segments: env.segments, size: master.instruments.size },
    'instrument master indexed',
  );
  let broker: BrokerHandle = {
    raw: initialRaw,
    creds: initialCreds,
    master,
    read: buildReadAdapter(initialCreds, master),
  };
  logger.info(
    { broker: initialCreds.broker, expiresAt: initialCreds[initialCreds.broker]?.expiresAt },
    'broker credentials loaded',
  );

  const base: BaseDeps = {
    configRepo: createFirestoreConfigRepo(db),
    defsRepo: createFirestoreStrategyDefsRepo(db),
    proposalRepo: createFirestoreProposalRepo(db),
    auditLog: createFirestoreAuditLog(db),
    ledgerRepo: createFirestoreLedgerRepo(db),
    bookRepo: createFirestoreBookRepo(db),
    aggregates: createFirestoreAggregatesSource(db),
    clock: { now: (): Date => new Date() },
    ids: {
      next: (prefix: string): string => `${prefix}_${crypto.randomUUID()}`,
    },
    logger,
    holidays: env.holidays,
  };

  const runner: TickRunner = {
    clock: base.clock,
    logger,
    resolveDeps: async (): Promise<HarnessDeps> => {
      broker = await refreshBroker(broker, env, logger);
      return withBroker(base, broker.read);
    },
  };

  const schedule: ScheduleConfig = resolveSchedule({
    holidays: env.holidays,
    intradayIntervalMinutes: env.intradayIntervalMinutes,
  });
  const patterns = cronExpressions(schedule);

  for (const tick of TICKS) {
    const pattern = patterns[tick];
    new Cron(pattern, { timezone: IST, name: `strategy-${tick}` }, () => {
      void runOne(tick, env.uid, schedule, runner);
    });
    logger.info({ tick, pattern }, 'tick scheduled');
  }

  logger.info(
    { uid: env.uid, broker: broker.read.broker },
    'strategy engine started (proposals only)',
  );
}

async function runOne(
  tick: Tick,
  uid: string,
  schedule: ScheduleConfig,
  runner: TickRunner,
): Promise<void> {
  const now = runner.clock.now();
  if (!isTickDue(now, tick, schedule)) return;
  try {
    const deps = await runner.resolveDeps();
    const summary = await runTick({ uid, tick, deps });
    runner.logger.info(
      { tick, written: summary.written.length, dropped: summary.dropped.length },
      'tick complete',
    );
  } catch (err) {
    runner.logger.error({ tick, err: message(err) }, 'tick failed');
  }
}

await main();
