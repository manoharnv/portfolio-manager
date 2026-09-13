/**
 * dry-run / paper order simulator — docs/04 §4.8.
 *
 * "`adapter.placeOrder` is swapped for a simulator that returns a synthetic ack
 * and simulates a fill at live LTP after a delay. Everything else — guardrails,
 * idempotency, audit, Firestore writes, app UX — is identical."
 *
 * Two deliberate properties:
 *   - **Reads are real.** Quotes, funds, holdings and the instrument master come
 *     from the wrapped read adapter, so a dry run exercises the same live data
 *     the guardrails would see in prod.
 *   - **No timers.** A fill becomes visible once the *injected clock* has passed
 *     `submittedAt + fillAfterMs`. Tests advance the clock; nothing sleeps.
 */

import { BrokerError } from '@pm/core';
import type {
  Broker,
  BrokerAdapter,
  BrokerReadAdapter,
  Candle,
  CanonicalSymbol,
  Funds,
  HistoricalRequest,
  Holding,
  InstrumentRef,
  NormalizedOrder,
  OrderAck,
  OrderStatus,
  OrderStatusCode,
  Position,
  Quote,
  SessionStatus,
} from '@pm/core';
import type { Clock } from './ports/index.js';

export interface SimulatorDeps {
  /** Where every read delegates. In prod-shaped wiring this is the real adapter. */
  read: BrokerReadAdapter;
  clock: Clock;
  /** Delay from ack to fill, measured on the injected clock. */
  fillAfterMs: number;
  /** Prefix for synthetic broker order ids. */
  idPrefix?: string | undefined;
}

interface SimOrder {
  brokerOrderId: string;
  order: NormalizedOrder;
  submittedAtMs: number;
  /** Set when the order was cancelled before its fill instant. */
  cancelledAtMs?: number | undefined;
  idempotencyKey: string;
}

const SIMULATED = { simulated: true } as const;

/**
 * The order half of {@link BrokerAdapter}, simulated; the read half delegates.
 * Used whenever `environment !== 'prod'` (docs/04 §4.8) — `paper` uses it too
 * unless a real sandbox adapter is registered for the broker.
 */
export class SimulatedOrderExecutor implements BrokerAdapter {
  readonly broker: Broker;

  readonly #read: BrokerReadAdapter;
  readonly #clock: Clock;
  readonly #fillAfterMs: number;
  readonly #prefix: string;
  readonly #orders = new Map<string, SimOrder>();
  #seq = 0;

  constructor(deps: SimulatorDeps) {
    this.#read = deps.read;
    this.#clock = deps.clock;
    this.#fillAfterMs = Math.max(0, deps.fillAfterMs);
    this.#prefix = deps.idPrefix ?? 'SIM';
    this.broker = deps.read.broker;
  }

  // --- reads: delegate verbatim ------------------------------------------

  getSessionStatus(): Promise<SessionStatus> {
    return this.#read.getSessionStatus();
  }
  getHoldings(): Promise<Holding[]> {
    return this.#read.getHoldings();
  }
  getPositions(): Promise<Position[]> {
    return this.#read.getPositions();
  }
  getFunds(): Promise<Funds> {
    return this.#read.getFunds();
  }
  resolveInstrument(sym: CanonicalSymbol): Promise<InstrumentRef> {
    return this.#read.resolveInstrument(sym);
  }
  getQuote(syms: CanonicalSymbol[]): Promise<Quote[]> {
    return this.#read.getQuote(syms);
  }
  getHistorical(req: HistoricalRequest): Promise<Candle[]> {
    return this.#read.getHistorical(req);
  }

  // --- orders: simulated --------------------------------------------------

