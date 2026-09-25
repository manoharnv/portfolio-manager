/**
 * Registration with core's adapter registry (docs/02 §2.4).
 *
 * Registration is an **explicit call**, not an import side-effect: the package
 * is `sideEffects: false`, and a module that silently grants a process the
 * ability to place orders is exactly what docs/00 §0.7.4's read/write split
 * exists to prevent. The execution backend calls `registerDhanAdapter(...)`
 * once at start-up; the strategy engine never does.
 */

import {
  BrokerError,
  registerAdapter,
  registerReadAdapter,
  toReadOnly,
  type BrokerCreds,
  type BrokerReadAdapter,
} from '@pm/core';
import { DhanAdapter, type DhanAdapterDeps } from './adapter.js';
import type { DhanSession } from './auth.js';
import { createFetchHttpClient, type HttpClient } from './http.js';
import type { DhanInstrumentMaster } from './instruments.js';

/** The process-wide pieces an adapter needs that credentials do not carry. */
export interface DhanFactoryDeps {
  /** Loaded and refreshed daily by the caller (docs/02 §2.9). */
  instruments: DhanInstrumentMaster;
  /** Defaults to a `fetch`-backed client. */
  http?: HttpClient | undefined;
  /** Defaults to `() => new Date()`; tests inject a fixed instant. */
  clock?: (() => Date) | undefined;
  baseUrl?: string | undefined;
  /**
   * Turns credentials into a session *with an expiry*.
   *
   * By default the session is read straight off `BrokerCreds.dhan`, including
   * its optional `expiresAt` (docs/02 §2.4). When the credentials carry no
   * expiry, the adapter has none to report and `getSessionStatus()` answers
   * `connected: false` — fail closed rather than assume a token is live. The
   * backend, which stores the daily token and its expiry in Secret Manager,
   * either passes `expiresAt` in the creds or supplies this resolver.
   */
  session?: ((creds: BrokerCreds) => DhanSession) | undefined;
  enrichPortfolioPrices?: boolean | undefined;
  sessionMarginMs?: number | undefined;
  timeoutMs?: number | undefined;
}

function dhanCreds(creds: BrokerCreds): DhanSession {
  if (creds.broker !== 'dhan') {
    throw new BrokerError('UNKNOWN', `Expected dhan credentials, got broker='${creds.broker}'`);
  }
  const dhan = creds.dhan;
  if (dhan === undefined || dhan.clientId.trim() === '' || dhan.accessToken.trim() === '') {
    throw new BrokerError(
      'AUTH_EXPIRED',
      'No Dhan session: creds.dhan must carry a clientId and a daily accessToken',
    );
  }
  const session: DhanSession = { clientId: dhan.clientId, accessToken: dhan.accessToken };
  if (dhan.expiresAt !== undefined) session.expiresAt = dhan.expiresAt;
  return session;
}

function toAdapterDeps(creds: BrokerCreds, deps: DhanFactoryDeps): DhanAdapterDeps {
  const resolve = deps.session ?? ((c: BrokerCreds): DhanSession => dhanCreds(c));
  // Validate eagerly so a missing token fails at construction, not mid-order.
  dhanCreds(creds);
  const adapterDeps: DhanAdapterDeps = {
    http: deps.http ?? createFetchHttpClient(),
    session: () => resolve(creds),
    instruments: deps.instruments,
    clock: deps.clock ?? ((): Date => new Date()),
  };
  if (deps.baseUrl !== undefined) adapterDeps.baseUrl = deps.baseUrl;
  if (deps.enrichPortfolioPrices !== undefined) {
    adapterDeps.enrichPortfolioPrices = deps.enrichPortfolioPrices;
  }
  if (deps.sessionMarginMs !== undefined) adapterDeps.sessionMarginMs = deps.sessionMarginMs;
  if (deps.timeoutMs !== undefined) adapterDeps.timeoutMs = deps.timeoutMs;
  return adapterDeps;
}

/** Full read+write adapter. **Execution backend only.** */
export function createDhanAdapter(creds: BrokerCreds, deps: DhanFactoryDeps): DhanAdapter {
  return new DhanAdapter(toAdapterDeps(creds, deps));
}

/**
 * Read-only facade — the object itself has no order methods at runtime, so a
 * structural cast cannot recover `placeOrder` (docs/00 §0.7.4).
 */
export function createDhanReadAdapter(
  creds: BrokerCreds,
  deps: DhanFactoryDeps,
): BrokerReadAdapter {
  return toReadOnly(createDhanAdapter(creds, deps));
}

/**
 * Register `'dhan'` with core's registry so `createAdapter({broker:'dhan', …})`
 * and `createReadAdapter(…)` resolve to this package. Idempotent: calling it
 * again replaces the factories.
 */
export function registerDhanAdapter(deps: DhanFactoryDeps): void {
  registerAdapter('dhan', (creds) => createDhanAdapter(creds, deps));
  registerReadAdapter('dhan', (creds) => createDhanReadAdapter(creds, deps));
}
