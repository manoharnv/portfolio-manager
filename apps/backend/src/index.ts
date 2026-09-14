/**
 * Composition root — the ONLY place that touches Firebase, Secret Manager, a
 * real broker, timers, or `process`. Everything above it is pure logic wired
 * through the ports in `ports/index.ts`.
 *
 * Excluded from coverage by design (`vitest.config.ts`): there is nothing here
 * to unit-test that would not amount to testing the Admin SDK. What must be
 * checked on the VM instead is listed in the VERIFY-LIVE comments below.
 */

import { randomUUID } from 'node:crypto';
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import {
  DhanInstrumentMaster,
  createFetchHttpClient as createDhanHttp,
  fetchCsv as fetchDhanCsv,
  registerDhanAdapter,
} from '@pm/broker-dhan';
import {
  KiteInstrumentMaster,
  createFetchHttpClient as createKiteHttp,
  fetchCsv as fetchKiteCsv,
  registerKiteAdapter,
} from '@pm/broker-kite';
import { parseConfig } from './config.js';
import { createLogger } from './logger.js';
import { DHAN_CACHE_FILE, KITE_CACHE_FILE, writeInstrumentCache } from './instruments-cache.js';
import { createStrategyCredsSync } from './services/strategy-creds.js';
import { createFirebaseTokenVerifier } from './adapters/firebase-auth.js';
import { createSecretManagerStore } from './adapters/secret-manager.js';
import {
  createAuditLog,
  createBookRepo,
  createConfigRepo,
  createIdempotencyStore,
  createLedgerRepo,
  createOrderRepo,
  createPortfolioCache,
  createProposalRepo,
  createSessionStore,
  createStrategyDefsRepo,
} from './adapters/firestore/repos.js';
import type { FsDb, FsDocRef } from './adapters/firestore/db.js';
import { buildApp } from './http/app.js';
import { createActiveBrokerService } from './services/active-broker.js';
import { createAuditWriter } from './services/audit.js';
import { createBrokerGateway } from './services/broker-gateway.js';
import { createQuotesService } from './services/quotes.js';
import { createStrategiesService } from './services/strategies.js';
import { createCancelService } from './services/cancel.js';
import { createDailyAggregates } from './services/daily-aggregates.js';
import { createExecutionService } from './services/execution.js';
import { createKillSwitchService } from './services/killswitch.js';
import { createPortfolioService } from './services/portfolio.js';
import { createReconcileService } from './services/reconcile.js';
import { createRejectService } from './services/reject.js';
import { createSessionService } from './services/session.js';
import type { Clock, IdGenerator } from './ports/index.js';

const KITE_INSTRUMENTS_URL = 'https://api.kite.trade/instruments';

/**
 * Adapt the Admin SDK's `Firestore` onto {@link FsDb}. The casts are confined to
 * this function: the Admin types are generic over `DocumentData`, which our
 * `Record<string, unknown>` slice is compatible with in practice but not by
 * declaration.
 */
