/**
 * In-memory fakes for every port — tests only.
 *
 * "No network in unit tests. Ever." (docs/00 §0.5). These are the other half of
 * that promise: every fake is synchronous-at-heart, deterministic, and records
 * what it was asked to do so a test can assert on the *absence* of a call —
 * which, on a money path, is the assertion that matters most.
 */

import { BrokerError, symbolKey } from '@pm/core';
import type {
  Broker,
  BrokerAdapter,
  Candle,
  CanonicalSymbol,
  Funds,
  HistoricalRequest,
  Holding,
  InstrumentRef,
  NormalizedOrder,
  OrderAck,
  OrderStatus,
  Position,
  Quote,
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
import type {
  AuditLog,
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
  PortfolioCache,
  PortfolioSnapshot,
  ProposalRepo,
  ProposalTransitionPatch,
  ProposalTransitionResult,
  SecretStore,
  SecretValue,
  SessionStore,
  StrategyDef,
  StrategyDefsRepo,
  TokenVerifier,
} from '../ports/index.js';
import { makeFunds, makeInstrument, makeQuote, makeSessionStatus } from './fixtures.js';

// ---------------------------------------------------------------------------
// Ambient
// ---------------------------------------------------------------------------

/** A clock the test drives by hand. Never reads the host clock. */
export class FixedClock implements Clock {
  #now: Date;

  constructor(iso: string) {
    this.#now = new Date(iso);
  }

  now(): Date {
    return new Date(this.#now.getTime());
  }

  set(iso: string): void {
    this.#now = new Date(iso);
  }

  advance(ms: number): void {
    this.#now = new Date(this.#now.getTime() + ms);
  }
}

export class SeqIdGenerator implements IdGenerator {
  #orders = 0;
  #audits = 0;

  orderId(): string {
    this.#orders += 1;
    return `ord_${String(this.#orders).padStart(4, '0')}`;
  }

  auditId(): string {
    this.#audits += 1;
    return `aud_${String(this.#audits).padStart(4, '0')}`;
  }

  ledgerId(orderId: string): string {
    return `led_${orderId}`;
  }
}

export class FakeTokenVerifier implements TokenVerifier {
  /** token → uid. Anything else throws, exactly like a bad Firebase token. */
  readonly tokens = new Map<string, string>();

  constructor(entries: Record<string, string> = { 'token-u1': 'u1' }) {
    for (const [token, uid] of Object.entries(entries)) this.tokens.set(token, uid);
  }

  verify(idToken: string): Promise<{ uid: string }> {
    const uid = this.tokens.get(idToken);
    if (uid === undefined) return Promise.reject(new Error('invalid id token'));
    return Promise.resolve({ uid });
  }
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export class FakeProposalRepo implements ProposalRepo {
  readonly docs = new Map<string, Proposal>();
  readonly transitions: { id: string; from: ProposalStatus; to: ProposalStatus }[] = [];

  constructor(seed: Proposal[] = []) {
    for (const p of seed) this.docs.set(p.id, p);
  }

  put(p: Proposal): void {
    this.docs.set(p.id, p);
  }

  get(id: string): Promise<Proposal | undefined> {
    const p = this.docs.get(id);
    return Promise.resolve(p === undefined ? undefined : { ...p });
  }

  transition(
    id: string,
    from: ProposalStatus,
    to: ProposalStatus,
    patch?: ProposalTransitionPatch,
  ): Promise<ProposalTransitionResult> {
    const current = this.docs.get(id);
    if (current === undefined) return Promise.resolve({ ok: false, reason: 'not-found' });
    if (current.status !== from) {
      return Promise.resolve({ ok: false, reason: 'conflict', current: current.status });
    }
    const next: Proposal = { ...current, status: to };
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    }
    this.docs.set(id, next);
    this.transitions.push({ id, from, to });
    return Promise.resolve({ ok: true, proposal: next });
  }

  listByStatus(uid: string, statuses: readonly ProposalStatus[]): Promise<Proposal[]> {
    return Promise.resolve(
      [...this.docs.values()].filter((p) => p.uid === uid && statuses.includes(p.status)),
    );
  }

  statusOf(id: string): ProposalStatus | undefined {
    return this.docs.get(id)?.status;
  }
}

export class FakeOrderRepo implements OrderRepo {
  readonly docs = new Map<string, OrderRecord>();

  constructor(seed: OrderRecord[] = []) {
    for (const o of seed) this.docs.set(o.id, o);
  }

  create(record: OrderRecord): Promise<void> {
    this.docs.set(record.id, record);
    return Promise.resolve();
  }

  get(id: string): Promise<OrderRecord | undefined> {
    const o = this.docs.get(id);
    return Promise.resolve(o === undefined ? undefined : { ...o });
  }

  patch(id: string, patch: Partial<OrderRecord>): Promise<void> {
    const current = this.docs.get(id);
    if (current !== undefined) this.docs.set(id, { ...current, ...patch });
    return Promise.resolve();
  }

  listOpen(uid: string): Promise<OrderRecord[]> {
    const open = ['SUBMITTED', 'OPEN', 'PARTIAL', 'UNKNOWN'];
    return Promise.resolve(
      [...this.docs.values()].filter((o) => o.uid === uid && open.includes(o.status)),
    );
  }

  findByProposal(uid: string, proposalId: string): Promise<OrderRecord | undefined> {
    return Promise.resolve(
      [...this.docs.values()].find((o) => o.uid === uid && o.proposalId === proposalId),
    );
  }

  listApprovedBetween(uid: string, fromIso: string, toIso: string): Promise<OrderRecord[]> {
    return Promise.resolve(
      [...this.docs.values()].filter(
        (o) => o.uid === uid && o.approvedAt >= fromIso && o.approvedAt < toIso,
      ),
    );
  }
}

export class FakeIdempotencyStore implements IdempotencyStore {
  readonly docs = new Map<string, IdempotencyRecord>();

  /**
   * Atomic create-if-absent. The check and the write happen before any `await`
   * resolves, which is exactly the guarantee the Firestore transaction gives.
   */
  acquire(key: string, proposalId: string, now: Date): Promise<'acquired' | IdempotencyRecord> {
    const existing = this.docs.get(key);
    if (existing !== undefined) return Promise.resolve({ ...existing });
    this.docs.set(key, {
      key,
      proposalId,
      orderId: null,
      status: 'in-progress',
      createdAt: now.toISOString(),
      result: null,
    });
    return Promise.resolve('acquired');
  }

  complete(key: string, orderId: string, result: unknown): Promise<void> {
    const rec = this.docs.get(key);
    if (rec !== undefined) this.docs.set(key, { ...rec, status: 'done', orderId, result });
    return Promise.resolve();
  }

  fail(key: string, result: unknown): Promise<void> {
    const rec = this.docs.get(key);
    if (rec !== undefined) this.docs.set(key, { ...rec, status: 'failed', result });
    return Promise.resolve();
  }

  get(key: string): Promise<IdempotencyRecord | undefined> {
    return Promise.resolve(this.docs.get(key));
  }
}

export class FakeConfigRepo implements ConfigRepo {
  readonly docs = new Map<string, Config>();

  constructor(seed: Config[] = []) {
    for (const c of seed) this.docs.set(c.uid, c);
  }

  get(uid: string): Promise<Config | undefined> {
    const c = this.docs.get(uid);
    return Promise.resolve(c === undefined ? undefined : { ...c });
  }

  patch(uid: string, patch: Partial<Config>): Promise<Config> {
    const current = this.docs.get(uid);
    if (current === undefined) return Promise.reject(new Error(`no config for uid '${uid}'`));
    const next = { ...current, ...patch };
    this.docs.set(uid, next);
    return Promise.resolve(next);
  }
}

export class FakeAuditLog implements AuditLog {
  readonly events: AuditEvent[] = [];

  append(event: AuditEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }

  types(): string[] {
    return this.events.map((e) => e.type);
  }

  byType(type: AuditEvent['type']): AuditEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}

export class FakeSessionStore implements SessionStore {
  readonly docs = new Map<string, BrokerSession>();

  constructor(seed: { uid: string; session: BrokerSession }[] = []) {
    for (const s of seed) this.docs.set(`${s.uid}:${s.session.broker}`, s.session);
  }

  get(uid: string, broker: Broker): Promise<BrokerSession | undefined> {
    return Promise.resolve(this.docs.get(`${uid}:${broker}`));
  }

  set(uid: string, session: BrokerSession): Promise<void> {
    this.docs.set(`${uid}:${session.broker}`, session);
    return Promise.resolve();
  }
}

export class FakeSecretStore implements SecretStore {
  readonly docs = new Map<string, SecretValue>();

  constructor(seed: Record<string, SecretValue> = {}) {
    for (const [name, value] of Object.entries(seed)) this.docs.set(name, value);
  }

  get(name: string): Promise<SecretValue | undefined> {
    return Promise.resolve(this.docs.get(name));
  }

  set(name: string, secret: SecretValue): Promise<void> {
    this.docs.set(name, secret);
    return Promise.resolve();
  }
}

export class FakePortfolioCache implements PortfolioCache {
  readonly writes: { uid: string; snapshot: PortfolioSnapshot; at: string }[] = [];

  write(uid: string, snapshot: PortfolioSnapshot, now: Date): Promise<void> {
    this.writes.push({ uid, snapshot, at: now.toISOString() });
    return Promise.resolve();
  }
}

export class FakeLedgerRepo implements LedgerRepo {
  readonly docs = new Map<string, LedgerEntry>();

  constructor(seed: LedgerEntry[] = []) {
    for (const e of seed) this.docs.set(e.id, e);
  }

  append(entry: LedgerEntry): Promise<void> {
    this.docs.set(entry.id, entry);
    return Promise.resolve();
  }

  remove(_uid: string, entryId: string): Promise<void> {
    this.docs.delete(entryId);
    return Promise.resolve();
  }

  list(uid: string): Promise<LedgerEntry[]> {
    return Promise.resolve([...this.docs.values()].filter((e) => e.uid === uid));
  }
}

export class FakeStrategyDefsRepo implements StrategyDefsRepo {
  readonly docs = new Map<string, StrategyDef>();

  constructor(seed: { uid: string; strategyId: string; def: StrategyDef }[] = []) {
    for (const s of seed) this.docs.set(`${s.uid}:${s.strategyId}`, s.def);
  }

  get(uid: string, strategyId: string): Promise<StrategyDef | undefined> {
    const def = this.docs.get(`${uid}:${strategyId}`);
    return Promise.resolve(def === undefined ? undefined : { ...def });
  }

  patch(uid: string, strategyId: string, patch: StrategyDef): Promise<StrategyDef> {
    const key = `${uid}:${strategyId}`;
    const current = this.docs.get(key);
    if (current === undefined) return Promise.reject(new Error(`no strategy def '${key}'`));
    const next = { ...current, ...patch };
    this.docs.set(key, next);
    return Promise.resolve(next);
  }
}

export class FakeBookRepo implements BookRepo {
  readonly docs = new Map<string, Book>();

  constructor(seed: { uid: string; book: Book }[] = []) {
    for (const s of seed) this.docs.set(`${s.uid}:${s.book.id}`, s.book);
  }

  get(uid: string, bookId: BookId): Promise<Book | undefined> {
    const b = this.docs.get(`${uid}:${bookId}`);
    return Promise.resolve(b === undefined ? undefined : { ...b });
  }

  patch(uid: string, bookId: BookId, patch: Partial<Book>): Promise<void> {
    const key = `${uid}:${bookId}`;
    const current = this.docs.get(key);
    if (current !== undefined) this.docs.set(key, { ...current, ...patch });
    return Promise.resolve();
  }
}

export class FakeDailyAggregates implements DailyAggregates {
  constructor(public value: TodayAggregates = { orderCount: 0, notionalInr: 0 }) {}

  today(): Promise<TodayAggregates> {
    return Promise.resolve(this.value);
  }
}

// ---------------------------------------------------------------------------
// Broker
// ---------------------------------------------------------------------------

export interface FakeAdapterScript {
  broker?: Broker | undefined;
  session?: SessionStatus | undefined;
  quotes?: Quote[] | undefined;
  funds?: Funds | undefined;
  instrument?: InstrumentRef | undefined;
  holdings?: Holding[] | undefined;
  positions?: Position[] | undefined;
  candles?: Candle[] | undefined;
  /** Statuses returned by `getOrder`/`listOrders`, keyed by brokerOrderId. */
  orderStatuses?: Record<string, OrderStatus> | undefined;
  /** Thrown by the matching method instead of returning. */
  throwOn?: Partial<Record<keyof BrokerAdapter, Error>> | undefined;
  /** Ack returned by `placeOrder`; defaults to a synthetic SUBMITTED. */
  ack?: OrderAck | undefined;
}

/** A fully scriptable {@link BrokerAdapter} that records every order call. */
export class FakeBrokerAdapter implements BrokerAdapter {
  readonly broker: Broker;
  readonly placeOrderCalls: { order: NormalizedOrder; idempotencyKey: string }[] = [];
  readonly cancelCalls: string[] = [];
  readonly modifyCalls: { brokerOrderId: string; patch: Partial<NormalizedOrder> }[] = [];
  script: FakeAdapterScript;

  constructor(script: FakeAdapterScript = {}) {
    this.script = script;
    this.broker = script.broker ?? 'dhan';
  }

  #maybeThrow(method: keyof BrokerAdapter): void {
    const err = this.script.throwOn?.[method];
    if (err !== undefined) throw err;
  }

  getSessionStatus(): Promise<SessionStatus> {
    this.#maybeThrow('getSessionStatus');
    return Promise.resolve(this.script.session ?? makeSessionStatus({ broker: this.broker }));
  }

  getHoldings(): Promise<Holding[]> {
    this.#maybeThrow('getHoldings');
    return Promise.resolve(this.script.holdings ?? []);
  }

  getPositions(): Promise<Position[]> {
    this.#maybeThrow('getPositions');
    return Promise.resolve(this.script.positions ?? []);
  }

  getFunds(): Promise<Funds> {
    this.#maybeThrow('getFunds');
    return Promise.resolve(this.script.funds ?? makeFunds());
  }

  resolveInstrument(sym: CanonicalSymbol): Promise<InstrumentRef> {
    this.#maybeThrow('resolveInstrument');
    return Promise.resolve(
      this.script.instrument ?? makeInstrument({ broker: this.broker, canonical: sym }),
    );
  }

  getQuote(syms: CanonicalSymbol[]): Promise<Quote[]> {
    this.#maybeThrow('getQuote');
    if (this.script.quotes !== undefined) return Promise.resolve(this.script.quotes);
    return Promise.resolve(syms.map((s) => makeQuote({ symbol: s })));
  }

  getHistorical(_req: HistoricalRequest): Promise<Candle[]> {
    this.#maybeThrow('getHistorical');
    return Promise.resolve(this.script.candles ?? []);
  }

  placeOrder(order: NormalizedOrder, idempotencyKey: string): Promise<OrderAck> {
    this.placeOrderCalls.push({ order, idempotencyKey });
    this.#maybeThrow('placeOrder');
    return Promise.resolve(
      this.script.ack ?? {
        brokerOrderId: `BRK-${String(this.placeOrderCalls.length).padStart(4, '0')}`,
        status: 'SUBMITTED',
        raw: { accepted: true, symbol: symbolKey(order.symbol) },
      },
    );
  }

  modifyOrder(brokerOrderId: string, patch: Partial<NormalizedOrder>): Promise<OrderAck> {
    this.modifyCalls.push({ brokerOrderId, patch });
    this.#maybeThrow('modifyOrder');
    return Promise.resolve({ brokerOrderId, status: 'SUBMITTED', raw: { modified: true } });
  }

  cancelOrder(brokerOrderId: string): Promise<OrderAck> {
    this.cancelCalls.push(brokerOrderId);
    this.#maybeThrow('cancelOrder');
    return Promise.resolve({ brokerOrderId, status: 'CANCELLED', raw: { cancelled: true } });
  }

  getOrder(brokerOrderId: string): Promise<OrderStatus> {
    this.#maybeThrow('getOrder');
    const status = this.script.orderStatuses?.[brokerOrderId];
    if (status === undefined) {
      return Promise.reject(new BrokerError('UNKNOWN', `no scripted status for ${brokerOrderId}`));
    }
    return Promise.resolve(status);
  }

  listOrders(): Promise<OrderStatus[]> {
    this.#maybeThrow('listOrders');
    return Promise.resolve(Object.values(this.script.orderStatuses ?? {}));
  }
}

export class FakeBrokerGateway implements BrokerGateway {
  adapter: FakeBrokerAdapter;
  session: SessionStatus;
  /** When set, `forUser` rejects with it (e.g. `SessionUnavailableError`). */
  error?: Error | undefined;

  constructor(adapter = new FakeBrokerAdapter(), session?: SessionStatus) {
    this.adapter = adapter;
    this.session = session ?? makeSessionStatus({ broker: adapter.broker });
  }

  forUser(_uid: string): Promise<BrokerContext> {
    if (this.error !== undefined) return Promise.reject(this.error);
    return Promise.resolve({
      broker: this.adapter.broker,
      adapter: this.adapter,
      session: this.session,
    });
  }
}
