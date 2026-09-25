/* eslint-disable no-console -- operator CLI: stdout is the interface; docs/00 §0.7.5 governs library code */
/**
 * seed-user.ts — provision the operator-owned Firestore documents for one user.
 *
 * firestore.rules deliberately forbid the client app from *creating* these
 * documents (docs/03 §3.9): `config/{uid}`, `users/{uid}`,
 * `books/{uid}/books/*`, `strategies/{uid}/defs/*`, `brokerSessions/{uid}/…`.
 * They are provisioned once by an operator with the Admin SDK — this script —
 * after which the app (guardrails, kill switch, strategy toggles, prefs) and
 * the backend (`activeBroker`, session status) edit them within the rules.
 *
 * Safety properties:
 *  - Every document is validated against the SAME zod schemas the readers use
 *    (`@pm/core` for config/books/sessions, this app's `StrategyDefSchema`, and
 *    each strategy's own `parseParams`) BEFORE anything is written. One invalid
 *    doc aborts the whole run.
 *  - Writes use `create()` and fail if a document already exists. `--force`
 *    switches to `set()` (full overwrite) — use it knowingly; it will clobber
 *    live guardrail edits and book P&L.
 *  - Seeded defaults are conservative and inert: environment=dry-run,
 *    tradingEnabled=false, every strategy disabled, small caps. Nothing here
 *    can cause an order.
 *
 * Usage (from apps/strategy):
 *   GOOGLE_CLOUD_QUOTA_PROJECT=<project> pnpm exec tsx scripts/seed-user.ts \
 *     --project <gcp-project-id> --uid <firebaseUid> --email <email> [--capital 100000] [--dry-run] [--force]
 *
 * Auth: Application Default Credentials (`gcloud auth application-default login`).
 */
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  ABS_MAX_DAILY_NOTIONAL_INR,
  ABS_MAX_ORDERS_PER_DAY,
  ABS_MAX_ORDER_VALUE_INR,
  BookSchema,
  BrokerSessionSchema,
  ConfigSchema,
  type Book,
  type BrokerSession,
  type Config,
} from '@pm/core';
import { STRATEGY_REGISTRY } from '../src/strategies/index.js';
import { StrategyDefSchema, type StrategyDef } from '../src/types.js';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

