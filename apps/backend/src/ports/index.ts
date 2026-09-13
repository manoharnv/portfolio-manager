/**
 * Ports — every I/O boundary the backend touches, expressed as an interface.
 *
 * Nothing in `services/` or `http/` may import `firebase-admin`,
 * `@google-cloud/secret-manager` or a broker SDK: they talk to these types, the
 * composition root (`index.ts`) supplies the real implementations, and tests
 * supply in-memory fakes (`test-utils/fakes.ts`). That is what makes
 * "no network in tests" (docs/00 §0.5) structurally true rather than aspirational.
 */

import type {
  Broker,
  BrokerAdapter,
  Funds,
  Holding,
  Position,
  SessionStatus,
  TodayAggregates,
} from '@pm/core';
import type {
  AuditEvent,
  Book,
  BookId,
  BrokerSession,
  Config,
  IdempotencyRecord,
  LedgerEntry,
  OrderRecord,
  Proposal,
  ProposalStatus,
} from '@pm/core';

// ---------------------------------------------------------------------------
// Ambient capabilities
// ---------------------------------------------------------------------------

/** The only reader of wall-clock time (docs/00 §0.5). Injected everywhere. */
export interface Clock {
  now(): Date;
}

/** Opaque id minting — kept out of services so tests are deterministic. */
export interface IdGenerator {
  orderId(): string;
  auditId(): string;
  /** Ledger entries are keyed off the order so a fill can correct its own row. */
  ledgerId(orderId: string): string;
}

/** Firebase ID-token verification (docs/04 §4.9). */
export interface TokenVerifier {
  /** Resolves to the caller's uid, or throws when the token is absent/invalid. */
  verify(idToken: string): Promise<{ uid: string }>;
}

// ---------------------------------------------------------------------------
// Firestore-backed repositories (docs/03)
// ---------------------------------------------------------------------------

/** Fields the backend may attach while transitioning a proposal. */
export interface ProposalTransitionPatch {
  decidedBy?: string | undefined;
  decidedAt?: string | undefined;
  orderId?: string | undefined;
  failureReason?: string | undefined;
}

export type ProposalTransitionResult =
  | { ok: true; proposal: Proposal }
  /** Someone else moved it first — the compare-and-set lost. */
  | { ok: false; reason: 'conflict'; current: ProposalStatus }
  | { ok: false; reason: 'not-found' };

export interface ProposalRepo {
  get(id: string): Promise<Proposal | undefined>;
  /**
   * Compare-and-set: applies `to` only if the stored status is still `from`.
   * The implementation must be atomic (a Firestore transaction) — a lost update
   * here is a double-execute.
   */
  transition(
    id: string,
    from: ProposalStatus,
    to: ProposalStatus,
    patch?: ProposalTransitionPatch,
  ): Promise<ProposalTransitionResult>;
  /** Proposals of this user currently in any of `statuses`. */
  listByStatus(uid: string, statuses: readonly ProposalStatus[]): Promise<Proposal[]>;
}

export interface OrderRepo {
  create(record: OrderRecord): Promise<void>;
  get(id: string): Promise<OrderRecord | undefined>;
  patch(id: string, patch: Partial<OrderRecord>): Promise<void>;
  /** Orders that may still change state — the reconciler's work list. */
  listOpen(uid: string): Promise<OrderRecord[]>;
  /**
   * The order a proposal produced, if any. The stuck-proposal sweep uses it to
   * tell "never reached the broker" from "placed but the write was lost".
   */
  findByProposal(uid: string, proposalId: string): Promise<OrderRecord | undefined>;
  /** Every order approved within `[fromIso, toIso)`, for daily aggregates. */
  listApprovedBetween(uid: string, fromIso: string, toIso: string): Promise<OrderRecord[]>;
}

/**
 * The exactly-once lock (docs/03 §3.8, docs/04 §4.4). `acquire` MUST be an
 * atomic create-if-absent: `'acquired'` means this caller owns the placement,
 * anything else is the record that already existed.
 */
export interface IdempotencyStore {
  acquire(key: string, proposalId: string, now: Date): Promise<'acquired' | IdempotencyRecord>;
  complete(key: string, orderId: string, result: unknown): Promise<void>;
  fail(key: string, result: unknown): Promise<void>;
  get(key: string): Promise<IdempotencyRecord | undefined>;
}

export interface ConfigRepo {
  /** `undefined` ⇒ the backend refuses to trade (docs/07 §7.8, fail closed). */
  get(uid: string): Promise<Config | undefined>;
  patch(uid: string, patch: Partial<Config>): Promise<Config>;
}

/** Append-only (docs/03 §3.7). There is deliberately no update or delete. */
export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
}

/** Non-secret session metadata only — the token lives in {@link SecretStore}. */
export interface SessionStore {
  get(uid: string, broker: Broker): Promise<BrokerSession | undefined>;
  set(uid: string, session: BrokerSession): Promise<void>;
}

/** A secret plus the metadata the session checks need (docs/02 §2.4, §2.8). */
export interface SecretValue {
  value: string;
  /** ISO-8601 expiry of a daily token; absent ⇒ unknown ⇒ treated as expired. */
  expiresAt?: string | undefined;
}

export interface SecretStore {
  /** `undefined` when the secret (or a usable version) does not exist. */
  get(name: string): Promise<SecretValue | undefined>;
  set(name: string, secret: SecretValue): Promise<void>;
}

export interface PortfolioSnapshot {
  holdings: Holding[];
  positions: Position[];
  funds: Funds;
}

export interface PortfolioCache {
  write(uid: string, snapshot: PortfolioSnapshot, now: Date): Promise<void>;
}

export interface LedgerRepo {
  /** Upsert by `entry.id`: re-appending the same id corrects a provisional row. */
  append(entry: LedgerEntry): Promise<void>;
  remove(uid: string, entryId: string): Promise<void>;
  list(uid: string): Promise<LedgerEntry[]>;
}

export interface BookRepo {
  get(uid: string, bookId: BookId): Promise<Book | undefined>;
  patch(uid: string, bookId: BookId, patch: Partial<Book>): Promise<void>;
}

/** Today's running totals for the `dailyNotional`/`dailyOrderCount` guardrails. */
export interface DailyAggregates {
  /** `istDateKey` is the IST trading date (`YYYY-MM-DD`) from core. */
  today(uid: string, istDateKey: string): Promise<TodayAggregates>;
}

// ---------------------------------------------------------------------------
// Broker access
// ---------------------------------------------------------------------------

/** Everything the execution path needs about the caller's broker connection. */
export interface BrokerContext {
  broker: Broker;
  /** In `dry-run`/`paper` the order half is the simulator (docs/04 §4.8). */
  adapter: BrokerAdapter;
  /** Derived from stored metadata, not from a live broker round-trip. */
  session: SessionStatus;
}

/**
 * Raised when no usable broker credential exists for a user. Callers turn this
 * into `SESSION_INVALID` / `409 needs re-login` — never into a placement.
 */
export class SessionUnavailableError extends Error {
  readonly broker: Broker;

  constructor(broker: Broker, detail: string) {
    super(`No usable ${broker} session: ${detail}`);
    this.name = 'SessionUnavailableError';
    this.broker = broker;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface BrokerGateway {
  /** Throws {@link SessionUnavailableError} when the user has no live token. */
  forUser(uid: string): Promise<BrokerContext>;
}
