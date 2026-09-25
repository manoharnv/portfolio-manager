/**
 * zod schemas for every persisted document — docs/03-data-model.md and
 * docs/10-multi-strategy.md §10.3/§10.4/§10.8.
 *
 * Convention (see docs/00-dev-conventions.md): the zod object is exported as
 * `XxxSchema`; the inferred TypeScript type is exported as `Xxx`. All timestamps
 * are ISO-8601 strings with an explicit timezone.
 *
 * Where the spec left a field loosely typed (`z.number()`), this file applies the
 * stricter option — money and quantities can never be negative or NaN.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Real calendar check. `Date.parse` silently rolls over impossible dates
 * (`2026-02-30` → 2 March), so the components are verified explicitly.
 */
function isRealDateTime(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

/** ISO-8601 instant with an explicit timezone, e.g. `2026-01-31T09:20:00.000Z`. */
export const IsoDateTimeSchema = z
  .string()
  .regex(ISO_DATETIME_RE, 'expected an ISO-8601 timestamp with timezone')
  .refine(isRealDateTime, { message: 'not a valid calendar date/time' });

/** `YYYY-MM-DD` (IST trading date). */
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

// NB: the neutral *types* (Broker, Exchange, Side, OrderStatusCode, ...) are owned
// by `domain.ts`; this module only owns their runtime validators, so `index.ts`
// can re-export both modules without a name collision.
export const BrokerSchema = z.enum(['dhan', 'kite']);

export const EnvironmentSchema = z.enum(['dry-run', 'paper', 'prod']);
export type Environment = z.infer<typeof EnvironmentSchema>;

export const ExchangeSchema = z.enum(['NSE', 'BSE', 'MCX']);
export const SegmentSchema = z.enum(['EQ', 'FNO', 'CURRENCY', 'COMMODITY']);
export const SideSchema = z.enum(['BUY', 'SELL']);
export const OrderTypeSchema = z.enum(['MARKET', 'LIMIT', 'SL', 'SL-M']);
export const ProductSchema = z.enum(['DELIVERY', 'INTRADAY', 'MARGIN', 'MTF']);
export const ValiditySchema = z.enum(['DAY', 'IOC']);

export const OrderStatusCodeSchema = z.enum([
  'SUBMITTED',
  'OPEN',
  'PARTIAL',
  'COMPLETE',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'UNKNOWN',
]);

/** The four trading horizons — docs/10 §10.1. Book ids use the same values. */
export const HORIZONS = ['long_term', 'swing', 'day_trade', 'scalp'] as const;
export const HorizonSchema = z.enum(HORIZONS);
export type Horizon = z.infer<typeof HorizonSchema>;

export const BookIdSchema = z.enum(HORIZONS);
export type BookId = z.infer<typeof BookIdSchema>;

export const CanonicalSymbolSchema = z.object({
  exchange: ExchangeSchema,
  segment: SegmentSchema,
  tradingSymbol: z.string().min(1),
});

// ---------------------------------------------------------------------------
// NormalizedOrder (docs/02 §2.2) — the neutral order carried by proposals/orders
// ---------------------------------------------------------------------------

const NormalizedOrderBaseSchema = z.object({
  symbol: CanonicalSymbolSchema,
  side: SideSchema,
  quantity: z.number().int().positive(),
  orderType: OrderTypeSchema,
  product: ProductSchema,
  validity: ValiditySchema,
  limitPrice: z.number().positive().finite().optional(),
  triggerPrice: z.number().positive().finite().optional(),
  disclosedQuantity: z.number().int().nonnegative().optional(),
});

/**
 * Stricter than the spec on purpose: a price field must be present exactly when
 * the order type needs it, and absent when it does not. A stray `limitPrice` on
 * a MARKET order is a bug we want caught at the schema, not at the broker.
 */
export const NormalizedOrderSchema = NormalizedOrderBaseSchema.superRefine((order, ctx) => {
  const needsLimit = order.orderType === 'LIMIT' || order.orderType === 'SL';
  const needsTrigger = order.orderType === 'SL' || order.orderType === 'SL-M';

  if (needsLimit && order.limitPrice === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['limitPrice'],
      message: `limitPrice is required for ${order.orderType} orders`,
    });
  }
  if (!needsLimit && order.limitPrice !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['limitPrice'],
      message: `limitPrice must not be set for ${order.orderType} orders`,
    });
  }
  if (needsTrigger && order.triggerPrice === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['triggerPrice'],
      message: `triggerPrice is required for ${order.orderType} orders`,
    });
  }
  if (!needsTrigger && order.triggerPrice !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['triggerPrice'],
      message: `triggerPrice must not be set for ${order.orderType} orders`,
    });
  }
  if (order.disclosedQuantity !== undefined && order.disclosedQuantity > order.quantity) {
    ctx.addIssue({
      code: 'custom',
      path: ['disclosedQuantity'],
      message: 'disclosedQuantity cannot exceed quantity',
    });
  }
});

