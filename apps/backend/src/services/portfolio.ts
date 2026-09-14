/**
 * `GET /v1/portfolio/holdings|positions|funds` — docs/04 §4.3, docs/03 §3.6.
 *
 * The app reads the *cache*; this service is what refreshes it, from the live
 * adapter, on a timer and on demand. A read failure never falls back to a stale
 * value silently: the caller is told the refresh failed and may then decide to
 * serve the cache.
 */

import { BrokerError } from '@pm/core';
import type { BrokerErrorKind } from '@pm/core';
import type { AuditWriter } from './audit.js';
import type { BrokerGateway, Clock, PortfolioCache, PortfolioSnapshot } from '../ports/index.js';
import { SessionUnavailableError } from '../ports/index.js';

export type PortfolioResult =
  | { ok: true; snapshot: PortfolioSnapshot; at: string }
  | {
      ok: false;
      reason: 'SESSION_INVALID' | 'BROKER_ERROR';
      detail: string;
      brokerErrorKind?: BrokerErrorKind | undefined;
    };

export interface PortfolioDeps {
  broker: BrokerGateway;
  cache: PortfolioCache;
  clock: Clock;
  audit?: AuditWriter | undefined;
}

export interface PortfolioService {
  /** Fetch live, write the cache, return the snapshot. */
  refresh(uid: string): Promise<PortfolioResult>;
}

export function createPortfolioService(deps: PortfolioDeps): PortfolioService {
  return {
    async refresh(uid: string): Promise<PortfolioResult> {
      let ctx;
      try {
        ctx = await deps.broker.forUser(uid);
      } catch (err) {
        const detail =
          err instanceof SessionUnavailableError
            ? err.message
            : `broker unavailable: ${String(err)}`;
        return { ok: false, reason: 'SESSION_INVALID', detail };
      }

      try {
        const [holdings, positions, funds] = await Promise.all([
          ctx.adapter.getHoldings(),
          ctx.adapter.getPositions(),
          ctx.adapter.getFunds(),
        ]);
        const snapshot: PortfolioSnapshot = { holdings, positions, funds };
        const now = deps.clock.now();
        await deps.cache.write(uid, snapshot, now);
        return { ok: true, snapshot, at: now.toISOString() };
      } catch (err) {
        const kind: BrokerErrorKind = err instanceof BrokerError ? err.kind : 'UNKNOWN';
        const detail = err instanceof Error ? err.message : String(err);
        if (kind === 'AUTH_EXPIRED') {
          await deps.audit?.record({
            uid,
            type: 'session.expired',
            detail: { source: 'portfolio-refresh', detail },
          });
          return { ok: false, reason: 'SESSION_INVALID', detail, brokerErrorKind: kind };
        }
        return { ok: false, reason: 'BROKER_ERROR', detail, brokerErrorKind: kind };
      }
    },
  };
}
