/**
 * Daily broker login — docs/06 §6.3 (5) and §6.7.
 *
 * The whole point of this module is what it does *not* do: the app never holds
 * a broker credential. It asks the backend for a login URL (only the backend
 * has the api key) and opens it in the system auth session. What comes back in
 * the redirect decides the rest:
 *
 *   - Both brokers' login pages send the browser to the backend
 *     (`GET /v1/auth/:broker/redirect` — Kite requires an http(s) redirect URL
 *     anyway), which does the exchange itself and only then bounces the browser
 *     here with `?status=ok&expiresAt=…` or `?status=error&reason=…`. The app
 *     just reads the verdict.
 *   - Should a redirect ever land in the app directly with a short-lived Kite
 *     `request_token`, it is POSTed straight to `/v1/auth/kite/callback` and
 *     dropped.
 *
 * Nothing is written to SecureStore, AsyncStorage or a log on the way through.
 */
import * as WebBrowser from 'expo-web-browser';
import type { Broker } from '@pm/core';
import type { ApiClient, ApiFailure } from './api';
import { brokerLoginUrlTemplate, brokerRedirectUrl } from './env';

export type BrokerLoginResult =
  | { ok: true; broker: Broker; expiresAt: string }
  | { ok: false; reason: 'CANCELLED'; detail: string }
  | { ok: false; reason: 'NO_REQUEST_TOKEN'; detail: string }
  | { ok: false; reason: 'LOGIN_FAILED'; detail: string }
  | ({ ok: false } & Omit<ApiFailure, 'ok'>);

function redirectParams(redirectUrl: string): URLSearchParams[] {
  const query = redirectUrl.includes('?') ? redirectUrl.slice(redirectUrl.indexOf('?') + 1) : '';
  const fragment = redirectUrl.includes('#') ? redirectUrl.slice(redirectUrl.indexOf('#') + 1) : '';
  return [query, fragment].filter((s) => s !== '').map((s) => new URLSearchParams(s));
}

/**
 * Kite redirects with `?request_token=…&action=login&status=success`. The
 * parameter name is read leniently (both snake and camel) because a broker
 * changing the casing must not silently look like "no token".
 */
export function extractRequestToken(redirectUrl: string): string | undefined {
  for (const params of redirectParams(redirectUrl)) {
    for (const key of ['request_token', 'requestToken', 'requestId']) {
      const value = params.get(key);
      if (value !== null && value !== '') return value;
    }
  }
  return undefined;
}

export type ServerCompletion =
  { status: 'ok'; expiresAt: string } | { status: 'error'; reason: string };

/**
 * A login the backend finished by itself (Dhan): the redirect carries the
 * verdict, not a token. `undefined` when the redirect is not of that kind.
 */
export function extractServerCompletion(redirectUrl: string): ServerCompletion | undefined {
  for (const params of redirectParams(redirectUrl)) {
    const status = params.get('status');
    if (status === 'ok') {
      const expiresAt = params.get('expiresAt');
      return expiresAt === null || expiresAt === ''
        ? { status: 'error', reason: 'MALFORMED_REDIRECT' }
        : { status: 'ok', expiresAt };
    }
    if (status === 'error') {
      return { status: 'error', reason: params.get('reason') ?? 'UNKNOWN' };
    }
  }
  return undefined;
}

/** Backend redirect reasons (apps/backend services/session.ts) in plain words. */
export function describeServerReason(reason: string): string {
  switch (reason) {
    case 'NO_PENDING_LOGIN':
      return 'the login took too long or was not started from this app — tap Connect and try again';
    case 'CLIENT_MISMATCH':
      return 'the broker account that signed in is not the one configured for this backend';
    case 'STATE_MISMATCH':
      return 'the broker reply did not belong to the login this app started — tap Connect and try again';
    case 'EXCHANGE_FAILED':
      return 'the broker did not accept the login — try again';
    case 'SECRET_MISSING':
      return 'the backend has no API key / secret configured for this broker';
    case 'INVALID_REQUEST':
      return 'the broker redirected without a login token — try again';
    default:
      return `the broker login failed (${reason})`;
  }
}

export interface BrokerLoginDeps {
  api: ApiClient;
  /** Injected in tests. */
  openAuthSession?:
    | ((url: string, redirect: string) => Promise<WebBrowser.WebBrowserAuthSessionResult>)
    | undefined;
}

async function resolveLoginUrl(api: ApiClient, broker: Broker): Promise<string | ApiFailure> {
  const result = await api.loginUrl(broker);
  if (result.ok) return result.url;

  // Degraded path only (docs/06 §6.6): a locally-configured template lets you
  // reach the broker's login page when the backend is unreachable. The callback
  // still has to go through the backend, so this cannot complete a login alone.
  const template = brokerLoginUrlTemplate(broker);
  if (template !== undefined) return template;
  return result;
}

/** Runs the whole flow. Returns the backend's `expiresAt` on success. */
export async function runBrokerLogin(
  broker: Broker,
  deps: BrokerLoginDeps,
): Promise<BrokerLoginResult> {
  const resolved = await resolveLoginUrl(deps.api, broker);
  if (typeof resolved !== 'string') return resolved;

  const redirect = brokerRedirectUrl();
  const open = deps.openAuthSession ?? WebBrowser.openAuthSessionAsync;
  const session = await open(resolved, redirect);

  if (session.type !== 'success') {
    return {
      ok: false,
      reason: 'CANCELLED',
      detail: 'the broker login was closed before it finished — no session was created',
    };
  }

  // Server-completed (Dhan): the verdict is in the redirect, nothing to send.
  const completion = extractServerCompletion(session.url);
  if (completion !== undefined) {
    return completion.status === 'ok'
      ? { ok: true, broker, expiresAt: completion.expiresAt }
      : { ok: false, reason: 'LOGIN_FAILED', detail: describeServerReason(completion.reason) };
  }

  const requestToken = extractRequestToken(session.url);
  if (requestToken === undefined) {
    return {
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
