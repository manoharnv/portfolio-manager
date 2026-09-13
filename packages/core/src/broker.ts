/**
 * The broker interface — docs/02-broker-abstraction.md §2.3 and §2.4.
 *
 * The read/write split is a HARD requirement, not a convention:
 *   - the strategy engine is handed a {@link BrokerReadAdapter}; the type has no
 *     `placeOrder`, so there is nothing for it to call;
 *   - the execution backend is the only caller of {@link createAdapter}.
 *
 * `createReadAdapter` additionally returns a *runtime* facade that forwards only
 * the read methods, so even a structural cast cannot recover `placeOrder` from
 * the object the strategy engine holds.
 */

import type {
  Broker,
  CanonicalSymbol,
  Candle,
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
} from './domain.js';
import { AdapterNotRegisteredError } from './errors.js';

/** Read-only surface — safe to hand to the strategy engine. */
export interface BrokerReadAdapter {
  readonly broker: Broker;
  getSessionStatus(): Promise<SessionStatus>;

  // portfolio
  getHoldings(): Promise<Holding[]>;
  getPositions(): Promise<Position[]>;
  getFunds(): Promise<Funds>;

  // market data
  resolveInstrument(sym: CanonicalSymbol): Promise<InstrumentRef>;
  getQuote(syms: CanonicalSymbol[]): Promise<Quote[]>;
  getHistorical(req: HistoricalRequest): Promise<Candle[]>;
}

/** Full surface — only constructed inside the execution backend. */
export interface BrokerAdapter extends BrokerReadAdapter {
  placeOrder(order: NormalizedOrder, idempotencyKey: string): Promise<OrderAck>;
  modifyOrder(brokerOrderId: string, patch: Partial<NormalizedOrder>): Promise<OrderAck>;
  cancelOrder(brokerOrderId: string): Promise<OrderAck>;
  getOrder(brokerOrderId: string): Promise<OrderStatus>;
  listOrders(): Promise<OrderStatus[]>;
}

/**
 * Resolved from Secret Manager at runtime; shapes differ per broker.
 * Never persisted to Firestore, never logged, never sent to the app.
 */
export interface BrokerCreds {
  broker: Broker;
  /**
   * `expiresAt` is the ISO expiry of the daily access token, stored alongside it
   * (docs/02 §2.8). Without it an adapter cannot observe true expiry and must
   * report `connected: false` — fail closed, never assume a token is live.
   */
  dhan?: { clientId: string; accessToken: string; expiresAt?: string | undefined } | undefined;
  kite?: { apiKey: string; accessToken: string; expiresAt?: string | undefined } | undefined;
}

export type ReadAdapterFactory = (creds: BrokerCreds) => BrokerReadAdapter;
export type AdapterFactory = (creds: BrokerCreds) => BrokerAdapter;

interface Registration {
  read?: ReadAdapterFactory;
  full?: AdapterFactory;
}

const registry = new Map<Broker, Registration>();

function entry(broker: Broker): Registration {
  let reg = registry.get(broker);
  if (reg === undefined) {
    reg = {};
    registry.set(broker, reg);
  }
  return reg;
}

/**
 * Register a read-only adapter implementation. Adapter packages call this at
 * import time (`@pm/broker-dhan` registers `'dhan'`, etc.).
 */
export function registerReadAdapter(broker: Broker, factory: ReadAdapterFactory): void {
  entry(broker).read = factory;
}

/**
 * Register a full (read+write) adapter implementation. Importing a module that
 * calls this is what gives a process order capability — keep it out of the
 * strategy engine's dependency graph.
 */
export function registerAdapter(broker: Broker, factory: AdapterFactory): void {
  entry(broker).full = factory;
}

/** Test/bootstrap helper: drop one broker's registrations. */
export function unregisterBroker(broker: Broker): void {
  registry.delete(broker);
}

/** Test/bootstrap helper: drop every registration. */
export function clearBrokerRegistry(): void {
  registry.clear();
}

/** Brokers with a registered implementation of the given surface. */
export function registeredBrokers(surface: 'read' | 'full' = 'read'): Broker[] {
  const out: Broker[] = [];
  for (const [broker, reg] of registry) {
    if (
      surface === 'full' ? reg.full !== undefined : reg.read !== undefined || reg.full !== undefined
    ) {
      out.push(broker);
    }
  }
  return out.sort();
}

/**
 * Narrow a full adapter down to the read surface at *runtime* — the returned
 * object simply has no order methods on it.
 */
export function toReadOnly(adapter: BrokerAdapter | BrokerReadAdapter): BrokerReadAdapter {
  return {
    broker: adapter.broker,
    getSessionStatus: () => adapter.getSessionStatus(),
    getHoldings: () => adapter.getHoldings(),
    getPositions: () => adapter.getPositions(),
    getFunds: () => adapter.getFunds(),
    resolveInstrument: (sym) => adapter.resolveInstrument(sym),
    getQuote: (syms) => adapter.getQuote(syms),
    getHistorical: (req) => adapter.getHistorical(req),
  };
}

/** Build the read-only adapter for `creds.broker`. Safe for the strategy engine. */
export function createReadAdapter(creds: BrokerCreds): BrokerReadAdapter {
  const reg = registry.get(creds.broker);
  if (reg?.read !== undefined) {
    return reg.read(creds);
  }
  if (reg?.full !== undefined) {
    // Only a full implementation exists: hand back a facade, never the object
    // that can place orders.
    return toReadOnly(reg.full(creds));
  }
  throw new AdapterNotRegisteredError(creds.broker, 'read', registeredBrokers('read'));
}

/** Build the full adapter for `creds.broker`. **Execution backend only.** */
export function createAdapter(creds: BrokerCreds): BrokerAdapter {
  const reg = registry.get(creds.broker);
  if (reg?.full === undefined) {
    throw new AdapterNotRegisteredError(creds.broker, 'full', registeredBrokers('full'));
  }
  return reg.full(creds);
}
