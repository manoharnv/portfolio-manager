/**
 * Registry wiring — docs/02-broker-abstraction.md §2.4.
 *
 * `@pm/broker-kite` has `sideEffects: false`, so registering with core's
 * broker registry must be an explicit call (`registerKiteAdapter()`), never
 * an import-time side effect — otherwise a bundler could tree-shake the
 * registration away, or an unrelated import could silently grant order
 * capability.
 *
 * Session expiry: the default wiring reads the token's expiry from
 * `deps.expiresAt`, else from `BrokerCreds.kite.expiresAt` (docs/02 §2.4 — the
 * backend stores the true expiry alongside the token per §2.8). With neither,
 * it FAILS CLOSED: the session gets an epoch expiry so `getSessionStatus()`
 * reports `connected: false` rather than inventing a future expiry for a token
 * whose lifetime is unknown (docs/00 §0.7.1). Supply `deps.session` to take
 * full control of how the session is obtained on every call.
 */

import {
  registerAdapter,
  registerReadAdapter,
  toReadOnly,
  type BrokerCreds,
  type BrokerReadAdapter,
} from '@pm/core';
import { createFetchHttpClient, type HttpClient } from './http.js';
import { KiteInstrumentMaster } from './instruments.js';
import type { KiteSession } from './auth.js';
import { KiteAdapter } from './adapter.js';

/** Epoch: guarantees `isSessionValid` is false when no real expiry is known. */
const FAIL_CLOSED_EXPIRY = '1970-01-01T00:00:00.000Z';

export interface CreateKiteAdapterDeps {
  http?: HttpClient | undefined;
  instruments?: KiteInstrumentMaster | undefined;
  clock?: (() => Date) | undefined;
  baseUrl?: string | undefined;
  /**
   * True token expiry (ISO 8601), when the caller has it (e.g. from Secret
   * Manager metadata stored alongside the token). Ignored if `session` is
   * also supplied.
   */
  expiresAt?: string | undefined;
  /** Full override for how the adapter obtains its session on every call. */
  session?: (() => KiteSession) | undefined;
}

/**
 * Build a `KiteAdapter` from core's `BrokerCreds` plus whatever this package
 * needs that `BrokerCreds` doesn't carry (HTTP client, instrument master,
 * clock, and — see the module doc — session expiry).
 */
export function createKiteAdapter(creds: BrokerCreds, deps?: CreateKiteAdapterDeps): KiteAdapter {
  const kiteCreds = creds.kite;
  if (kiteCreds === undefined) {
    throw new Error('createKiteAdapter requires BrokerCreds.kite = { apiKey, accessToken }');
  }

  const http = deps?.http ?? createFetchHttpClient();
  const instruments = deps?.instruments ?? new KiteInstrumentMaster();
  const clock = deps?.clock ?? ((): Date => new Date());
  const session =
    deps?.session ??
    ((): KiteSession => ({
      apiKey: kiteCreds.apiKey,
      accessToken: kiteCreds.accessToken,
      // Explicit override → expiry stored with the credentials → fail closed.
      expiresAt: deps?.expiresAt ?? kiteCreds.expiresAt ?? FAIL_CLOSED_EXPIRY,
    }));

  return new KiteAdapter({ http, instruments, clock, session, baseUrl: deps?.baseUrl });
}

/** Read-only facade — see `toReadOnly` in `@pm/core`; no order methods at runtime either. */
export function createKiteReadAdapter(
  creds: BrokerCreds,
  deps?: CreateKiteAdapterDeps,
): BrokerReadAdapter {
  return toReadOnly(createKiteAdapter(creds, deps));
}

export type RegisterKiteAdapterOptions = Omit<CreateKiteAdapterDeps, 'expiresAt' | 'session'>;

/**
 * Register the Kite factories with core's broker registry. Call this once,
 * explicitly, at process start (e.g. the execution backend's bootstrap) —
 * importing this module does nothing by itself.
 */
export function registerKiteAdapter(options?: RegisterKiteAdapterOptions): void {
  registerAdapter('kite', (creds) => createKiteAdapter(creds, options));
  registerReadAdapter('kite', (creds) => createKiteReadAdapter(creds, options));
}
