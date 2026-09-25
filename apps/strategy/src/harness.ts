/**
 * The execution harness — docs/05-strategy-engine.md §5.4, with the
 * multi-strategy stages of docs/10 §§10.5–10.6.
 *
 * ```
 * load config → gate (tradingEnabled / killSwitch / session)
 *   → snapshot portfolio + books + ledger + open proposals + today's aggregates
 *   → select the tick's strategies → run each inside its book
 *   → coordinator (docs/10 §10.5) → portfolio risk manager (§10.6)
 *   → guardrail PRE-filter (docs/04 §4.5) → book budget → dedupe
 *   → write `proposals` (status=pending) → audit `proposal.created`
 * ```
 *
 * What it cannot do: place, modify or cancel an order. The only broker object it
 * holds is a `BrokerReadAdapter` and the only collections it writes are
 * `proposals` and `auditLog` (docs/05 §5.1).
 */

import {
  ProposalSchema,
  assessPortfolioRisk,
  canDeploy,
  canExit,
  clampConfigToCeilings,
  estimateOrderNotionalInr,
  failedChecks,
  istDateKey,
  positionsByBook,
  runCoordinator,
  runGuardrails,
  symbolKey,
} from '@pm/core';
import type {
  AuditEvent,
  AuditEventType,
  Book,
  CanonicalSymbol,
  Config,
  GuardrailResult,
  LedgerEntry,
  OpenIntradayPosition,
  Proposal,
  Quote,
  RiskLimits,
  SessionStatus,
} from '@pm/core';
import type {
  AggregatesSource,
  AuditLog,
  BookRepo,
  Clock,
  ConfigRepo,
  IdGen,
  LedgerRepo,
  MarketData,
  PortfolioSnapshot,
  PortfolioSource,
  ProposalRepo,
  SessionStatusSource,
  StrategyDefsRepo,
} from './ports/index.js';
import type { BrokerReadAdapter } from '@pm/core';
import type { Logger, ProposalDraft, Strategy, StrategyDef, Tick } from './types.js';
import { STRATEGY_REGISTRY } from './strategies/index.js';
import { strategiesForTick } from './schedule.js';

/** Per-symbol exposure ceiling when the caller supplies no `riskLimits`. */
export const DEFAULT_MAX_SYMBOL_CONCENTRATION_PCT = 25;

export interface HarnessDeps {
  configRepo: ConfigRepo;
  defsRepo: StrategyDefsRepo;
  proposalRepo: ProposalRepo;
  auditLog: AuditLog;
  portfolio: PortfolioSource;
  market: MarketData;
  ledgerRepo: LedgerRepo;
  bookRepo: BookRepo;
  sessions: SessionStatusSource;
  aggregates: AggregatesSource;
  clock: Clock;
  ids: IdGen;
  /** READ-ONLY broker handle passed through to every `StrategyContext`. */
  read: BrokerReadAdapter;
  logger: Logger;
  registry?: ReadonlyMap<string, Strategy> | undefined;
  /** IST `YYYY-MM-DD` exchange holidays, injected — never hard-coded. */
  holidays?: readonly string[] | undefined;
  riskLimits?: Partial<RiskLimits> | undefined;
}

export interface RunTickInput {
  uid: string;
  tick: Tick;
  deps: HarnessDeps;
}

export interface DroppedDraft {
  draft: ProposalDraft;
  reason: string;
}

export interface TickSummary {
  uid: string;
  tick: Tick;
  written: Proposal[];
  dropped: DroppedDraft[];
  /** Set when the whole tick was a no-op (docs/05 §5.5). */
  skippedReason?: string | undefined;
}

// ---------------------------------------------------------------------------
// Dedupe keys — docs/05 §5.4, keyed by (strategyId, symbol, side, intent)
// ---------------------------------------------------------------------------

export function draftDedupeKey(draft: ProposalDraft): string {
  return JSON.stringify([
    draft.strategyId,
    symbolKey(draft.order.symbol),
    draft.order.side,
    draft.intent,
  ]);
}

/**
 * The same key recovered from a persisted proposal. The intent is carried in
 * `rationale.signals.intent` (written by `makeDraft`); a proposal from an older
 * build without it falls back to its product, which still lets core's
 * coordinator catch the duplicate at its own `intentKey` stage.
 */
