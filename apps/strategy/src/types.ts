/**
 * The strategy interface — docs/05-strategy-engine.md §5.3, extended with the
 * multi-strategy concepts of docs/10 (book, horizon, ledger).
 *
 * A strategy is a **pure decision function** over a `StrategyContext`: it never
 * reads the clock (`ctx.now`), never opens a socket, and returns *drafts*. The
 * harness is what talks to Firestore, and nothing here can place an order —
 * `ctx.read` is a `BrokerReadAdapter` (docs/05 §5.1).
 */

import { z } from 'zod';
import type {
  Book,
  BookId,
  BrokerReadAdapter,
  Config,
  Horizon,
  LedgerEntry,
  NormalizedOrder,
} from '@pm/core';
import { BookIdSchema, HorizonSchema } from '@pm/core';
import type { MarketData, PortfolioSnapshot } from './ports/index.js';

// ---------------------------------------------------------------------------
// Ticks (docs/05 §5.5)
// ---------------------------------------------------------------------------

export const TICKS = ['pre-open', 'intraday', 'eod'] as const;
export const TickSchema = z.enum(TICKS);
export type Tick = z.infer<typeof TickSchema>;

/** A raw cron expression, for a strategy that needs its own cadence. */
export type CronExpr = string;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * The slice of pino this package uses. Declaring it structurally keeps pino out
 * of the strategies' import graph and out of the test fakes.
 */
export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

// ---------------------------------------------------------------------------
// Proposal drafts (docs/05 §5.3)
// ---------------------------------------------------------------------------

/**
 * What a draft is *for*. Together with `(strategyId, symbolKey, side)` this is
 * the dedupe key of docs/05 §5.4: a stop-loss and a target on the same holding
 * are different intents and may coexist; two stop-losses may not.
 */
export const PROPOSAL_INTENTS = [
  'entry',
  'exit',
  'stop',
  'target',
  'rebalance',
  'dca',
  'square_off',
] as const;
export const ProposalIntentSchema = z.enum(PROPOSAL_INTENTS);
export type ProposalIntent = z.infer<typeof ProposalIntentSchema>;

/** Mirrors `RationaleSchema` in `@pm/core`. */
export interface Rationale {
  summary: string;
  signals: Record<string, unknown>;
  confidence?: 'low' | 'medium' | 'high' | undefined;
}

/** Mirrors `MarketContextSchema` in `@pm/core`. */
export interface DraftMarketContext {
  ltpAtProposal: number;
  estimatedValueInr: number;
  estimatedCharges?: number | undefined;
  capturedAt: string;
}

/**
 * A `NormalizedOrder` + rationale + market context (docs/05 §5.3). The harness
 * attaches the id, `ttlExpiresAt`, the guardrail pre-check and the coordinator
 * block before it becomes a `Proposal`.
 */
export interface ProposalDraft {
  strategyId: string;
  bookId: BookId;
  horizon: Horizon;
  intent: ProposalIntent;
  order: NormalizedOrder;
  rationale: Rationale;
  marketContext: DraftMarketContext;
}

// ---------------------------------------------------------------------------
// Strategy definitions — `strategies/{uid}/defs/{strategyId}` (docs/03 §3.1)
// ---------------------------------------------------------------------------

export const StrategyDefSchema = z.object({
  /** Doc id == the registered strategy implementation id. */
  id: z.string().min(1),
  bookId: BookIdSchema,
  horizon: HorizonSchema,
  enabled: z.boolean(),
  /** Validated by the strategy's own `paramsSchema` when it runs. */
  params: z.record(z.string(), z.unknown()),
  /** Overrides the implementation's default tick membership. */
  ticks: z.array(TickSchema).optional(),
  label: z.string().optional(),
});
export type StrategyDef = z.infer<typeof StrategyDefSchema>;

// ---------------------------------------------------------------------------
// Context / result / strategy (docs/05 §5.3)
// ---------------------------------------------------------------------------

export interface StrategyContext<P = unknown> {
  uid: string;
  config: Config;
  /** READ-ONLY broker access — this type carries no order methods at all. */
  read: BrokerReadAdapter;
  portfolio: PortfolioSnapshot;
  now: Date;
  logger: Logger;

  // docs/10 additions — a strategy always runs *inside* its book.
  tick: Tick;
  def: StrategyDef;
  params: P;
  book: Book;
  /** The whole ledger; a strategy must only ever act on its own book's rows. */
  ledger: readonly LedgerEntry[];
  market: MarketData;
}

export interface StrategyResult {
  /** 0..n candidate orders. */
  proposals: ProposalDraft[];
  notes?: string | undefined;
}

/**
 * The type-erased strategy the harness holds. Produced by
 * {@link defineStrategy}, which is what ties a params schema to a `run`.
 */
export interface Strategy {
  readonly id: string;
  readonly horizon: Horizon;
  /** docs/05 §5.3: `CronExpr | 'pre-open' | 'intraday' | 'eod'`. */
  readonly schedule: readonly Tick[];
  /** Throws `ZodError` when the persisted params are invalid — fail closed. */
  parseParams(raw: unknown): unknown;
  run(ctx: StrategyContext<unknown>): Promise<StrategyResult>;
}

/** A strategy implementation, generic in its validated parameter shape. */
export interface StrategyModule<P> {
  readonly id: string;
  readonly horizon: Horizon;
  readonly schedule: readonly Tick[];
  readonly paramsSchema: z.ZodType<P>;
  run(ctx: StrategyContext<P>): Promise<StrategyResult>;
}

/**
 * Erase a module's parameter type, validating `ctx.params` on the way in. A
 * strategy therefore cannot observe unvalidated config.
 */
export function defineStrategy<P>(mod: StrategyModule<P>): Strategy {
  return {
    id: mod.id,
    horizon: mod.horizon,
    schedule: mod.schedule,
    parseParams: (raw: unknown): unknown => mod.paramsSchema.parse(raw),
    // `async` on purpose: a params-validation failure must surface as a rejected
    // promise so the harness's try/catch treats it like any other strategy error.
    run: async (ctx: StrategyContext<unknown>): Promise<StrategyResult> =>
      mod.run({ ...ctx, params: mod.paramsSchema.parse(ctx.params) }),
  };
}
