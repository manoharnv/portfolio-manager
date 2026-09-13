/**
 * Firestore-shaped ports. The engine's service account is scoped to write
 * `proposals` and `auditLog` only (docs/05 §5.1) — note that every other port
 * here is read-only by construction: there is no `update`, no `delete`.
 */

import type { AuditEvent, Book, Config, LedgerEntry, Proposal } from '@pm/core';
import type { StrategyDef } from '../types.js';

export interface ConfigRepo {
  /** `undefined` when the user has no config — the tick fails closed. */
  get(uid: string): Promise<Config | undefined>;
}

export interface StrategyDefsRepo {
  /** Only `enabled` defs; `strategies/{uid}/defs`. */
  listEnabled(uid: string): Promise<StrategyDef[]>;
}

export interface ProposalRepo {
  /** Proposals still awaiting or mid-decision — the dedupe/wash basis. */
  listOpen(uid: string): Promise<Proposal[]>;
  create(proposal: Proposal): Promise<void>;
}

export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
}

export interface LedgerRepo {
  /** `ledger/{uid}/entries` — position attribution (docs/10 §10.4). */
  listEntries(uid: string): Promise<LedgerEntry[]>;
}

export interface BookRepo {
  /** `books/{uid}/books` — capital sleeves (docs/10 §10.3). */
  listBooks(uid: string): Promise<Book[]>;
}