interface Args {
  project: string;
  uid: string;
  email: string;
  capital: number;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const required = (flag: string): string => {
    const v = get(flag);
    if (v === undefined || v.startsWith('--')) throw new Error(`missing ${flag} <value>`);
    return v;
  };
  const capitalRaw = get('--capital');
  const capital = capitalRaw === undefined ? 100_000 : Number(capitalRaw);
  if (!Number.isFinite(capital) || capital <= 0)
    throw new Error('--capital must be a positive number');
  return {
    project: required('--project'),
    uid: required('--uid'),
    email: required('--email'),
    capital,
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
  };
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

const now = (): string => new Date().toISOString();

const NSE = (tradingSymbol: string) => ({
  exchange: 'NSE' as const,
  segment: 'EQ' as const,
  tradingSymbol,
});

function buildConfig(uid: string, capital: number): Config {
  // Starting caps from docs/09 "open questions" defaults — deliberately small.
  // All are user-editable in the app (Settings → Guardrails) within the code
  // ceilings; the backend re-clamps regardless.
  return ConfigSchema.parse({
    uid,
    activeBroker: 'dhan',
    environment: 'dry-run',
    killSwitch: false,
    // Off until broker credentials exist: the engine no-ops (audited) and the
    // human flips it on from the dashboard when ready.
    tradingEnabled: false,
    guardrails: {
      maxOrderValueInr: 10_000,
      maxDailyNotionalInr: 25_000,
      maxOrdersPerDay: 5,
      // docs/09 decision: equity CNC + MIS for v1; F&O later.
      allowedSegments: ['EQ'],
      allowedProducts: ['DELIVERY', 'INTRADAY'],
      symbolAllowlist: null,
      symbolBlocklist: [],
      priceCollarPct: 1,
      proposalTtlSeconds: 300,
      requireBiometric: true,
    },
    totalManagedCapitalInr: capital,
    reservePct: 5,
    coordinator: {
      nettingEnabled: false,
      washWindowSeconds: 60,
      precedence: ['long_term', 'swing', 'day_trade', 'scalp'],
    },
    updatedAt: now(),
  });
}

function buildBooks(capital: number): Book[] {
  // docs/10 §10.3 split: long-term 50 / swing 30 / day-trade 15 / reserve 5.
  // Scalp is DEFERRED by decision (docs/10 §10.7): present, disabled, 0 %.
  const book = (
    id: Book['id'],
    label: string,
    allocationPct: number,
    product: Book['product'],
    risk: Book['risk'],
    enabled = true,
  ): Book =>
    BookSchema.parse({
      id,
      label,
      enabled,
      allocationPct,
      allocatedCapitalInr: Math.round((capital * allocationPct) / 100),
      deployedInr: 0,
      realizedPnlInr: 0,
      product,
      risk,
    });
  return [
    book('long_term', 'Long-term', 50, 'DELIVERY', {
      maxPositions: 10,
      maxPositionValueInr: 20_000,
      dailyLossStopInr: 5_000,
      perTradeRiskPct: 2,
    }),
    book('swing', 'Swing', 30, 'DELIVERY', {
      maxPositions: 6,
      maxPositionValueInr: 15_000,
      dailyLossStopInr: 3_000,
      perTradeRiskPct: 1.5,
    }),
    book('day_trade', 'Day trade', 15, 'INTRADAY', {
      maxPositions: 3,
      maxPositionValueInr: 10_000,
      dailyLossStopInr: 1_500,
      perTradeRiskPct: 1,
    }),
    book(
      'scalp',
      'Scalp (deferred)',
      0,
      'INTRADAY',
      { maxPositions: 0, maxPositionValueInr: 0, dailyLossStopInr: 0, perTradeRiskPct: 0 },
      false,
    ),
  ];
}

function buildStrategyDefs(): StrategyDef[] {
  // Every def starts DISABLED with placeholder instruments (large-cap NSE names)
  // so nothing runs until the human enables it from Settings → Strategies.
  // Params are validated below by each strategy's own schema.
  const defs = [
    {
      id: 'dca',
      bookId: 'long_term',
      horizon: 'long_term',
      label: 'SIP / DCA',
      enabled: false,
      params: {
        instruments: [NSE('RELIANCE'), NSE('INFY')],
        amountInrPerInstrument: 2_000,
        frequency: 'weekly',
        weekdayIst: 1,
      },
    },
    {
      id: 'rebalance_drift',
      bookId: 'long_term',
      horizon: 'long_term',
      label: 'Rebalance drift',
      enabled: false,
      params: {
        targets: [
          { symbol: NSE('RELIANCE'), weightPct: 50 },
          { symbol: NSE('INFY'), weightPct: 50 },
        ],
        bandPct: 5,
        minTradeValueInr: 1_000,
      },
    },
    {
      id: 'stop_target_monitor',
      bookId: 'swing',
      horizon: 'swing',
      label: 'Stop / target monitor',
      enabled: false,
      params: {
        levels: [{ symbol: NSE('RELIANCE'), stopPrice: 2_500, targetPrice: 3_200 }],
      },
    },
    {
      id: 'breakout_entry',
      bookId: 'swing',
      horizon: 'swing',
      label: 'Breakout entry',
      enabled: false,
      params: {
        instruments: [NSE('TCS'), NSE('HDFCBANK')],
        lookbackCandles: 20,
        volumeMultiple: 1.5,
        stopPct: 3,
        interval: '1d',
      },
    },
    {
      id: 'opening_range_breakout',
      bookId: 'day_trade',
      horizon: 'day_trade',
      label: 'Opening-range breakout',
      enabled: false,
      params: {
        instruments: [NSE('RELIANCE')],
        rangeMinutes: 15,
        entryCutoffMinuteIst: 14 * 60,
        allowShort: false,
        interval: '5m',
      },
    },
    {
      id: 'eod_square_off',
      bookId: 'day_trade',
      horizon: 'day_trade',
      label: 'EOD square-off',
      enabled: false,
      params: { orderType: 'MARKET', squareOffMinutesBeforeClose: 15 },
    },
  ];
  return defs.map((raw) => {
    const def = StrategyDefSchema.parse(raw);
    const impl = STRATEGY_REGISTRY.get(def.id);
    if (impl === undefined) throw new Error(`no registered strategy with id "${def.id}"`);
    if (impl.horizon !== def.horizon) {
      throw new Error(`strategy "${def.id}" is ${impl.horizon}, def says ${def.horizon}`);
    }
    impl.parseParams(def.params); // throws ZodError on bad params — fail closed
    return def;
  });
}

function buildBrokerSessions(): BrokerSession[] {
  return (['dhan', 'kite'] as const).map((broker) =>
    BrokerSessionSchema.parse({
      broker,
      connected: false,
      expiresAt: null,
      staticIpOk: false,
      lastConnectedAt: null,
    }),
  );
}

function buildUser(email: string) {
  // Only `fcmTokens` and `prefs` are client-editable (firestore.rules hasOnly).
  return {
    email,
    fcmTokens: [] as string[],
    prefs: { proposals: true, fills: true, blocks: true, session: true, killSwitch: true },
    createdAt: now(),
  };
}

// ---------------------------------------------------------------------------
// cross-document invariants
// ---------------------------------------------------------------------------

function assertInvariants(config: Config, books: Book[]): void {
  const alloc = books.reduce((s, b) => s + b.allocationPct, 0);
  if (alloc + config.reservePct > 100) {
    throw new Error(`Σ allocationPct (${alloc}) + reservePct (${config.reservePct}) exceeds 100`);
  }
  const g = config.guardrails;
  if (g.maxOrderValueInr > ABS_MAX_ORDER_VALUE_INR)
    throw new Error('maxOrderValueInr above code ceiling');
  if (g.maxDailyNotionalInr > ABS_MAX_DAILY_NOTIONAL_INR)
    throw new Error('maxDailyNotionalInr above code ceiling');
  if (g.maxOrdersPerDay > ABS_MAX_ORDERS_PER_DAY)
    throw new Error('maxOrdersPerDay above code ceiling');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const config = buildConfig(args.uid, args.capital);
  const books = buildBooks(args.capital);
  const defs = buildStrategyDefs();
  const sessions = buildBrokerSessions();
  const user = buildUser(args.email);
  assertInvariants(config, books);

  const docs: Array<{ path: string; data: Record<string, unknown> }> = [
    { path: `config/${args.uid}`, data: config },
    { path: `users/${args.uid}`, data: user },
    ...books.map((b) => ({ path: `books/${args.uid}/books/${b.id}`, data: b })),
    ...defs.map((d) => ({ path: `strategies/${args.uid}/defs/${d.id}`, data: d })),
    ...sessions.map((s) => ({ path: `brokerSessions/${args.uid}/brokers/${s.broker}`, data: s })),
  ];

  console.log(`validated ${docs.length} documents for uid=${args.uid} project=${args.project}`);
  for (const d of docs) console.log(`  ${args.dryRun ? '[dry-run] ' : ''}${d.path}`);
  if (args.dryRun) {
    console.log(JSON.stringify({ config, books, defs, sessions, user }, null, 2));
    return;
  }

  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: args.project });
  }
  const db = getFirestore();

  let created = 0;
  for (const d of docs) {
    const ref = db.doc(d.path);
    if (args.force) {
      await ref.set(d.data);
    } else {
      // create() rejects if the doc exists — never silently clobber live state.
      await ref.create(d.data);
    }
    created += 1;
  }
  console.log(`${args.force ? 'wrote' : 'created'} ${created} documents`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
});
