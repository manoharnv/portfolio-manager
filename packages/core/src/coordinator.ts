/**
 * The coordinator — docs/10-multi-strategy.md §10.5.
 *
 * Runs across the *combined* set of candidate proposals from every book before
 * anything reaches the human, and decides what may proceed:
 *
 *   duplicate suppression → product discipline → wash prevention
 *     → optional same-side netting → precedence + capital arbitration
 *
 * Pure: no clock, no I/O. `now` is supplied by the caller. Every decision carries
 * an audit-ready reason string (`coordinator.blocked` / `.netted` / `.deferred`).
 */

import { symbolKey } from './domain.js';
import { canDeploy } from './books.js';
import { estimateOrderNotionalInr, estimateRequiredMarginInr } from './guardrails.js';
import { canExit, heldProducts, ownedQty } from './ledger.js';
import type {
  Book,
  Config,
  CoordinatorConfig,
  CoordinatorResult,
  Horizon,
  LedgerEntry,
  Proposal,
} from './schemas.js';
import { HORIZONS } from './schemas.js';

/** Applied when `config.coordinator` is absent. Netting is OFF by default. */
export const COORDINATOR_DEFAULTS: CoordinatorConfig = {
  nettingEnabled: false,
  washWindowSeconds: 60,
  /** Investment books outrank intraday books (docs/10 §10.5). */
  precedence: [...HORIZONS],
};

export interface CoordinatorInput {
  proposals: readonly Proposal[];
  /** Full position-attribution ledger (docs/10 §10.4). */
  ledger: readonly LedgerEntry[];
  config: Config;
  /** Real broker margin available right now — the hard constraint books share. */
  availableMarginInr: number;
  /** Book definitions, for the virtual budget check. Omit to skip it. */
  books?: readonly Book[] | undefined;
  /** Proposals already live in the inbox, for duplicate + wash detection. */
  livePending?: readonly Proposal[] | undefined;
  now: Date | string;
}

export interface CoordinatorRejection {
  proposal: Proposal;
  reason: string;
}

export interface CoordinatorNetting {
  /** The merged proposal (also present in `accepted`). */
  proposal: Proposal;
  /** Ids of the proposals folded into it; those appear nowhere else. */
  mergedFrom: string[];
  reason: string;
}

export interface CoordinatorOutput {
  accepted: Proposal[];
  blocked: CoordinatorRejection[];
  deferred: CoordinatorRejection[];
  netted: CoordinatorNetting[];
}

function resolveNow(now: Date | string): Date {
  const d = typeof now === 'string' ? new Date(now) : now;
  if (Number.isNaN(d.getTime())) throw new TypeError(`Invalid 'now': ${JSON.stringify(now)}`);
  return d;
}

/**
 * Dedupe key — docs/05 §5.4 keyed by (strategyId, symbol, side, intent); the book
 * and product complete the "intent" for a multi-book world.
 */
export function intentKey(p: Proposal): string {
  return JSON.stringify([
    p.strategyId,
    p.bookId,
    symbolKey(p.order.symbol),
    p.order.side,
    p.order.product,
  ]);
}

function nettingKey(p: Proposal): string {
  return JSON.stringify([
    symbolKey(p.order.symbol),
    p.order.side,
    p.order.product,
    p.order.orderType,
    p.order.validity,
    p.order.limitPrice ?? null,
    p.order.triggerPrice ?? null,
  ]);
}

