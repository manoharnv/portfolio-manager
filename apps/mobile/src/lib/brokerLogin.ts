/**
 * Daily broker login — docs/06 §6.3 (5) and §6.7.
 *
 * The whole point of this module is what it does *not* do: the app never holds
 * a broker credential. It asks the backend for a login URL (only the backend
 * has the api key), opens it in the system auth session, pulls the short-lived
 * `request_token` out of the redirect, POSTs it straight to
 * `/v1/auth/:broker/callback`, and drops it. Nothing is written to SecureStore,
 * AsyncStorage or a log on the way through.
 */
import * as WebBrowser from 'expo-web-browser';
import type { Broker } from '@pm/core';
import type { ApiClient, ApiFailure } from './api';
import { brokerLoginUrlTemplate, brokerRedirectUrl } from './env';

export type BrokerLoginResult =
  | { ok: true; broker: Broker; expiresAt: string }
  | { ok: false; reason: 'CANCELLED'; detail: string }
  | { ok: false; reason: 'NO_REQUEST_TOKEN'; detail: string }
  | { ok: false; reason: 'VERIFY_LIVE'; detail: string }
  | ({ ok: false } & Omit<ApiFailure, 'ok'>);

/**
 * Kite redirects with `?request_token=…&action=login&status=success`. The
 * parameter name is read leniently (both snake and camel) because a broker
 * changing the casing must not silently look like "no token".
 */
export function extractRequestToken(redirectUrl: string): string | undefined {
  const query = redirectUrl.includes('?') ? redirectUrl.slice(redirectUrl.indexOf('?') + 1) : '';
  const fragment = redirectUrl.includes('#') ? redirectUrl.slice(redirectUrl.indexOf('#') + 1) : '';
  for (const source of [query, fragment]) {
    if (source === '') continue;
    const params = new URLSearchParams(source);
    for (const key of ['request_token', 'requestToken', 'requestId']) {
      const value = params.get(key);
      if (value !== null && value !== '') return value;
    }
  }
  return undefined;
}

export interface BrokerLoginDeps {
  api: ApiClient;
  /** Injected in tests. */
  openAuthSession?:
    | ((url: string, redirect: string) => Promise<WebBrowser.WebBrowserAuthSessionResult>)
    | undefined;
}

async function resolveLoginUrl(
  api: ApiClient,
  broker: Broker,
): Promise<{ url: string; verifyLive: boolean } | ApiFailure> {
  const result = await api.loginUrl(broker);
  if (result.ok) return { url: result.url, verifyLive: result.verifyLive };

  // Degraded path only (docs/06 §6.6): a locally-configured template lets you
  // reach the broker's login page when the backend is unreachable. The callback
  // still has to go through the backend, so this cannot complete a login alone.
  const template = brokerLoginUrlTemplate(broker);
  if (template !== undefined) return { url: template, verifyLive: true };
  return result;
}

/**
 * Runs the whole flow. Returns the backend's `expiresAt` on success.
 *
 * Dhan is deliberately not completed here: its consent flow mints a *long-lived
 * access token* outside this process (apps/backend/src/services/session.ts,
 * `DHAN_CONSENT_URL_TEMPLATE`, `verifyLive: true`). Forwarding that through the
 * app would put a broker secret in the app, which docs/06 §6.7 forbids. The
 * consent page is opened and the flow stops there until the redirect shape is
 * confirmed against Dhan's partner docs — see README "VERIFY-LIVE".
 */
export async function runBrokerLogin(
  broker: Broker,
  deps: BrokerLoginDeps,
): Promise<BrokerLoginResult> {
  const resolved = await resolveLoginUrl(deps.api, broker);
  if ('ok' in resolved) return resolved;

  const redirect = brokerRedirectUrl();
  const open = deps.openAuthSession ?? WebBrowser.openAuthSessionAsync;
  const session = await open(resolved.url, redirect);

  if (session.type !== 'success') {
    return {
      ok: false,
      reason: 'CANCELLED',
      detail: 'the broker login was closed before it finished — no session was created',
    };
  }

  const requestToken = extractRequestToken(session.url);
  if (requestToken === undefined) {
    return resolved.verifyLive
      ? {
          ok: false,
          reason: 'VERIFY_LIVE',
          detail:
            `${broker}'s redirect carried no request_token. Its consent flow mints the ` +
            'access token outside the app, and the app will not carry a broker secret. ' +
            'Confirm the redirect shape against the broker docs before enabling this.',
        }
      : {
          ok: false,
          reason: 'NO_REQUEST_TOKEN',
          detail: 'the broker redirect carried no request_token — nothing was sent',
        };
  }

  // Forwarded immediately; never persisted, never logged.
  const callback = await deps.api.completeLogin(broker, { requestToken });
  if (!callback.ok) return callback;
  return { ok: true, broker, expiresAt: callback.expiresAt };
}
