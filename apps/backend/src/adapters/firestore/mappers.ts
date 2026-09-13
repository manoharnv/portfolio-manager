/**
 * Document ↔ domain mapping. Pure functions only — this is the part of the
 * Firestore adapter that has logic, so it is the part that gets unit tests.
 *
 * Everything read out of Firestore is re-validated against the zod schema that
 * defines it (docs/03: "All schemas are defined once as zod in
 * `packages/core/src/schemas.ts`"). A malformed document is a hard error, never
 * a silently-coerced order.
 */

import { symbolKey } from '@pm/core';
import type { CanonicalSymbol } from '@pm/core';
import { istDateKey, IST_OFFSET_MINUTES } from '@pm/core';
import type { FsDocSnapshot } from './db.js';

export class DocumentShapeError extends Error {
  readonly collection: string;
  readonly docId: string;

  constructor(collection: string, docId: string, detail: string) {
    super(`Malformed ${collection}/${docId}: ${detail}`);
    this.name = 'DocumentShapeError';
    this.collection = collection;
    this.docId = docId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The shape of a zod schema, structurally — so a repo can pass `ProposalSchema`
 * without this module having to spell out zod's generic parameters.
 */
export interface SafeParser<T> {
  safeParse(
    data: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: PropertyKey[]; message: string }[] } };
}

/**
 * Validate one snapshot against its schema. `undefined` when the document does
 * not exist; throws {@link DocumentShapeError} when it exists but is malformed.
 */
export function decodeDoc<T>(
  collection: string,
  snap: FsDocSnapshot | undefined,
  schema: SafeParser<T>,
): T | undefined {
  if (snap === undefined || !snap.exists) return undefined;
  const data = snap.data();
  if (data === undefined) return undefined;
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new DocumentShapeError(
      collection,
      snap.id,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return parsed.data;
}

/** Decode a whole query snapshot, skipping nothing and validating everything. */
export function decodeAll<T>(
  collection: string,
  docs: readonly FsDocSnapshot[],
  schema: SafeParser<T>,
): T[] {
  const out: T[] = [];
  for (const snap of docs) {
    const value = decodeDoc(collection, snap, schema);
    if (value !== undefined) out.push(value);
  }
  return out;
}

/** Stable portfolio doc id — docs/03 §3.6. */
export function portfolioDocId(sym: CanonicalSymbol): string {
  return symbolKey(sym).replace(/\//g, '_');
}

/** `brokerSessions/{uid}/brokers/{broker}` (docs/03 §3.5). */
export function sessionPath(uid: string, broker: string): string {
  return `brokerSessions/${uid}/brokers/${broker}`;
}

export function bookPath(uid: string, bookId: string): string {
  return `books/${uid}/books/${bookId}`;
}

/** `strategies/{uid}/defs/{strategyId}` (docs/03 §3.1). */
export function strategyDefPath(uid: string, strategyId: string): string {
  return `strategies/${uid}/defs/${strategyId}`;
}

export function ledgerCollection(uid: string): string {
  return `ledger/${uid}/entries`;
}

export function portfolioCollection(uid: string, slice: 'holdings' | 'positions'): string {
  return `portfolio/${uid}/${slice}`;
}

export function fundsPath(uid: string): string {
  return `portfolio/${uid}/funds/current`;
}

/**
 * The UTC half-open interval `[start, end)` covering one IST trading date — the
 * range daily aggregates sum over. Derived from core's IST helpers so the
 * backend and the guardrails agree on where "today" begins.
 */
export function istDayBounds(now: Date): { dateKey: string; fromIso: string; toIso: string } {
  const dateKey = istDateKey(now);
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  const startUtcMs = Date.UTC(y, m - 1, d) - IST_OFFSET_MINUTES * 60_000;
  return {
    dateKey,
    fromIso: new Date(startUtcMs).toISOString(),
    toIso: new Date(startUtcMs + 24 * 60 * 60 * 1000).toISOString(),
  };
}