// ---------------------------------------------------------------------------
// §3.2 config/{uid}
// ---------------------------------------------------------------------------

export const GuardrailConfigSchema = z.object({
  /** Per single order notional. */
  maxOrderValueInr: z.number().nonnegative().finite(),
  /** Sum across a trading day. */
  maxDailyNotionalInr: z.number().nonnegative().finite(),
  maxOrdersPerDay: z.number().int().nonnegative(),
  allowedSegments: z.array(SegmentSchema),
  allowedProducts: z.array(ProductSchema),
  /** `null` ⇒ no allowlist filter. */
  symbolAllowlist: z.array(z.string()).nullable(),
  symbolBlocklist: z.array(z.string()),
  /** Limit price must be within ±% of live LTP. */
  priceCollarPct: z.number().nonnegative().finite(),
  proposalTtlSeconds: z.number().int().positive(),
  requireBiometric: z.boolean(),
});
export type GuardrailConfig = z.infer<typeof GuardrailConfigSchema>;

/**
 * Coordinator knobs (docs/10 §10.5). Optional so a config written against the
 * docs/03 shape still parses; `coordinator.ts` falls back to COORDINATOR_DEFAULTS.
 */
export const CoordinatorConfigSchema = z.object({
  /** Net same-side orders across books. Off by default — keeps attribution clean. */
  nettingEnabled: z.boolean(),
  /** Opposing orders on one symbol inside this window are treated as a wash. */
  washWindowSeconds: z.number().int().nonnegative(),
  /** Highest priority first. */
  precedence: z.array(HorizonSchema),
});
export type CoordinatorConfig = z.infer<typeof CoordinatorConfigSchema>;

export const ConfigSchema = z.object({
  uid: z.string().min(1),
  activeBroker: BrokerSchema,
  environment: EnvironmentSchema,

  /** true ⇒ backend refuses ALL orders. */
  killSwitch: z.boolean(),
  /** Master on/off for the strategy engine. */
  tradingEnabled: z.boolean(),

  guardrails: GuardrailConfigSchema,

  // docs/10 §10.8 additions
  totalManagedCapitalInr: z.number().nonnegative().finite(),
  /** Share of total capital held back, 0–100. Σ book allocationPct + reservePct ≤ 100. */
  reservePct: z.number().min(0).max(100),
  coordinator: CoordinatorConfigSchema.optional(),

  updatedAt: IsoDateTimeSchema,
});
export type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// §3.3 proposals/{proposalId}
// ---------------------------------------------------------------------------

