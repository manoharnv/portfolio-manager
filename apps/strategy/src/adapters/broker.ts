/**
 * Port implementations over a **`BrokerReadAdapter`** (docs/02 §2.3).
 *
 * This is the entire broker surface the strategy engine has. `createReadAdapter`
 * / `createDhanReadAdapter` / `createKiteReadAdapter` return objects with no
 * order methods on them at runtime, and nothing in this file could call one if
 * they did (docs/05 §5.1).
 */

import type { BrokerReadAdapter, Broker, CanonicalSymbol, InstrumentRef, Quote } from '@pm/core';
import { symbolKey } from '@pm/core';
import type {
  MarketData,
  PortfolioSnapshot,
  PortfolioSource,
  SessionStatusSource,
} from '../ports/index.js';

export function createBrokerPortfolioSource(read: BrokerReadAdapter): PortfolioSource {
  return {
    async snapshot(): Promise<PortfolioSnapshot> {
      const [holdings, positions, funds] = await Promise.all([
        read.getHoldings(),
        read.getPositions(),
        read.getFunds(),
      ]);
      return { holdings, positions, funds };
    },
  };
}

export function createBrokerMarketData(read: BrokerReadAdapter): MarketData {
  return {
    async quotes(symbols): Promise<Map<string, Quote>> {
      if (symbols.length === 0) return new Map();
      const quotes = await read.getQuote([...symbols]);
      return new Map(quotes.map((q) => [symbolKey(q.symbol), q]));
    },
    historical: (req) => read.getHistorical(req),
    async instrument(symbol: CanonicalSymbol): Promise<InstrumentRef | undefined> {
      try {
        return await read.resolveInstrument(symbol);
      } catch {
        // Unresolvable ⇒ no lot/tick evidence ⇒ `tickLotValidity` fails closed.
        return undefined;
      }
    },
  };
}

export function createBrokerSessionSource(read: BrokerReadAdapter): SessionStatusSource {
  return {
    async status(_uid: string, broker: Broker) {
      if (read.broker !== broker) return undefined;
      try {
        return await read.getSessionStatus();
      } catch {
        return undefined;
      }
    },
  };
}
