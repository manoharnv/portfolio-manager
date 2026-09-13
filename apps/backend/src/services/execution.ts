/**
 * The critical path — `POST /v1/proposals/:id/execute`, docs/04 §4.4.
 *
 * Every box in that flowchart is a branch here, in this order, with no way past
 * any of them:
 *
 *   owner check → idempotency lock → proposal state/TTL → kill switch /
 *   tradingEnabled → market hours → session validity → FULL guardrail suite on
 *   LIVE quote + funds + instrument → clientSeenLtp collar → book budget →
 *   ledger `canExit` → placeOrder.
 *
 * Two invariants are worth stating out loud:
 *   - **Missing evidence is a refusal.** No quote, no funds, no instrument, no
 *     config, no book ⇒ nothing is placed (docs/00 §0.7.1).
 *   - **A place is never blindly retried.** A broker error ends the attempt,
 *     marks the idempotency key `failed`, and surfaces (docs/04 §4.10).
 */

import {
  BrokerError,
  applyDeployment,
  canDeploy,
  canExit,
  clampConfigToCeilings,
  estimateOrderNotionalInr,
  failedChecks as failingChecks,
  isMarketOpen,
  istDateKey,
  ownedQty,
  runGuardrails,
  symbolKey,
  assertTransition,
} from '@pm/core';
import type {
  Broker,
  BrokerErrorKind,
  Funds,
  GuardrailCheck,
  InstrumentRef,
  NormalizedOrder,
  OrderStatusCode,
  Quote,
  SessionStatus,
} from '@pm/core';
import type { Config, OrderRecord, ProposalStatus } from '@pm/core';
import type { BackendEnvironment } from '../config.js';
import type { Logger } from '../logger.js';
import { sessionRefusal } from '../session-status.js';
import { SessionUnavailableError } from '../ports/index.js';
import { isClosingOrder, reservationInr } from './reservations.js';
import type {
  BookRepo,
  BrokerContext,
  BrokerGateway,
  Clock,
  ConfigRepo,
  DailyAggregates,
  IdGenerator,
  IdempotencyStore,
  LedgerRepo,
  OrderRepo,
  ProposalRepo,
  SessionStore,
} from '../ports/index.js';
import type { AuditWriter } from './audit.js';

// ---------------------------------------------------------------------------
// Result shape (docs/04 §4.3)
// ---------------------------------------------------------------------------

export type ExecutionFailureReason =
  | 'UNAUTHORIZED'
  | 'IDEMPOTENT_REPLAY'
  | 'STALE_PROPOSAL'
  | 'HALTED'
  | 'MARKET_CLOSED'
  | 'SESSION_INVALID'
  | 'GUARDRAIL_BLOCKED'
  | 'PRICE_MOVED'
  | 'BUDGET_EXCEEDED'
  | 'OWNERSHIP'
  | 'BROKER_ERROR';

export interface ExecutionSuccess {
  ok: true;
  orderId: string;
  brokerOrderId: string;
  status: OrderStatusCode;
}

export interface ExecutionFailure {
  ok: false;
  reason: ExecutionFailureReason;
  detail: string;
  /** Present for GUARDRAIL_BLOCKED — the docs/04 §4.3 error body. */
  failedChecks?: GuardrailCheck[] | undefined;
  /** Present for BROKER_ERROR, so the HTTP layer can map AUTH_EXPIRED → 409. */
  brokerErrorKind?: BrokerErrorKind | undefined;
}

export type ExecutionResult = ExecutionSuccess | ExecutionFailure;

export interface ExecuteProposalInput {
  /** The *authenticated* caller, from the verified Firebase ID token. */
  uid: string;
  proposalId: string;
  idempotencyKey: string;
  /** LTP the human saw when approving — the staleness guard (docs/04 §4.4). */
  clientSeenLtp?: number | undefined;
  /** Optional attestation that the device biometric passed. */
  biometricAssertion?: string | undefined;
}