export const PROPOSAL_STATUSES = [
  /** Awaiting human decision. */
  'pending',
  /** Human tapped approve; backend about to place. */
  'approved',
  /** Backend is calling the broker. */
  'placing',
  /** Order accepted by the broker. */
  'placed',
  /** Fully executed. */
  'filled',
  /** Human rejected, or broker RMS rejected. */
  'rejected',
  /** TTL elapsed with no decision. */
  'expired',
  /** Placement failed (see failureReason). */
  'failed',
  /** Guardrail blocked at execution. */
  'blocked',
] as const;

export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const ConfidenceSchema = z.enum(['low', 'medium', 'high']);

export const RationaleSchema = z.object({
  /** Human-readable "why". */
  summary: z.string().min(1),
  /** Indicators/values used. */
  signals: z.record(z.string(), z.any()),
  confidence: ConfidenceSchema.optional(),
});

export const MarketContextSchema = z.object({
  ltpAtProposal: z.number().positive().finite(),
  estimatedValueInr: z.number().nonnegative().finite(),
  /** Brokerage + taxes estimate. */
  estimatedCharges: z.number().nonnegative().finite().optional(),
  capturedAt: IsoDateTimeSchema,
});

export const GuardrailCheckSchema = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  detail: z.string(),
});

export const GuardrailResultSchema = z.object({
  passed: z.boolean(),
  checks: z.array(GuardrailCheckSchema),
});

export const CoordinatorDecisionSchema = z.enum(['accepted', 'blocked', 'deferred', 'netted']);
export type CoordinatorDecision = z.infer<typeof CoordinatorDecisionSchema>;

/** The coordinator result block added to proposals by docs/10 §10.8. */
export const CoordinatorResultSchema = z.object({
  decision: CoordinatorDecisionSchema,
  /** Audit-ready reason string, e.g. `wash_trade: opposing SELL from swing ...`. */
  reason: z.string(),
  /** Proposal ids folded into this one when `decision === 'netted'`. */
  nettedFrom: z.array(z.string()).optional(),
  evaluatedAt: IsoDateTimeSchema,
});
export type CoordinatorResult = z.infer<typeof CoordinatorResultSchema>;

