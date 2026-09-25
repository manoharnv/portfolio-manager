/**
 * Firestore document ⟷ domain mappers.
 *
 * Every read is validated with the zod schema from `@pm/core` — a malformed doc
 * throws rather than becoming a half-built order (docs/00 §0.7.1, fail closed).
 * Pure functions, unit tested; the repos around them only fetch and delegate.
 */

import {
  AuditEventSchema,
  BookSchema,
  BrokerSessionSchema,
  ConfigSchema,
  FundsSchema,
  HoldingSchema,
  LedgerEntrySchema,
  PositionSchema,
  ProposalSchema,
} from '@pm/core';
import type {
  AuditEvent,
  Book,
  Config,
  Funds,
  Holding,
  LedgerEntry,
  Position,
  Proposal,
  SessionStatus,
} from '@pm/core';
import { StrategyDefSchema, type StrategyDef } from '../../types.js';

export function toConfig(data: unknown): Config {
  return ConfigSchema.parse(data);
}

/** The doc id is authoritative — `strategies/{uid}/defs/{strategyId}`. */
export function toStrategyDef(id: string, data: unknown): StrategyDef {
  const base = typeof data === 'object' && data !== null ? data : {};
  return StrategyDefSchema.parse({ ...base, id });
}

export function toProposal(data: unknown): Proposal {
  return ProposalSchema.parse(data);
}

export function toBook(data: unknown): Book {
  return BookSchema.parse(data);
}

export function toLedgerEntry(data: unknown): LedgerEntry {
  return LedgerEntrySchema.parse(data);
}

/**
 * `brokerSessions/{uid}/brokers/{broker}` holds non-secret metadata only
 * (docs/03 §3.5). `expiresAt: null` becomes *absent*, which makes the
 * `sessionValid` guardrail fail — exactly the intended fail-closed behaviour.
 */
export function toSessionStatus(data: unknown): SessionStatus {
  const doc = BrokerSessionSchema.parse(data);
  const status: SessionStatus = {
    broker: doc.broker,
    connected: doc.connected,
    staticIpOk: doc.staticIpOk,
  };
  if (doc.expiresAt !== null) status.expiresAt = doc.expiresAt;
  return status;
}

/**
 * `raw` is the verbatim broker payload. It is required by the schema but the
 * cache writer may omit it; absent means "we kept nothing", i.e. `null`.
 */
function withRaw(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return data;
  const record = data as Record<string, unknown>;
  return 'raw' in record ? record : { ...record, raw: null };
}

export function toHolding(data: unknown): Holding {
  const doc = HoldingSchema.parse(withRaw(data));
  return {
    symbol: doc.symbol,
    quantity: doc.quantity,
    avgCostPrice: doc.avgCostPrice,
    lastPrice: doc.lastPrice,
    pnl: doc.pnl,
    raw: doc.raw,
  };
}

export function toPosition(data: unknown): Position {
  const doc = PositionSchema.parse(withRaw(data));
  return {
    symbol: doc.symbol,
    netQty: doc.netQty,
    product: doc.product,
    avgPrice: doc.avgPrice,
    lastPrice: doc.lastPrice,
    realizedPnl: doc.realizedPnl,
    unrealizedPnl: doc.unrealizedPnl,
    raw: doc.raw,
  };
}

export function toFunds(data: unknown): Funds {
  const doc = FundsSchema.parse(withRaw(data));
  return {
    availableCash: doc.availableCash,
    usedMargin: doc.usedMargin,
    availableMargin: doc.availableMargin,
    raw: doc.raw,
  };
}

/** Re-validated on the way out too: nothing unvalidated reaches Firestore. */
export function fromProposal(proposal: Proposal): Record<string, unknown> {
  return { ...ProposalSchema.parse(proposal) };
}

export function fromAuditEvent(event: AuditEvent): Record<string, unknown> {
  return { ...AuditEventSchema.parse(event) };
}