function adaptFirestore(db: Firestore): FsDb {
  const wrapDoc = (ref: FirebaseFirestore.DocumentReference): FsDocRef =>
    ref as unknown as FsDocRef;
  return {
    collection: (path) => db.collection(path) as unknown as ReturnType<FsDb['collection']>,
    doc: (path) => wrapDoc(db.doc(path)),
    runTransaction: (fn) =>
      db.runTransaction(async (txn) =>
        fn({
          get: (ref) => txn.get(ref as unknown as FirebaseFirestore.DocumentReference) as never,
          set: (ref, data, options) => {
            const target = ref as unknown as FirebaseFirestore.DocumentReference;
            if (options?.merge === true) txn.set(target, data, { merge: true });
            else txn.set(target, data);
          },
        }),
      ),
  };
}

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const logger = createLogger({
    level: config.logLevel,
    base: { service: 'pm-backend', environment: config.environment },
  });

  if (getApps().length === 0) {
    initializeApp({
      credential: applicationDefault(),
      ...(config.firebaseProjectId === '' ? {} : { projectId: config.firebaseProjectId }),
    });
  }
  const db = adaptFirestore(getFirestore());

  const clock: Clock = { now: () => new Date() };
  const ids: IdGenerator = {
    orderId: () => `ord_${randomUUID()}`,
    auditId: () => `aud_${randomUUID()}`,
    ledgerId: (orderId) => `led_${orderId}`,
  };

  // --- broker adapters (explicit registration = order capability) ---------
  const dhanHttp = createDhanHttp();
  const kiteHttp = createKiteHttp();
  // The instrument masters are multi-MB CSVs; the API clients' 10 s default
  // timed out on the e2-micro (VERIFY-LIVE, first boot). Dedicated clients with
  // a generous budget for those two downloads only.
  const csvTimeoutMs = 120_000;
  const dhanCsvHttp = createDhanHttp({ defaultTimeoutMs: csvTimeoutMs });
  const kiteCsvHttp = createKiteHttp({ defaultTimeoutMs: csvTimeoutMs });
  const dhanInstruments = new DhanInstrumentMaster();
  const kiteInstruments = new KiteInstrumentMaster();
  // Each master is also written to INSTRUMENTS_CACHE_DIR (when set) for the
  // strategy engine to read via file:// — see instruments-cache.ts.
  try {
    const csv = await fetchDhanCsv(dhanCsvHttp);
    dhanInstruments.loadFromCsv(csv, clock.now());
    const cached = await writeInstrumentCache(config.instrumentsCacheDir, DHAN_CACHE_FILE, csv);
    if (cached !== undefined) logger.info(cached, 'cached the Dhan scrip master');
  } catch (err) {
    logger.error({ err: String(err) }, 'failed to load the Dhan scrip master');
  }
  try {
    const csv = await fetchKiteCsv(kiteCsvHttp, KITE_INSTRUMENTS_URL);
    kiteInstruments.loadFromCsv(csv, clock.now());
    const cached = await writeInstrumentCache(config.instrumentsCacheDir, KITE_CACHE_FILE, csv);
    if (cached !== undefined) logger.info(cached, 'cached the Kite instrument master');
  } catch (err) {
    logger.error({ err: String(err) }, 'failed to load the Kite instrument master');
  }
  registerDhanAdapter({ instruments: dhanInstruments, http: dhanHttp, clock: () => clock.now() });
  registerKiteAdapter({ instruments: kiteInstruments, http: kiteHttp, clock: () => clock.now() });

  // --- ports --------------------------------------------------------------
  const proposals = createProposalRepo(db);
  const orders = createOrderRepo(db);
  const idempotency = createIdempotencyStore(db);
  const configs = createConfigRepo(db);
  const auditLog = createAuditLog(db);
  const sessions = createSessionStore(db);
  const portfolioCache = createPortfolioCache(db);
  const ledger = createLedgerRepo(db);
  const books = createBookRepo(db);
  const strategyDefs = createStrategyDefsRepo(db);
  const secrets = createSecretManagerStore({
    projectId: config.gcpProject === '' ? config.firebaseProjectId : config.gcpProject,
  });
  const daily = createDailyAggregates(orders, clock);
  const audit = createAuditWriter({ audit: auditLog, ids, clock, ip: config.staticIp });

  const broker = createBrokerGateway({
    configs,
    sessions,
    secrets,
    clock,
    environment: config.environment,
    secretNames: config.secrets,
    simulatorFillAfterMs: config.simulatorFillAfterMs,
  });

  // --- services -----------------------------------------------------------
  const execution = createExecutionService({
    clock,
    ids,
    logger,
    proposals,
    orders,
    idempotency,
    configs,
    books,
    ledger,
    daily,
    broker,
    sessions,
    audit,
    environment: config.environment,
    staticIp: config.staticIp,
    marketHolidays: config.marketHolidays,
  });
  const reconcile = createReconcileService({
    orders,
    proposals,
    ledger,
    books,
    broker,
    audit,
    clock,
    ids,
    logger,
    stuckAfterMs: config.stuckProposalAfterMs,
  });
  const portfolio = createPortfolioService({ broker, cache: portfolioCache, clock, audit });

  // Keeps the strategy engine's read-creds secret in step with every broker
  // login and active-broker switch (services/strategy-creds.ts).
  const strategyCreds = createStrategyCredsSync({
    secrets,
    secretName: config.strategyReadCredsSecret,
    logger,
  });

  const app = await buildApp({
    config,
    logger,
    clock,
    verifier: createFirebaseTokenVerifier(getAuth()),
    services: {
      execution,
      reconcile,
      portfolio,
      reject: createRejectService({ proposals, audit, clock }),
      cancel: createCancelService({ orders, broker, audit, clock }),
      killswitch: createKillSwitchService({ configs, audit, clock }),
      activeBroker: createActiveBrokerService({ configs, sessions, audit, clock, strategyCreds }),
      quotes: createQuotesService({ broker }),
      strategies: createStrategiesService({ defs: strategyDefs, audit }),
      session: createSessionService({
        secrets,
        sessions,
        audit,
        clock,
        http: kiteHttp,
        dhanHttp,
        secretNames: config.secrets,
        activeBrokerFor: async (uid) => (await configs.get(uid))?.activeBroker,
        strategyCreds,
        logger,
      }),
    },
  });

  // --- background loops ---------------------------------------------------
  // VERIFY-LIVE: both loops iterate `ALLOWED_UIDS`, which is the single-user /
  // family model of docs/04 §4.9. A multi-tenant deployment would need a real
  // user index instead.
  const timers: NodeJS.Timeout[] = [];
  const forEachUid = async (
    label: string,
    fn: (uid: string) => Promise<unknown>,
  ): Promise<void> => {
    for (const uid of config.allowedUids) {
      try {
        await fn(uid);
      } catch (err) {
        logger.error({ uid, task: label, err: String(err) }, 'background task failed');
      }
    }
  };
  timers.push(
    setInterval(() => {
      void forEachUid('reconcile', (uid) => reconcile.reconcileUser(uid));
    }, config.reconcileIntervalMs),
    setInterval(() => {
      void forEachUid('portfolio', (uid) => portfolio.refresh(uid));
    }, config.portfolioRefreshIntervalMs),
  );

  await app.listen({ port: config.port, host: config.host });
  logger.info(
    { port: config.port, environment: config.environment },
    'execution backend listening',
  );

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    for (const timer of timers) clearInterval(timer);
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // The logger may not exist yet (a config error happens first), and `console`
  // is banned — write the failure straight to stderr and refuse to start.
  process.stderr.write(
    `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