function precedenceIndex(precedence: readonly Horizon[], horizon: Horizon): number {
  const i = precedence.indexOf(horizon);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

function createdAtMs(p: Proposal): number {
  const t = Date.parse(p.createdAt);
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

function proposalPrice(p: Proposal): number {
  return p.order.limitPrice ?? p.marketContext.ltpAtProposal;
}

function notionalOf(p: Proposal): number {
  return estimateOrderNotionalInr(p.order, p.marketContext.ltpAtProposal) ?? 0;
}

function stamp(p: Proposal, result: CoordinatorResult): Proposal {
  return { ...p, coordinator: result };
}

/**
 * Coordinate a batch. Proposals are returned stamped with their `coordinator`
 * block so the caller can persist the decision verbatim.
 */
export function runCoordinator(input: CoordinatorInput): CoordinatorOutput {
  const cfg: CoordinatorConfig = input.config.coordinator ?? COORDINATOR_DEFAULTS;
  const evaluatedAt = resolveNow(input.now).toISOString();
  const live = input.livePending ?? [];
  const blocked: CoordinatorRejection[] = [];
  const deferred: CoordinatorRejection[] = [];
  const netted: CoordinatorNetting[] = [];

  const block = (p: Proposal, reason: string): void => {
    blocked.push({
      proposal: stamp(p, { decision: 'blocked', reason, evaluatedAt }),
      reason,
    });
  };
  const defer = (p: Proposal, reason: string): void => {
    deferred.push({
      proposal: stamp(p, { decision: 'deferred', reason, evaluatedAt }),
      reason,
    });
  };

  // ---------------------------------------------------------------- stage 1
  // Duplicate-intent suppression: never surface two live proposals for the same
  // intent. Earliest wins; a live pending proposal beats any new candidate.
  const liveIntents = new Set(live.map(intentKey));
  const seenIntents = new Set<string>();
  const stage1: Proposal[] = [];

  const byAge = [...input.proposals].sort(
    (a, b) => createdAtMs(a) - createdAtMs(b) || a.id.localeCompare(b.id),
  );
  for (const p of byAge) {
    const key = intentKey(p);
    if (liveIntents.has(key)) {
      block(p, `duplicate_intent: a live pending proposal already covers ${key}`);
      continue;
    }
    if (seenIntents.has(key)) {
      block(p, `duplicate_intent: an earlier proposal in this batch already covers ${key}`);
      continue;
    }
    seenIntents.add(key);
    stage1.push(p);
  }

  // ---------------------------------------------------------------- stage 2
  // Product discipline + ownership. An exit must match the entry's product, and a
  // non-DELIVERY order may never reference DELIVERY-owned quantity.
  const stage2: Proposal[] = [];
  for (const p of stage1) {
    const key = symbolKey(p.order.symbol);
    const { side, product, quantity } = p.order;

    if (side !== 'SELL') {
      stage2.push(p);
      continue;
    }

    const owned = ownedQty(input.ledger, p.bookId, key, product);
    if (owned >= quantity) {
      stage2.push(p); // clean exit within the same product
      continue;
    }

    const otherLongProducts = heldProducts(input.ledger, p.bookId, key, product).filter(
      (other) => ownedQty(input.ledger, p.bookId, key, other) > 0,
    );
    if (otherLongProducts.length > 0) {
      block(
        p,
        `product_discipline: book '${p.bookId}' holds ${key} as ` +
          `${otherLongProducts.join('/')}, but this order is ${product}; ` +
          `an exit must match the entry product`,
      );
      continue;
    }
    if (product === 'DELIVERY') {
      const check = canExit(input.ledger, p.bookId, p.order);
      block(p, `ownership: ${check.reason}`);
      continue;
    }
    if (owned > 0) {
      block(
        p,
        `ownership: book '${p.bookId}' holds ${owned} ${product} ${key}; selling ${quantity} ` +
          `would both exit and open a short in one order`,
      );
      continue;
    }
    // owned <= 0 on a leveraged product: a genuine new/added short entry.
    stage2.push(p);
  }

  // ---------------------------------------------------------------- stage 3
  // Self-trade / wash prevention: opposing sides on the same symbol inside the
  // window. Both sides of an in-batch pair are blocked; a candidate opposing an
  // already-live proposal is blocked on its own (the live one is not ours to
  // withdraw here).
  const windowMs = cfg.washWindowSeconds * 1000;
  const washed = new Set<string>();
  const washReason = new Map<string, string>();

  for (let i = 0; i < stage2.length; i++) {
    const a = stage2[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < stage2.length; j++) {
      const b = stage2[j];
      if (b === undefined) continue;
      if (symbolKey(a.order.symbol) !== symbolKey(b.order.symbol)) continue;
      if (a.order.side === b.order.side) continue;
      if (Math.abs(createdAtMs(a) - createdAtMs(b)) > windowMs) continue;
      const key = symbolKey(a.order.symbol);
      washed.add(a.id);
      washed.add(b.id);
      washReason.set(
        a.id,
        `wash_trade: book '${a.bookId}' ${a.order.side} opposes book '${b.bookId}' ` +
          `${b.order.side} on ${key} within ${cfg.washWindowSeconds}s`,
      );
      washReason.set(
        b.id,
        `wash_trade: book '${b.bookId}' ${b.order.side} opposes book '${a.bookId}' ` +
          `${a.order.side} on ${key} within ${cfg.washWindowSeconds}s`,
      );
    }
  }
  for (const a of stage2) {
    if (washed.has(a.id)) continue;
    for (const l of live) {
      if (l.status !== 'pending' && l.status !== 'approved') continue;
      if (symbolKey(a.order.symbol) !== symbolKey(l.order.symbol)) continue;
      if (a.order.side === l.order.side) continue;
      if (Math.abs(createdAtMs(a) - createdAtMs(l)) > windowMs) continue;
      washed.add(a.id);
      washReason.set(
        a.id,
        `wash_trade: opposes live proposal '${l.id}' (${l.order.side} ` +
          `${symbolKey(l.order.symbol)}) within ${cfg.washWindowSeconds}s`,
      );
      break;
    }
  }

  const stage3: Proposal[] = [];
  for (const p of stage2) {
    if (washed.has(p.id)) {
      block(p, washReason.get(p.id) ?? 'wash_trade');
    } else {
      stage3.push(p);
    }
  }

  // ---------------------------------------------------------------- stage 4
  // Optional same-side netting. Off by default: merging across books loses clean
  // per-book attribution.
  const precedence = cfg.precedence;
  const byPrecedence = (a: Proposal, b: Proposal): number =>
    precedenceIndex(precedence, a.horizon) - precedenceIndex(precedence, b.horizon) ||
    createdAtMs(a) - createdAtMs(b) ||
    a.id.localeCompare(b.id);

  let stage4: Proposal[] = [...stage3].sort(byPrecedence);
  if (cfg.nettingEnabled) {
    const groups = new Map<string, Proposal[]>();
    for (const p of stage4) {
      const k = nettingKey(p);
      const g = groups.get(k);
      if (g === undefined) groups.set(k, [p]);
      else g.push(p);
    }
    const mergedList: Proposal[] = [];
    for (const group of groups.values()) {
      const base = group[0];
      if (base === undefined) continue;
      if (group.length === 1) {
        mergedList.push(base);
        continue;
      }
      const rest = group.slice(1);
      const totalQty = group.reduce((sum, p) => sum + p.order.quantity, 0);
      const reason =
        `netted: ${group.length} same-side ${base.order.side} orders on ` +
        `${symbolKey(base.order.symbol)} merged into ${totalQty} units ` +
        `(from ${group.map((p) => p.bookId).join(', ')})`;
      const merged: Proposal = stamp(
        {
          ...base,
          order: { ...base.order, quantity: totalQty },
          marketContext: {
            ...base.marketContext,
            estimatedValueInr: totalQty * proposalPrice(base),
          },
        },
        {
          decision: 'netted',
          reason,
          nettedFrom: rest.map((p) => p.id),
          evaluatedAt,
        },
      );
      netted.push({ proposal: merged, mergedFrom: rest.map((p) => p.id), reason });
      mergedList.push(merged);
    }
    stage4 = mergedList.sort(byPrecedence);
  }

  // ---------------------------------------------------------------- stage 5
  // Precedence + capital arbitration against the real available margin and each
  // book's virtual budget. Highest precedence is served first; the rest defer.
  const accepted: Proposal[] = [];
  const bookState = new Map<string, Book>();
  for (const b of input.books ?? []) bookState.set(b.id, { ...b });

  let marginUsed = 0;
  const marginAvailable = Number.isFinite(input.availableMarginInr) ? input.availableMarginInr : 0;

  for (const p of stage4) {
    const notional = notionalOf(p);
    const isExit = canExit(input.ledger, p.bookId, p.order).ok;
    const margin = estimateRequiredMarginInr(p.order, notional);

    if (marginUsed + margin > marginAvailable) {
      defer(
        p,
        `capital_arbitration: needs ₹${margin} margin, ₹${marginAvailable - marginUsed} of ` +
          `₹${marginAvailable} left after higher-precedence books (${p.horizon})`,
      );
      continue;
    }

    if (!isExit) {
      const book = bookState.get(p.bookId);
      if (book !== undefined && !canDeploy(book, notional)) {
        defer(
          p,
          `book_budget: book '${p.bookId}' cannot deploy ₹${notional} ` +
            `(allocated ₹${book.allocatedCapitalInr}, deployed ₹${book.deployedInr}` +
            `${book.enabled ? '' : ', book disabled'})`,
        );
        continue;
      }
      if (book !== undefined) {
        bookState.set(p.bookId, { ...book, deployedInr: book.deployedInr + notional });
      }
    }

    marginUsed += margin;
    const reason = `accepted: ${p.horizon}/${p.bookId} ${p.order.side} ${p.order.quantity} ${symbolKey(p.order.symbol)}`;
    const existing = p.coordinator;
    accepted.push(
      existing?.decision === 'netted' ? p : stamp(p, { decision: 'accepted', reason, evaluatedAt }),
    );
  }

  return { accepted, blocked, deferred, netted };
}