export interface ExecutionDeps {
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  proposals: ProposalRepo;
  orders: OrderRepo;
  idempotency: IdempotencyStore;
  configs: ConfigRepo;
  books: BookRepo;
  ledger: LedgerRepo;
  daily: DailyAggregates;
  broker: BrokerGateway;
  sessions: SessionStore;
  audit: AuditWriter;
  environment: BackendEnvironment;
  /** Recorded as `orders.ipUsed` (docs/03 §3.4). */
  staticIp: string;
  marketHolidays: readonly string[];
}

export interface ExecutionService {
  executeProposal(input: ExecuteProposalInput): Promise<ExecutionResult>;
}

/** Everything the guardrail suite needs, fetched live at execution time. */
interface LiveData {
  quote: Quote | undefined;
  funds: Funds | undefined;
  instrument: InstrumentRef | undefined;
}

function isSuccessShape(value: unknown): value is ExecutionSuccess {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['ok'] === true && typeof v['orderId'] === 'string' && typeof v['brokerOrderId'] === 'string'
  );
}

export function createExecutionService(deps: ExecutionDeps): ExecutionService {
  return { executeProposal: (input) => execute(deps, input) };
}

/**
 * One long, linear gauntlet on purpose: docs/04 §4.4 is an ordered flowchart and
 * the safety argument *is* the ordering. Splitting it into helpers would hide
 * which check precedes which.
 */