  placeOrder(order: NormalizedOrder, idempotencyKey: string): Promise<OrderAck> {
    this.#seq += 1;
    const brokerOrderId = `${this.#prefix}-${String(this.#seq).padStart(6, '0')}`;
    this.#orders.set(brokerOrderId, {
      brokerOrderId,
      order,
      submittedAtMs: this.#clock.now().getTime(),
      idempotencyKey,
    });
    return Promise.resolve({
      brokerOrderId,
      status: 'SUBMITTED' as OrderStatusCode,
      raw: { ...SIMULATED, brokerOrderId, idempotencyKey, fillAfterMs: this.#fillAfterMs },
    });
  }

  async modifyOrder(brokerOrderId: string, patch: Partial<NormalizedOrder>): Promise<OrderAck> {
    const sim = this.#require(brokerOrderId);
    const status = await this.getOrder(brokerOrderId);
    if (status.status === 'COMPLETE' || status.status === 'CANCELLED') {
      throw new BrokerError(
        'RISK_REJECTED',
        `Simulated order ${brokerOrderId} is ${status.status} and cannot be modified`,
        { ...SIMULATED, brokerOrderId },
      );
    }
    sim.order = { ...sim.order, ...patch };
    return { brokerOrderId, status: 'SUBMITTED', raw: { ...SIMULATED, modified: true } };
  }

  async cancelOrder(brokerOrderId: string): Promise<OrderAck> {
    const sim = this.#require(brokerOrderId);
    const status = await this.getOrder(brokerOrderId);
    if (status.status === 'COMPLETE') {
      throw new BrokerError(
        'RISK_REJECTED',
        `Simulated order ${brokerOrderId} already filled — nothing to cancel`,
        { ...SIMULATED, brokerOrderId },
      );
    }
    sim.cancelledAtMs ??= this.#clock.now().getTime();
    return { brokerOrderId, status: 'CANCELLED', raw: { ...SIMULATED, cancelled: true } };
  }

  async getOrder(brokerOrderId: string): Promise<OrderStatus> {
    return this.#resolve(this.#require(brokerOrderId));
  }

  async listOrders(): Promise<OrderStatus[]> {
    const out: OrderStatus[] = [];
    for (const sim of this.#orders.values()) {
      out.push(await this.#resolve(sim));
    }
    return out;
  }

  // --- internals ----------------------------------------------------------

  #require(brokerOrderId: string): SimOrder {
    const sim = this.#orders.get(brokerOrderId);
    if (sim === undefined) {
      throw new BrokerError('UNKNOWN', `Unknown simulated order id '${brokerOrderId}'`, {
        ...SIMULATED,
        brokerOrderId,
      });
    }
    return sim;
  }

  /**
   * Derive the current status from the clock. A fill needs a live LTP: with no
   * usable quote the order simply stays OPEN rather than inventing a price —
   * the same fail-closed rule the guardrails use.
   */
  async #resolve(sim: SimOrder): Promise<OrderStatus> {
    const nowMs = this.#clock.now().getTime();
    const fillAtMs = sim.submittedAtMs + this.#fillAfterMs;
    const updatedAt = new Date(nowMs).toISOString();
    const base = {
      brokerOrderId: sim.brokerOrderId,
      filledQty: 0,
      pendingQty: sim.order.quantity,
      updatedAt,
      raw: { ...SIMULATED, submittedAtMs: sim.submittedAtMs, fillAtMs },
    };

    if (sim.cancelledAtMs !== undefined && sim.cancelledAtMs < fillAtMs) {
      return { ...base, status: 'CANCELLED', pendingQty: 0 };
    }
    if (nowMs < fillAtMs) {
      return { ...base, status: nowMs === sim.submittedAtMs ? 'SUBMITTED' : 'OPEN' };
    }

    const price = await this.#fillPrice(sim.order);
    if (price === undefined) return { ...base, status: 'OPEN' };
    return {
      ...base,
      status: 'COMPLETE',
      filledQty: sim.order.quantity,
      pendingQty: 0,
      avgPrice: price,
      raw: { ...SIMULATED, filledAtMs: fillAtMs, avgPrice: price },
    };
  }

  async #fillPrice(order: NormalizedOrder): Promise<number | undefined> {
    let quotes: Quote[];
    try {
      quotes = await this.#read.getQuote([order.symbol]);
    } catch {
      return undefined;
    }
    const ltp = quotes[0]?.ltp;
    if (typeof ltp !== 'number' || !Number.isFinite(ltp) || ltp <= 0) return undefined;
    return ltp;
  }
}