export function proposalDedupeKey(proposal: Proposal): string {
  const raw: unknown = proposal.rationale.signals['intent'];
  const intent = typeof raw === 'string' ? raw : proposal.order.product;
  return JSON.stringify([
    proposal.strategyId,
    symbolKey(proposal.order.symbol),
    proposal.order.side,
    intent,
  ]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ExposureSnapshot {
  grossInr: number;
  bySymbolInr: Record<string, number>;
  intradayRequiredInr: number;
}

export function summariseExposure(portfolio: PortfolioSnapshot): ExposureSnapshot {
  const bySymbolInr: Record<string, number> = {};
  let grossInr = 0;
  let intradayRequiredInr = 0;

  const add = (key: string, value: number): void => {
    if (!Number.isFinite(value) || value <= 0) return;
    bySymbolInr[key] = (bySymbolInr[key] ?? 0) + value;
    grossInr += value;
  };

  for (const h of portfolio.holdings) {
    add(symbolKey(h.symbol), Math.abs(h.quantity) * h.lastPrice);
  }
  for (const p of portfolio.positions) {
    const value = Math.abs(p.netQty) * p.lastPrice;
    add(symbolKey(p.symbol), value);
    if (p.product === 'INTRADAY') intradayRequiredInr += value;
  }

  return { grossInr, bySymbolInr, intradayRequiredInr };
}

function defaultRiskLimits(config: Config, books: readonly Book[]): RiskLimits {
  return {
    portfolioDailyLossStopInr: books.reduce((sum, b) => sum + b.risk.dailyLossStopInr, 0),
    maxGrossExposureInr: (config.totalManagedCapitalInr * (100 - config.reservePct)) / 100,
    maxSymbolConcentrationPct: DEFAULT_MAX_SYMBOL_CONCENTRATION_PCT,
  };
}

function openIntraday(ledger: readonly LedgerEntry[]): OpenIntradayPosition[] {
  return positionsByBook(ledger)
    .filter((p) => p.product === 'INTRADAY' && p.qty !== 0)
    .map((p) => ({ bookId: p.bookId, symbolKey: p.symbolKey, product: p.product, qty: p.qty }));
}

function guardrailReason(result: GuardrailResult): string {
  return `guardrail: ${failedChecks(result)
    .map((c) => `${c.name} (${c.detail})`)
    .join('; ')}`;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export async function runTick(input: RunTickInput): Promise<TickSummary> {
  const { uid, tick, deps } = input;
  const now = deps.clock.now();
  const nowIso = now.toISOString();
  const log = deps.logger.child({ uid, tick });

  const audit = async (
    type: AuditEventType,
    detail: Record<string, unknown>,
    refId?: string,
  ): Promise<void> => {
    const event: AuditEvent = {
      id: deps.ids.next('audit'),
      uid,
      ts: nowIso,
      actor: 'strategy-engine',
      type,
      detail,
    };
    if (refId !== undefined) event.refId = refId;
    await deps.auditLog.append(event);
  };

  const noop = async (reason: string, detail: Record<string, unknown>): Promise<TickSummary> => {
    log.warn({ reason, ...detail }, 'tick skipped');
    // `guardrail.blocked` is the closest existing AuditEvent type for "the engine
    // refused to act"; the precise reason is in `detail.reason`.
    await audit('guardrail.blocked', { stage: 'tick', tick, reason, ...detail });
    return { uid, tick, written: [], dropped: [], skippedReason: reason };
  };

  // -------------------------------------------------------------- 1. gates
  const config = await deps.configRepo.get(uid);
  if (config === undefined) return noop('config_missing', {});
  if (!config.tradingEnabled) return noop('trading_disabled', {});
  if (config.killSwitch) return noop('kill_switch', {});

  const session: SessionStatus | undefined = await deps.sessions.status(uid, config.activeBroker);
  if (session === undefined || !session.connected) {
    return noop('no_broker_session', { broker: config.activeBroker });
  }

  // ---------------------------------------------------------- 2. snapshots
  const [portfolio, books, ledger, openProposals, today, defs] = await Promise.all([
    deps.portfolio.snapshot(uid),
    deps.bookRepo.listBooks(uid),
    deps.ledgerRepo.listEntries(uid),
    deps.proposalRepo.listOpen(uid),
    deps.aggregates.today(uid, istDateKey(now)),
    deps.defsRepo.listEnabled(uid),
  ]);

  const bookById = new Map<string, Book>(books.map((b) => [b.id, b]));

  // ------------------------------------------------------- 3. select + run
  const selection = strategiesForTick(defs, tick, deps.registry ?? STRATEGY_REGISTRY);
  for (const def of selection.unresolved) {
    log.error({ strategyId: def.id }, 'no such strategy in this build');
    await audit('guardrail.blocked', {
      stage: 'strategy',
      reason: 'unknown_strategy',
      strategyId: def.id,
    });
  }

  const drafts: ProposalDraft[] = [];
  for (const { def, strategy } of selection.selected) {
    const outcome = await runOneStrategy({
      def,
      strategy,
      book: bookById.get(def.bookId),
      ctx: { uid, config, portfolio, ledger, now, tick },
      deps,
      log,
    });
    if (outcome.error !== undefined) {
      await audit('guardrail.blocked', {
        stage: 'strategy',
        reason: outcome.error.reason,
        strategyId: def.id,
        bookId: def.bookId,
        message: outcome.error.message,
      });
      continue;
    }
    drafts.push(...outcome.drafts);
  }

  if (drafts.length === 0) {
    log.info({ strategies: selection.selected.length }, 'tick produced no drafts');
    return { uid, tick, written: [], dropped: [] };
  }

  // ------------------------------------------- 4. drafts → candidate docs
  const ttlExpiresAt = new Date(
    now.getTime() + config.guardrails.proposalTtlSeconds * 1000,
  ).toISOString();

  const byId = new Map<string, ProposalDraft>();
  const candidates: Proposal[] = drafts.map((draft) => {
    const id = deps.ids.next('proposal');
    byId.set(id, draft);
    return {
      id,
      uid,
      createdAt: nowIso,
      createdBy: 'strategy-engine' as const,
      strategyId: draft.strategyId,
      targetBroker: config.activeBroker,
      bookId: draft.bookId,
      horizon: draft.horizon,
      status: 'pending' as const,
      order: draft.order,
      rationale: draft.rationale,
      marketContext: draft.marketContext,
      guardrailPrecheck: { passed: false, checks: [] },
      ttlExpiresAt,
    };
  });

  const dropped: DroppedDraft[] = [];
  const drop = async (
    proposalId: string,
    reason: string,
    auditType: AuditEventType,
    stage: string,
  ): Promise<void> => {
    const draft = byId.get(proposalId);
    if (draft === undefined) return;
    dropped.push({ draft, reason });
    log.info({ proposalId, stage, reason }, 'draft dropped');
    await audit(
      auditType,
      {
        stage,
        reason,
        strategyId: draft.strategyId,
        bookId: draft.bookId,
        symbol: symbolKey(draft.order.symbol),
        side: draft.order.side,
        intent: draft.intent,
      },
      proposalId,
    );
  };

  // ----------------------------------------------------- 5. coordinator
  // `books` is deliberately omitted: the virtual budget is checked in stage 8,
  // *after* the guardrail pre-filter, so a draft the guardrails reject does not
  // consume its book's sleeve. The coordinator still arbitrates real margin by
  // precedence, which is the part only it can do.
  const coordinated = runCoordinator({
    proposals: candidates,
    ledger,
    config,
    availableMarginInr: portfolio.funds.availableMargin,
    livePending: openProposals,
    now,
  });

  for (const rejection of coordinated.blocked) {
    await drop(rejection.proposal.id, rejection.reason, 'coordinator.blocked', 'coordinator');
  }
  for (const rejection of coordinated.deferred) {
    await drop(rejection.proposal.id, rejection.reason, 'coordinator.deferred', 'coordinator');
  }
  for (const netting of coordinated.netted) {
    for (const mergedId of netting.mergedFrom) {
      await drop(
        mergedId,
        `${netting.reason} (folded into ${netting.proposal.id})`,
        'coordinator.netted',
        'coordinator',
      );
    }
  }

  // ------------------------------------------------- 6. portfolio risk
  const exposure = summariseExposure(portfolio);
  const risk = assessPortfolioRisk({
    config,
    books,
    limits: { ...defaultRiskLimits(config, books), ...deps.riskLimits },
    bookDayPnlInr: Object.fromEntries(books.map((b) => [b.id, b.realizedPnlInr])),
    portfolioDayPnlInr: books.reduce((sum, b) => sum + b.realizedPnlInr, 0),
    grossExposureInr: exposure.grossInr,
    exposureBySymbolInr: exposure.bySymbolInr,
    availableMarginInr: portfolio.funds.availableMargin,
    requiredIntradayMarginInr: exposure.intradayRequiredInr,
    openIntradayPositions: openIntraday(ledger),
    now,
  });
  if (!risk.ok) {
    log.warn({ checks: failedChecks({ passed: risk.ok, checks: risk.checks }) }, 'risk tripped');
  }

  const afterRisk: Proposal[] = [];
  for (const proposal of coordinated.accepted) {
    const isExit = canExit(ledger, proposal.bookId, proposal.order).ok;
    const reason = riskVeto(risk, proposal, isExit);
    if (reason !== undefined) {
      await drop(proposal.id, reason, 'guardrail.blocked', 'risk');
      continue;
    }
    afterRisk.push(proposal);
  }

  // ------------------------------------- 7. guardrail pre-filter + write
  const clamped = clampConfigToCeilings(config);
  const quotes = await deps.market.quotes(uniqueSymbols(afterRisk));
  const liveKeys = new Set(openProposals.map(proposalDedupeKey));
  const writtenKeys = new Set<string>();
  const budgets = new Map<string, Book>(books.map((b) => [b.id, { ...b }]));
  const written: Proposal[] = [];

  for (const proposal of afterRisk) {
    const draft = byId.get(proposal.id);
    if (draft === undefined) continue;

    const key = symbolKey(proposal.order.symbol);
    const quote: Quote | undefined = quotes.get(key);
    const instrument = await deps.market.instrument(proposal.order.symbol);
    const dedupeKey = draftDedupeKey(draft);

    const precheck = runGuardrails({
      config: clamped,
      order: proposal.order,
      proposal: { status: 'pending', ttlExpiresAt },
      quote,
      funds: portfolio.funds,
      instrument,
      session,
      today,
      idempotency: { key: dedupeKey, used: liveKeys.has(dedupeKey) },
      now,
      calendar: { holidays: deps.holidays ?? [] },
    });
    if (!precheck.passed) {
      await drop(proposal.id, guardrailReason(precheck), 'guardrail.blocked', 'guardrail');
      continue;
    }

    // Virtual book budget (docs/10 §10.3) — on top of the real funds guardrail.
    const isExit = canExit(ledger, proposal.bookId, proposal.order).ok;
    if (!isExit) {
      const book = budgets.get(proposal.bookId);
      const notional =
        estimateOrderNotionalInr(proposal.order, proposal.marketContext.ltpAtProposal) ?? 0;
      if (book === undefined || !canDeploy(book, notional)) {
        await drop(
          proposal.id,
          `book_budget: book '${proposal.bookId}' cannot deploy ₹${notional}`,
          'guardrail.blocked',
          'book_budget',
        );
        continue;
      }
      // Per-position cap (docs/10 §10.3) — the coordinator does not check this.
      if (notional > book.risk.maxPositionValueInr) {
        await drop(
          proposal.id,
          `book_position_cap: ₹${notional} exceeds book '${proposal.bookId}' ` +
            `maxPositionValueInr ₹${book.risk.maxPositionValueInr}`,
          'guardrail.blocked',
          'book_budget',
        );
        continue;
      }
      budgets.set(proposal.bookId, { ...book, deployedInr: book.deployedInr + notional });
    }

    // Dedupe within this tick (docs/05 §5.4). A duplicate of an *already open*
    // proposal was caught above: the guardrail suite receives this same key as
    // its `idempotency` input and fails `idempotencyUnused`.
    if (writtenKeys.has(dedupeKey)) {
      await drop(
        proposal.id,
        `dedupe: this tick already wrote a proposal for ${dedupeKey}`,
        'guardrail.blocked',
        'dedupe',
      );
      continue;
    }

    let record: Proposal;
    try {
      record = ProposalSchema.parse({ ...proposal, guardrailPrecheck: precheck });
    } catch (err) {
      await drop(proposal.id, `schema: ${errorMessage(err)}`, 'guardrail.blocked', 'schema');
      continue;
    }

    await deps.proposalRepo.create(record);
    writtenKeys.add(dedupeKey);
    written.push(record);
    await audit(
      'proposal.created',
      {
        strategyId: record.strategyId,
        bookId: record.bookId,
        horizon: record.horizon,
        symbol: key,
        side: record.order.side,
        quantity: record.order.quantity,
        intent: draft.intent,
        estimatedValueInr: record.marketContext.estimatedValueInr,
        ttlExpiresAt: record.ttlExpiresAt,
      },
      record.id,
    );
    log.info({ proposalId: record.id, strategyId: record.strategyId }, 'proposal written');
  }

  return { uid, tick, written, dropped };
}

// ---------------------------------------------------------------------------
// Stage helpers
// ---------------------------------------------------------------------------

function uniqueSymbols(proposals: readonly Proposal[]): CanonicalSymbol[] {
  const seen = new Map<string, CanonicalSymbol>();
  for (const p of proposals) seen.set(symbolKey(p.order.symbol), p.order.symbol);
  return [...seen.values()];
}

type RiskAssessment = ReturnType<typeof assessPortfolioRisk>;

/** Why the risk manager refuses this proposal, or `undefined` to let it pass. */
export function riskVeto(
  risk: RiskAssessment,
  proposal: Proposal,
  isExit: boolean,
): string | undefined {
  if (risk.tripKillSwitch) {
    return 'risk: portfolio daily-loss stop breached — kill switch';
  }
  if (risk.pauseBooks.includes(proposal.bookId)) {
    return `risk: book '${proposal.bookId}' is paused for the day (daily-loss stop)`;
  }
  if (isExit) return undefined;
  if (risk.blockNewExposure) {
    return 'risk: gross exposure cap reached — no new exposure';
  }
  const key = symbolKey(proposal.order.symbol);
  if (risk.blockedSymbols.includes(key)) {
    return `risk: ${key} is at the concentration cap`;
  }
  if (risk.throttleBooks.includes(proposal.bookId)) {
    return `risk: margin headroom thin — intraday book '${proposal.bookId}' throttled`;
  }
  return undefined;
}

interface StrategyRunOutcome {
  drafts: ProposalDraft[];
  error?: { reason: string; message: string } | undefined;
}

async function runOneStrategy(args: {
  def: StrategyDef;
  strategy: Strategy;
  book: Book | undefined;
  ctx: {
    uid: string;
    config: Config;
    portfolio: PortfolioSnapshot;
    ledger: readonly LedgerEntry[];
    now: Date;
    tick: Tick;
  };
  deps: HarnessDeps;
  log: Logger;
}): Promise<StrategyRunOutcome> {
  const { def, strategy, book, ctx, deps, log } = args;

  if (book === undefined) {
    return { drafts: [], error: { reason: 'unknown_book', message: `no book '${def.bookId}'` } };
  }
  if (!book.enabled) {
    return {
      drafts: [],
      error: { reason: 'book_disabled', message: `book '${book.id}' disabled` },
    };
  }
  if (def.horizon !== strategy.horizon) {
    return {
      drafts: [],
      error: {
        reason: 'horizon_mismatch',
        message: `def says '${def.horizon}', '${strategy.id}' is '${strategy.horizon}'`,
      },
    };
  }

  const logger = log.child({ strategyId: def.id, bookId: book.id });
  try {
    const result = await strategy.run({
      uid: ctx.uid,
      config: ctx.config,
      read: deps.read,
      portfolio: ctx.portfolio,
      now: ctx.now,
      logger,
      tick: ctx.tick,
      def,
      params: def.params,
      book,
      ledger: ctx.ledger,
      market: deps.market,
    });
    if (result.notes !== undefined) logger.debug({ notes: result.notes }, 'strategy notes');
    return { drafts: result.proposals };
  } catch (err) {
    // One strategy failing must never abort the others (docs/05 §5.4).
    logger.error({ err: errorMessage(err) }, 'strategy threw');
    return { drafts: [], error: { reason: 'strategy_error', message: errorMessage(err) } };
  }
}