async function execute(deps: ExecutionDeps, input: ExecuteProposalInput): Promise<ExecutionResult> {
  const { uid, proposalId, idempotencyKey } = input;
  const now = deps.clock.now();
  const log = deps.logger.child({ uid, proposalId, idempotencyKey });

  /** Refusal *before* the lock exists — audited, but no key is burned. */
  const refuseUnlocked = async (
    reason: ExecutionFailureReason,
    detail: string,
  ): Promise<ExecutionFailure> => {
    await deps.audit.record({
      uid,
      type: 'guardrail.blocked',
      refId: proposalId,
      detail: { reason, detail, idempotencyKey },
    });
    log.warn({ reason, detail }, 'execution refused');
    return { ok: false, reason, detail };
  };

  // --- B. proposal + owner ------------------------------------------------
  const initial = await deps.proposals.get(proposalId);
  if (initial === undefined) {
    return refuseUnlocked('STALE_PROPOSAL', `proposal '${proposalId}' not found`);
  }
  if (initial.uid !== uid) {
    return refuseUnlocked('UNAUTHORIZED', 'caller is not the owner of this proposal');
  }

  // --- C/D. idempotency lock (transactional create-if-absent) -------------
  const lock = await deps.idempotency.acquire(idempotencyKey, proposalId, now);
  if (lock !== 'acquired') {
    if (lock.proposalId !== proposalId) {
      return refuseUnlocked(
        'IDEMPOTENT_REPLAY',
        `idempotency key already used for proposal '${lock.proposalId}'`,
      );
    }
    if (lock.status === 'done' && isSuccessShape(lock.result)) {
      log.info({ orderId: lock.orderId }, 'idempotent replay — returning prior result');
      return lock.result;
    }
    return refuseUnlocked(
      'IDEMPOTENT_REPLAY',
      `idempotency key '${idempotencyKey}' is already ${lock.status}`,
    );
  }

  /** Refusal *after* the lock — the key is burned so it can never place. */
  const refuse = async (
    reason: ExecutionFailureReason,
    detail: string,
    extra?: Partial<ExecutionFailure>,
  ): Promise<ExecutionFailure> => {
    const failure: ExecutionFailure = { ok: false, reason, detail, ...extra };
    await deps.idempotency.fail(idempotencyKey, failure);
    log.warn({ reason, detail }, 'execution refused');
    return failure;
  };

  const auditedRefusal = async (
    reason: ExecutionFailureReason,
    detail: string,
    extra?: Partial<ExecutionFailure>,
    auditDetail?: Record<string, unknown>,
  ): Promise<ExecutionFailure> => {
    await deps.audit.record({
      uid,
      type: 'guardrail.blocked',
      refId: proposalId,
      detail: { reason, detail, idempotencyKey, ...auditDetail },
    });
    return refuse(reason, detail, extra);
  };

  // --- E. proposal state + TTL -------------------------------------------
  const proposal = (await deps.proposals.get(proposalId)) ?? initial;
  const executable: ProposalStatus[] = ['pending', 'approved'];
  if (!executable.includes(proposal.status)) {
    return auditedRefusal(
      'STALE_PROPOSAL',
      `proposal status '${proposal.status}' is not executable`,
    );
  }
  const ttlMs = Date.parse(proposal.ttlExpiresAt);
  if (Number.isNaN(ttlMs) || now.getTime() >= ttlMs) {
    if (proposal.status === 'pending') {
      await deps.proposals.transition(proposalId, 'pending', 'expired');
    }
    await deps.audit.record({
      uid,
      type: 'proposal.expired',
      refId: proposalId,
      detail: { ttlExpiresAt: proposal.ttlExpiresAt, at: now.toISOString() },
    });
    return refuse('STALE_PROPOSAL', `proposal expired at ${proposal.ttlExpiresAt}`);
  }

  // --- F. config, kill switch, trading enabled (fail closed) --------------
  const stored = await deps.configs.get(uid);
  if (stored === undefined) {
    return auditedRefusal('HALTED', 'no config for this user — refusing to trade');
  }
  // Code ceilings beat config, always (docs/07 §7.5).
  const config: Config = clampConfigToCeilings(stored);
  if (config.killSwitch) {
    return auditedRefusal('HALTED', 'kill switch is ON — all orders refused');
  }
  if (!config.tradingEnabled) {
    return auditedRefusal('HALTED', 'tradingEnabled is false');
  }
  if (config.guardrails.requireBiometric && (input.biometricAssertion ?? '') === '') {
    return auditedRefusal('UNAUTHORIZED', 'config requires a biometric assertion');
  }

  // --- G. market hours ----------------------------------------------------
  if (!isMarketOpen(now, { holidays: [...deps.marketHolidays] })) {
    return auditedRefusal('MARKET_CLOSED', `market is closed at ${now.toISOString()}`);
  }

  // --- H. broker session --------------------------------------------------
  let ctx: BrokerContext;
  try {
    ctx = await deps.broker.forUser(uid);
  } catch (err) {
    const detail =
      err instanceof SessionUnavailableError ? err.message : `broker unavailable: ${String(err)}`;
    await deps.audit.record({
      uid,
      type: 'session.expired',
      refId: proposalId,
      detail: { reason: 'SESSION_INVALID', detail },
    });
    return refuse('SESSION_INVALID', detail);
  }

  const session: SessionStatus = ctx.session;
  const sessionProblem = sessionRefusal(session, config.activeBroker, now);
  if (sessionProblem !== undefined) {
    await deps.audit.record({
      uid,
      type: 'session.expired',
      refId: proposalId,
      detail: { reason: 'SESSION_INVALID', detail: sessionProblem },
    });
    return refuse('SESSION_INVALID', sessionProblem);
  }

  // --- live market data (any failure here refuses; nothing is placed) -----
  const order = proposal.order;
  let live: LiveData;
  try {
    live = await fetchLive(ctx, order);
  } catch (err) {
    return handleBrokerFailure(deps, {
      uid,
      proposalId,
      idempotencyKey,
      err,
      phase: 'market-data',
      broker: ctx.broker,
      refuse,
    });
  }

  const today = await deps.daily.today(uid, istDateKey(now));

  // --- pending → approved (the human's tap) -------------------------------
  // docs/03 §3.3 only allows `approved → blocked`, so the approval must be
  // recorded before the guardrail verdict can be written back.
  if (proposal.status === 'pending') {
    assertTransition('pending', 'approved');
    const moved = await deps.proposals.transition(proposalId, 'pending', 'approved', {
      decidedBy: uid,
      decidedAt: now.toISOString(),
    });
    if (!moved.ok) {
      return auditedRefusal(
        'STALE_PROPOSAL',
        moved.reason === 'not-found'
          ? 'proposal disappeared mid-execution'
          : `proposal moved to '${moved.current}' concurrently`,
      );
    }
    await deps.audit.record({
      uid,
      type: 'proposal.approved',
      refId: proposalId,
      detail: { idempotencyKey, clientSeenLtp: input.clientSeenLtp ?? null },
    });
  }

  // --- I. the FULL guardrail suite, on LIVE data --------------------------
  const verdict = runGuardrails({
    config,
    order,
    proposal: { status: 'approved', ttlExpiresAt: proposal.ttlExpiresAt },
    quote: live.quote,
    funds: live.funds,
    instrument: live.instrument,
    session,
    today,
    idempotency: { key: idempotencyKey, used: false },
    now,
    calendar: { holidays: [...deps.marketHolidays] },
  });

  if (!verdict.passed) {
    const checks = failingChecks(verdict);
    await deps.proposals.transition(proposalId, 'approved', 'blocked', {
      failureReason: checks.map((c) => c.name).join(','),
    });
    await deps.audit.record({
      uid,
      type: 'guardrail.blocked',
      refId: proposalId,
      detail: { reason: 'GUARDRAIL_BLOCKED', failedChecks: checks, idempotencyKey },
    });
    return refuse('GUARDRAIL_BLOCKED', `${checks.length} guardrail check(s) failed`, {
      failedChecks: checks,
    });
  }

  // --- J. clientSeenLtp collar (staleness guard) --------------------------
  // The suite above proved a usable live quote exists; this compares it with
  // what the human actually looked at.
  const ltp = live.quote?.ltp ?? 0;
  const staleness = stalenessRefusal(input.clientSeenLtp, ltp, config.guardrails.priceCollarPct);
  if (staleness !== undefined) {
    await deps.audit.record({
      uid,
      type: 'guardrail.blocked',
      refId: proposalId,
      detail: {
        reason: 'PRICE_MOVED',
        detail: staleness,
        clientSeenLtp: input.clientSeenLtp ?? null,
        liveLtp: ltp,
      },
    });
    // Deliberately NOT terminal: the app re-confirms at the new price.
    return refuse('PRICE_MOVED', staleness);
  }

  // --- book budget (§10.3) + ledger canExit (§10.4) -----------------------
  // `notional` is the conservative valuation the guardrails used (it may use the
  // live LTP); `reserved` is what the sleeve actually commits until the order
  // fills or dies. They differ only for MARKET/SL-M orders.
  const notional = estimateOrderNotionalInr(order, ltp) ?? 0;
  const reserved = reservationInr(order, proposal.marketContext.ltpAtProposal) ?? 0;
  const book = await deps.books.get(uid, proposal.bookId);
  if (book === undefined) {
    return blockAndRefuse(
      deps,
      { uid, proposalId, idempotencyKey, refuse },
      'BUDGET_EXCEEDED',
      `book '${proposal.bookId}' not found`,
    );
  }

  // The ledger holds FILLED quantity only, so `canExit` can never be satisfied
  // by an order that is merely in flight.
  const entries = await deps.ledger.list(uid);
  const key = symbolKey(order.symbol);
  const owned = ownedQty(entries, proposal.bookId, key, order.product);
  const closing = isClosingOrder(order, owned);

  if (closing) {
    const exit = canExit(entries, proposal.bookId, order);
    if (!exit.ok) {
      return blockAndRefuse(
        deps,
        { uid, proposalId, idempotencyKey, refuse },
        'OWNERSHIP',
        exit.reason,
      );
    }
  } else if (!canDeploy(book, reserved)) {
    return blockAndRefuse(
      deps,
      { uid, proposalId, idempotencyKey, refuse },
      'BUDGET_EXCEEDED',
      `book '${book.id}' cannot reserve ₹${reserved} ` +
        `(allocated ₹${book.allocatedCapitalInr}, deployed ₹${book.deployedInr})`,
    );
  }

  // --- K. approved → placing ---------------------------------------------
  assertTransition('approved', 'placing');
  const placing = await deps.proposals.transition(proposalId, 'approved', 'placing');
  if (!placing.ok) {
    return auditedRefusal(
      'STALE_PROPOSAL',
      placing.reason === 'not-found'
        ? 'proposal disappeared mid-execution'
        : `proposal moved to '${placing.current}' concurrently`,
    );
  }

  // --- L. place from the static IP ---------------------------------------
  const orderId = deps.ids.orderId();
  let ack;
  try {
    ack = await ctx.adapter.placeOrder(order, idempotencyKey);
  } catch (err) {
    // M: never retried — a second place could double-fire (docs/04 §4.10).
    await deps.proposals.transition(proposalId, 'placing', 'failed', {
      failureReason: err instanceof Error ? err.message : String(err),
    });
    return handleBrokerFailure(deps, {
      uid,
      proposalId,
      idempotencyKey,
      err,
      phase: 'place',
      broker: ctx.broker,
      refuse,
    });
  }

  // --- N. persist the order and reserve the book's capital -----------------
  const nowIso = now.toISOString();
  const record: OrderRecord = {
    id: orderId,
    uid,
    proposalId,
    broker: ctx.broker,
    brokerOrderId: ack.brokerOrderId,
    idempotencyKey,
    bookId: proposal.bookId,
    horizon: proposal.horizon,
    order,
    status: ack.status,
    filledQty: 0,
    avgFillPrice: null,
    rejectionReason: null,
    approvedBy: uid,
    approvedAt: proposal.decidedAt ?? nowIso,
    submittedAt: nowIso,
    ipUsed: deps.staticIp,
    environment: deps.environment,
    brokerRawAck: ack.raw,
    updatedAt: nowIso,
  };
  await deps.orders.create(record);

  // NO ledger row here. The ledger records what the book *owns*, and nothing is
  // owned until something fills — `reconcile` writes the row from the fill.
  // What a submitted order does take is a *reservation* against the sleeve, so
  // two proposals cannot spend the same rupees while both are in flight. An
  // exit reserves nothing: the position it unwinds is already counted at cost.
  if (!closing) {
    const deployed = applyDeployment(book, reserved);
    await deps.books.patch(uid, book.id, { deployedInr: deployed.deployedInr });
  }

  await deps.proposals.transition(proposalId, 'placing', 'placed', { orderId });

  const success: ExecutionSuccess = {
    ok: true,
    orderId,
    brokerOrderId: ack.brokerOrderId,
    status: ack.status,
  };
  await deps.idempotency.complete(idempotencyKey, orderId, success);
  await deps.audit.record({
    uid,
    type: 'order.submitted',
    refId: orderId,
    detail: {
      proposalId,
      brokerOrderId: ack.brokerOrderId,
      broker: ctx.broker,
      bookId: proposal.bookId,
      horizon: proposal.horizon,
      notionalInr: notional,
      reservedInr: closing ? 0 : reserved,
      environment: deps.environment,
      ipUsed: deps.staticIp,
    },
  });
  log.info({ orderId, brokerOrderId: ack.brokerOrderId }, 'order submitted');
  return success;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchLive(ctx: BrokerContext, order: NormalizedOrder): Promise<LiveData> {
  const [quotes, funds, instrument] = await Promise.all([
    ctx.adapter.getQuote([order.symbol]),
    ctx.adapter.getFunds(),
    ctx.adapter.resolveInstrument(order.symbol),
  ]);
  return { quote: quotes[0], funds, instrument };
}

/** `undefined` when the human's price is still good enough to trade on. */
export function stalenessRefusal(
  clientSeenLtp: number | undefined,
  liveLtp: number,
  collarPct: number,
): string | undefined {
  if (clientSeenLtp === undefined || !Number.isFinite(clientSeenLtp) || clientSeenLtp <= 0) {
    return 'no clientSeenLtp supplied — cannot verify the price the human approved';
  }
  if (!Number.isFinite(liveLtp) || liveLtp <= 0) return 'no usable live LTP to compare against';
  const deviationPct = (Math.abs(liveLtp - clientSeenLtp) / liveLtp) * 100;
  if (deviationPct <= collarPct) return undefined;
  return (
    `price moved ${deviationPct.toFixed(2)}% since approval ` +
    `(you saw ₹${clientSeenLtp}, live ₹${liveLtp}, collar ±${collarPct}%)`
  );
}

interface RefusalCtx {
  uid: string;
  proposalId: string;
  idempotencyKey: string;
  refuse: (
    reason: ExecutionFailureReason,
    detail: string,
    extra?: Partial<ExecutionFailure>,
  ) => Promise<ExecutionFailure>;
}

/** A guardrail-class refusal that also moves the proposal to `blocked`. */
async function blockAndRefuse(
  deps: ExecutionDeps,
  ctx: RefusalCtx,
  reason: ExecutionFailureReason,
  detail: string,
): Promise<ExecutionFailure> {
  await deps.proposals.transition(ctx.proposalId, 'approved', 'blocked', {
    failureReason: reason,
  });
  await deps.audit.record({
    uid: ctx.uid,
    type: 'guardrail.blocked',
    refId: ctx.proposalId,
    detail: { reason, detail, idempotencyKey: ctx.idempotencyKey },
  });
  return ctx.refuse(reason, detail);
}

interface BrokerFailureCtx extends RefusalCtx {
  err: unknown;
  phase: 'market-data' | 'place';
  broker: Broker;
}

/**
 * Map a thrown broker error onto a refusal. `AUTH_EXPIRED` becomes
 * `SESSION_INVALID` ("needs re-login"); `IP_NOT_WHITELISTED` additionally flips
 * `staticIpOk` off so every later attempt fails the session guardrail until a
 * human fixes the whitelist (docs/04 §4.10).
 */
async function handleBrokerFailure(
  deps: ExecutionDeps,
  ctx: BrokerFailureCtx,
): Promise<ExecutionFailure> {
  const { err } = ctx;
  const kind: BrokerErrorKind | undefined = err instanceof BrokerError ? err.kind : undefined;
  const message = err instanceof Error ? err.message : String(err);

  if (kind === 'IP_NOT_WHITELISTED') {
    const existing = await deps.sessions.get(ctx.uid, ctx.broker);
    if (existing !== undefined) {
      await deps.sessions.set(ctx.uid, { ...existing, staticIpOk: false });
    }
    await deps.audit.record({
      uid: ctx.uid,
      type: 'ip.changed',
      refId: ctx.proposalId,
      detail: { reason: 'IP_NOT_WHITELISTED', detail: message, staticIp: deps.staticIp },
    });
  }

  if (kind === 'AUTH_EXPIRED') {
    await deps.audit.record({
      uid: ctx.uid,
      type: 'session.expired',
      refId: ctx.proposalId,
      detail: { reason: 'SESSION_INVALID', detail: message, phase: ctx.phase },
    });
    return ctx.refuse('SESSION_INVALID', message, { brokerErrorKind: kind });
  }

  await deps.audit.record({
    uid: ctx.uid,
    type: 'order.failed',
    refId: ctx.proposalId,
    detail: {
      reason: 'BROKER_ERROR',
      kind: kind ?? 'UNKNOWN',
      detail: message,
      phase: ctx.phase,
      idempotencyKey: ctx.idempotencyKey,
    },
  });
  return ctx.refuse('BROKER_ERROR', message, { brokerErrorKind: kind ?? 'UNKNOWN' });
}