export const ProposalSchema = z.object({
  id: z.string().min(1),
  uid: z.string().min(1),
  createdAt: IsoDateTimeSchema,
  createdBy: z.literal('strategy-engine'),
  /** Which routine produced it. */
  strategyId: z.string().min(1),
  targetBroker: BrokerSchema,

  // docs/10 §10.8 additions — required, so every proposal is attributable.
  bookId: BookIdSchema,
  horizon: HorizonSchema,

  status: ProposalStatusSchema,

  /** The neutral order (docs/02). */
  order: NormalizedOrderSchema,

  rationale: RationaleSchema,
  marketContext: MarketContextSchema,
  /** What the engine checked before writing. */
  guardrailPrecheck: GuardrailResultSchema,
  coordinator: CoordinatorResultSchema.optional(),

  /** Hard expiry; the app hides it and the backend refuses after this instant. */
  ttlExpiresAt: IsoDateTimeSchema,

  // decision + execution trail (filled in later)
  decidedBy: z.string().optional(),
  decidedAt: IsoDateTimeSchema.optional(),
  orderId: z.string().optional(),
  failureReason: z.string().optional(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

// ---------------------------------------------------------------------------
// §3.4 orders/{orderId}
// ---------------------------------------------------------------------------

export const OrderRecordSchema = z.object({
  id: z.string().min(1),
  uid: z.string().min(1),
  proposalId: z.string().min(1),
  broker: BrokerSchema,
  brokerOrderId: z.string().nullable(),
  idempotencyKey: z.string().min(1),

  // docs/10 §10.8 additions — so P&L and the ledger attribute correctly.
  bookId: BookIdSchema,
  horizon: HorizonSchema,

  order: NormalizedOrderSchema,
  status: OrderStatusCodeSchema,
  filledQty: z.number().int().nonnegative(),
  avgFillPrice: z.number().nonnegative().finite().nullable(),
  rejectionReason: z.string().nullable(),

  approvedBy: z.string().min(1),
  approvedAt: IsoDateTimeSchema,
  submittedAt: IsoDateTimeSchema.nullable(),
  /** Static IP the order left from (audit). */
  ipUsed: z.string(),
  environment: EnvironmentSchema,

  /** Raw broker response. */
  brokerRawAck: z.any(),
  updatedAt: IsoDateTimeSchema,
});
export type OrderRecord = z.infer<typeof OrderRecordSchema>;

// ---------------------------------------------------------------------------
// §3.5 brokerSessions/{uid}/brokers/{broker} — non-secret metadata ONLY
// ---------------------------------------------------------------------------

export const BrokerSessionSchema = z.object({
  broker: BrokerSchema,
  connected: z.boolean(),
  /** Token expiry (metadata only — the token itself lives in Secret Manager). */
  expiresAt: IsoDateTimeSchema.nullable(),
  staticIpOk: z.boolean(),
  lastConnectedAt: IsoDateTimeSchema.nullable(),
});
export type BrokerSession = z.infer<typeof BrokerSessionSchema>;

// ---------------------------------------------------------------------------
// §3.6 portfolio/{uid}/... cached read model
// ---------------------------------------------------------------------------

export const HoldingSchema = z.object({
  symbol: CanonicalSymbolSchema,
  quantity: z.number().int(),
  avgCostPrice: z.number().nonnegative().finite(),
  lastPrice: z.number().nonnegative().finite(),
  pnl: z.number().finite(),
  raw: z.unknown(),
});

export const PositionSchema = z.object({
  symbol: CanonicalSymbolSchema,
  netQty: z.number().int(),
  product: ProductSchema,
  avgPrice: z.number().nonnegative().finite(),
  lastPrice: z.number().nonnegative().finite(),
  realizedPnl: z.number().finite(),
  unrealizedPnl: z.number().finite(),
  raw: z.unknown(),
});

export const FundsSchema = z.object({
  availableCash: z.number().finite(),
  usedMargin: z.number().finite(),
  availableMargin: z.number().finite(),
  raw: z.unknown(),
});

/** `symbolKey` = `${exchange}:${segment}:${tradingSymbol}` (stable doc id). */
export const HoldingDocSchema = HoldingSchema.extend({
  symbolKey: z.string().min(1),
  updatedAt: IsoDateTimeSchema,
});
export type HoldingDoc = z.infer<typeof HoldingDocSchema>;

export const PositionDocSchema = PositionSchema.extend({
  symbolKey: z.string().min(1),
  updatedAt: IsoDateTimeSchema,
});
export type PositionDoc = z.infer<typeof PositionDocSchema>;

export const FundsDocSchema = FundsSchema.extend({ updatedAt: IsoDateTimeSchema });
export type FundsDoc = z.infer<typeof FundsDocSchema>;

// ---------------------------------------------------------------------------
// §3.7 auditLog/{eventId} — append-only
// ---------------------------------------------------------------------------

export const AUDIT_EVENT_TYPES = [
  'proposal.created',
  'proposal.approved',
  'proposal.rejected',
  'proposal.expired',
  'order.submitted',
  'order.filled',
  'order.rejected',
  'order.failed',
  'guardrail.blocked',
  'killswitch.toggled',
  'config.changed',
  'session.connected',
  'session.expired',
  'ip.changed',
  'auth.login',
  // docs/10 §10.5 — coordinator decisions are audited too.
  'coordinator.blocked',
  'coordinator.netted',
  'coordinator.deferred',
] as const;

export const AuditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const AuditEventSchema = z.object({
  id: z.string().min(1),
  uid: z.string().min(1),
  ts: IsoDateTimeSchema,
  actor: z.enum(['strategy-engine', 'backend', 'app-user', 'system']),
  type: AuditEventTypeSchema,
  /** proposalId / orderId */
  refId: z.string().optional(),
  detail: z.record(z.string(), z.any()),
  ip: z.string().optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

// ---------------------------------------------------------------------------
// §3.8 idempotency/{idempotencyKey}
// ---------------------------------------------------------------------------

export const IdempotencyRecordSchema = z.object({
  key: z.string().min(1),
  proposalId: z.string().min(1),
  orderId: z.string().nullable(),
  status: z.enum(['in-progress', 'done', 'failed']),
  createdAt: IsoDateTimeSchema,
  result: z.any().nullable(),
});
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

// ---------------------------------------------------------------------------
// docs/10 §10.3 books/{uid}/books/{bookId}
// ---------------------------------------------------------------------------

export const BookRiskSchema = z.object({
  maxPositions: z.number().int().nonnegative(),
  maxPositionValueInr: z.number().nonnegative().finite(),
  /** The book pauses for the day if breached. */
  dailyLossStopInr: z.number().nonnegative().finite(),
  /** Position-sizing input. */
  perTradeRiskPct: z.number().min(0).max(100),
});
export type BookRisk = z.infer<typeof BookRiskSchema>;

export const BookSchema = z.object({
  id: BookIdSchema,
  label: z.string().min(1),
  enabled: z.boolean(),
  /** Share of total managed capital, 0–100. */
  allocationPct: z.number().min(0).max(100),
  /** Derived = totalManagedCapitalInr × allocationPct / 100. */
  allocatedCapitalInr: z.number().nonnegative().finite(),
  /** Sum of open-position cost in this book (from the ledger). */
  deployedInr: z.number().nonnegative().finite(),
  /** The book's booked P&L. */
  realizedPnlInr: z.number().finite(),
  /** Fixed per book. */
  product: ProductSchema,
  risk: BookRiskSchema,
});
export type Book = z.infer<typeof BookSchema>;

// ---------------------------------------------------------------------------
// docs/10 §10.4 ledger/{uid}/entries/{entryId}
// ---------------------------------------------------------------------------

/**
 * `bookId` is a free string (not `BookIdSchema`) on purpose: reconciliation
 * attributes manual broker-app trades to the pseudo-book `unmanaged` (§10.4).
 */
export const UNMANAGED_BOOK_ID = 'unmanaged';

export const LedgerEntrySchema = z.object({
  id: z.string().min(1),
  uid: z.string().min(1),
  bookId: z.string().min(1),
  strategyId: z.string().min(1),
  /** exchange:segment:tradingSymbol */
  symbolKey: z.string().min(1),
  product: ProductSchema,
  side: SideSchema,
  qty: z.number().int().positive(),
  price: z.number().nonnegative().finite(),
  /** → orders/{id} */
  orderId: z.string().min(1),
  ts: IsoDateTimeSchema,
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

// ---------------------------------------------------------------------------
// docs/10 §10.8 mandates/{uid}/mandates/{mandateId} — Option B only
// ---------------------------------------------------------------------------

export const MandateSchema = z.object({
  id: z.string().min(1),
  uid: z.string().min(1),
  bookId: z.literal('scalp'),
  instruments: z.array(z.string().min(1)).min(1),
  activatedAt: IsoDateTimeSchema,
  /** Hard TTL. */
  expiresAt: IsoDateTimeSchema,
  maxCapitalInr: z.number().positive().finite(),
  maxTrades: z.number().int().positive(),
  perTradeSizeInr: z.number().positive().finite(),
  dailyLossStopInr: z.number().positive().finite(),
  /** DETERMINISTIC rule set (no LLM). */
  ruleSetId: z.string().min(1),
  status: z.enum(['active', 'expired', 'stopped', 'exhausted']),
  tradesPlaced: z.number().int().nonnegative(),
  realizedPnlInr: z.number().finite(),
  /** uid + biometric assertion. */
  activatedBy: z.string().min(1),
});
export type Mandate = z.infer<typeof MandateSchema>;
