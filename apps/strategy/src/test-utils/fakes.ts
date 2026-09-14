/**
 * In-memory fakes for every port. No network, no Firestore, no broker — the
 * whole engine is exercised against these (docs/00 §0.5).
 */

import type {
  AuditEvent,
  Book,
  BrokerReadAdapter,
  Candle,
  CanonicalSymbol,
  Config,
  Funds,
  Holding,
  InstrumentRef,
  LedgerEntry,
  Position,
  Proposal,
  Quote,
  SessionStatus,
  TodayAggregates,
} from '@pm/core';
import { symbolKey } from '@pm/core';
import type { HarnessDeps } from '../harness.js';
import type { Logger, Strategy, StrategyContext, StrategyDef, Tick } from '../types.js';
import type { Clock, IdGen, PortfolioSnapshot } from '../ports/index.js';
import {
  NOW_IST_1000,
  RELIANCE,
  TEST_UID,
  makeBook,
  makeConfig,
  makeFunds,
  makeInstrument,
  makeSession,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// System ports
// ---------------------------------------------------------------------------

export function fixedClock(iso: string = NOW_IST_1000): Clock {
  return { now: (): Date => new Date(iso) };
}

export function seqIdGen(): IdGen {
  const counters = new Map<string, number>();
  return {
    next(prefix: string): string {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}-${n}`;
    },
  };
}

export interface RecordingLogger extends Logger {
  readonly lines: { level: string; obj: object; msg?: string | undefined }[];
}

export function recordingLogger(bindings: Record<string, unknown> = {}): RecordingLogger {
  const lines: { level: string; obj: object; msg?: string | undefined }[] = [];
  const make = (own: Record<string, unknown>): RecordingLogger => {
    const write =
      (level: string) =>
      (obj: object, msg?: string): void => {
        lines.push({ level, obj: { ...own, ...obj }, msg });
      };
    return {
      lines,
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      child: (extra: Record<string, unknown>): Logger => make({ ...own, ...extra }),
    };
  };
  return make(bindings);
}

// ---------------------------------------------------------------------------
// A fake BrokerReadAdapter — the read surface has no order methods to fake.
// ---------------------------------------------------------------------------

export interface FakeReadAdapterState {
  holdings: Holding[];
  positions: Position[];
  funds: Funds;
  quotes: Map<string, Quote>;
  candles: Map<string, Candle[]>;
  instruments: Map<string, InstrumentRef>;
  session: SessionStatus;
  /** Set to make `resolveInstrument` throw, exercising the fail-closed path. */
  instrumentError?: string | undefined;
}

export function fakeReadAdapterState(
  patch?: Partial<FakeReadAdapterState> | undefined,
): FakeReadAdapterState {
  return {
    holdings: [],
    positions: [],
    funds: makeFunds(),
    quotes: new Map(),
    candles: new Map(),
    instruments: new Map([[symbolKey(RELIANCE), makeInstrument()]]),
    session: makeSession(),
    ...patch,
  };
}

export function fakeReadAdapter(state: FakeReadAdapterState): BrokerReadAdapter {
  return {
    broker: 'dhan',
    getSessionStatus: (): Promise<SessionStatus> => Promise.resolve(state.session),
    getHoldings: (): Promise<Holding[]> => Promise.resolve(state.holdings),
    getPositions: (): Promise<Position[]> => Promise.resolve(state.positions),
    getFunds: (): Promise<Funds> => Promise.resolve(state.funds),
    resolveInstrument: (sym: CanonicalSymbol): Promise<InstrumentRef> => {
      if (state.instrumentError !== undefined) {
        return Promise.reject(new Error(state.instrumentError));
      }
      const found = state.instruments.get(symbolKey(sym));
      return found === undefined
        ? Promise.reject(new Error(`no instrument for ${symbolKey(sym)}`))
        : Promise.resolve(found);
    },
    getQuote: (syms: CanonicalSymbol[]): Promise<Quote[]> =>
      Promise.resolve(
        syms.map((s) => state.quotes.get(symbolKey(s))).filter((q): q is Quote => q !== undefined),
      ),
    getHistorical: (req): Promise<Candle[]> =>
      Promise.resolve(state.candles.get(symbolKey(req.symbol)) ?? []),
  };
}

// ---------------------------------------------------------------------------
// The whole harness, wired to mutable in-memory state
// ---------------------------------------------------------------------------

export interface HarnessState {
  config: Config | undefined;
  defs: StrategyDef[];
  books: Book[];
  ledger: LedgerEntry[];
  openProposals: Proposal[];
  portfolio: PortfolioSnapshot;
  quotes: Map<string, Quote>;
  candles: Map<string, Candle[]>;
  instruments: Map<string, InstrumentRef>;
  session: SessionStatus | undefined;
  today: TodayAggregates;
  /** Symbols whose instrument lookup should fail (fail-closed path). */
  unresolvableInstruments: Set<string>;
}

export interface TestHarness {
  state: HarnessState;
  deps: HarnessDeps;
  written: Proposal[];
  audits: AuditEvent[];
  logger: RecordingLogger;
  /** Every symbol the harness asked for a quote on, in order. */
  quoteCalls: string[][];
}

export interface TestHarnessOptions {
  now?: string | undefined;
  state?: Partial<HarnessState> | undefined;
  registry?: ReadonlyMap<string, Strategy> | undefined;
  holidays?: readonly string[] | undefined;
  riskLimits?: HarnessDeps['riskLimits'];
  /** Make `proposalRepo.create` throw, to exercise the write path's failure. */
  createError?: string | undefined;
}

export function defaultHarnessState(patch?: Partial<HarnessState> | undefined): HarnessState {
  return {
    config: makeConfig(),
    defs: [],
    books: [],
    ledger: [],
    openProposals: [],
    portfolio: { holdings: [], positions: [], funds: makeFunds() },
    quotes: new Map(),
    candles: new Map(),
    instruments: new Map([[symbolKey(RELIANCE), makeInstrument()]]),
    session: makeSession(),
    today: { orderCount: 0, notionalInr: 0 },
    unresolvableInstruments: new Set(),
    ...patch,
  };
}

export function createTestHarness(options: TestHarnessOptions = {}): TestHarness {
  const state = defaultHarnessState(options.state);
  const written: Proposal[] = [];
  const audits: AuditEvent[] = [];
  const quoteCalls: string[][] = [];
  const logger = recordingLogger();

  const readState = fakeReadAdapterState({
    holdings: state.portfolio.holdings,
    positions: state.portfolio.positions,
    funds: state.portfolio.funds,
    quotes: state.quotes,
    candles: state.candles,
    instruments: state.instruments,
    session: state.session ?? makeSession(),
  });

  const deps: HarnessDeps = {
    configRepo: { get: (): Promise<Config | undefined> => Promise.resolve(state.config) },
    defsRepo: {
      listEnabled: (): Promise<StrategyDef[]> =>
        Promise.resolve(state.defs.filter((d) => d.enabled)),
    },
    proposalRepo: {
      listOpen: (): Promise<Proposal[]> => Promise.resolve([...state.openProposals]),
      create: (proposal: Proposal): Promise<void> => {
        if (options.createError !== undefined) {
          return Promise.reject(new Error(options.createError));
        }
        written.push(proposal);
        return Promise.resolve();
      },
    },
    auditLog: {
      append: (event: AuditEvent): Promise<void> => {
        audits.push(event);
        return Promise.resolve();
      },
    },
    portfolio: { snapshot: (): Promise<PortfolioSnapshot> => Promise.resolve(state.portfolio) },
    market: {
      quotes: (symbols): Promise<Map<string, Quote>> => {
        quoteCalls.push(symbols.map(symbolKey));
        const out = new Map<string, Quote>();
        for (const s of symbols) {
          const q = state.quotes.get(symbolKey(s));
          if (q !== undefined) out.set(symbolKey(s), q);
        }
        return Promise.resolve(out);
      },
      historical: (req): Promise<Candle[]> =>
        Promise.resolve(state.candles.get(symbolKey(req.symbol)) ?? []),
      instrument: (symbol): Promise<InstrumentRef | undefined> =>
        Promise.resolve(
          state.unresolvableInstruments.has(symbolKey(symbol))
            ? undefined
            : state.instruments.get(symbolKey(symbol)),
        ),
    },
    ledgerRepo: { listEntries: (): Promise<LedgerEntry[]> => Promise.resolve([...state.ledger]) },
    bookRepo: { listBooks: (): Promise<Book[]> => Promise.resolve([...state.books]) },
    sessions: {
      status: (): Promise<SessionStatus | undefined> => Promise.resolve(state.session),
    },
    aggregates: { today: (): Promise<TodayAggregates> => Promise.resolve(state.today) },
    clock: fixedClock(options.now ?? NOW_IST_1000),
    ids: seqIdGen(),
    read: fakeReadAdapter(readState),
    logger,
    registry: options.registry,
    holidays: options.holidays,
    riskLimits: options.riskLimits,
  };

  return { state, deps, written, audits, logger, quoteCalls };
}

// ---------------------------------------------------------------------------
// A StrategyContext, for testing one strategy in isolation
// ---------------------------------------------------------------------------

export interface StrategyContextOptions<P> {
  params: P;
  book?: Book | undefined;
  def?: StrategyDef | undefined;
  ledger?: readonly LedgerEntry[] | undefined;
  quotes?: Map<string, Quote> | undefined;
  candles?: Map<string, Candle[]> | undefined;
  instruments?: Map<string, InstrumentRef> | undefined;
  portfolio?: PortfolioSnapshot | undefined;
  config?: Config | undefined;
  now?: string | undefined;
  tick?: Tick | undefined;
}

export function makeStrategyContext<P>(options: StrategyContextOptions<P>): StrategyContext<P> {
  const book = options.book ?? makeBook();
  const def: StrategyDef = options.def ?? {
    id: 'test-strategy',
    bookId: book.id,
    horizon: 'long_term',
    enabled: true,
    params: {},
  };
  const quotes = options.quotes ?? new Map<string, Quote>();
  const candles = options.candles ?? new Map<string, Candle[]>();
  const instruments =
    options.instruments ??
    new Map<string, InstrumentRef>([[symbolKey(RELIANCE), makeInstrument()]]);
  const portfolio = options.portfolio ?? {
    holdings: [],
    positions: [],
    funds: makeFunds(),
  };

  const readState = fakeReadAdapterState({
    holdings: portfolio.holdings,
    positions: portfolio.positions,
    funds: portfolio.funds,
    quotes,
    candles,
    instruments,
  });

  return {
    uid: TEST_UID,
    config: options.config ?? makeConfig(),
    read: fakeReadAdapter(readState),
    portfolio,
    now: new Date(options.now ?? NOW_IST_1000),
    logger: recordingLogger(),
    tick: options.tick ?? 'intraday',
    def,
    params: options.params,
    book,
    ledger: options.ledger ?? [],
    market: {
      quotes: (symbols): Promise<Map<string, Quote>> => {
        const out = new Map<string, Quote>();
        for (const s of symbols) {
          const q = quotes.get(symbolKey(s));
          if (q !== undefined) out.set(symbolKey(s), q);
        }
        return Promise.resolve(out);
      },
      historical: (req): Promise<Candle[]> =>
        Promise.resolve(candles.get(symbolKey(req.symbol)) ?? []),
      instrument: (symbol): Promise<InstrumentRef | undefined> =>
        Promise.resolve(instruments.get(symbolKey(symbol))),
    },
  };
}

/** `symbolKey` → quote, from a list of quotes. */
export function quoteMap(quotes: readonly Quote[]): Map<string, Quote> {
  return new Map(quotes.map((q) => [symbolKey(q.symbol), q]));
}

/** `symbolKey` → instrument, from a list of instruments. */
export function instrumentMap(instruments: readonly InstrumentRef[]): Map<string, InstrumentRef> {
  return new Map(instruments.map((i) => [symbolKey(i.canonical), i]));
}
