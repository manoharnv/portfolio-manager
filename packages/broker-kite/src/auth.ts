/**
 * Kite login / daily re-authentication — docs/02-broker-abstraction.md §2.7, §2.8.
 *
 * The app never sees `api_secret` or the access token: it carries only the
 * short-lived `request_token` to the backend, which does this exchange and
 * stores the resulting access token (Secret Manager). Nothing in this module
 * touches the wall clock — `exchangeRequestToken` takes `now` as a parameter,
 * consistent with docs/00-dev-conventions.md §0.5.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BrokerError } from '@pm/core';
import type { HttpClient } from './http.js';
import { mapTransportError } from './errors.js';
import { KITE_API_VERSION, KITE_BASE_URL, formEncode, parseKiteEnvelope } from './wire.js';

/** SHA-256 hex of `apiKey + requestToken + apiSecret`, per Kite's login flow. */
export function computeChecksum(apiKey: string, requestToken: string, apiSecret: string): string {
  return createHash('sha256')
    .update(apiKey + requestToken + apiSecret, 'utf8')
    .digest('hex');
}

export interface LoginUrlOptions {
  /**
   * Echoed back verbatim on the redirect URL by Kite (`redirect_params`, a
   * URL-encoded `a=b&c=d` string) — the only way to carry a state nonce
   * through the login and tie the redirect to the login that started it.
   */
  redirectParams?: Readonly<Record<string, string>> | undefined;
}

/** The Kite Connect web login URL the app opens (system browser) for the user. */
export function loginUrl(apiKey: string, opts: LoginUrlOptions = {}): string {
  const base = `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(apiKey)}`;
  const extra =
    opts.redirectParams === undefined ? '' : new URLSearchParams(opts.redirectParams).toString();
  return extra === '' ? base : `${base}&redirect_params=${encodeURIComponent(extra)}`;
}

export interface ExchangeRequestTokenParams {
  apiKey: string;
  apiSecret: string;
  requestToken: string;
}

export interface ExchangeRequestTokenResult {
  accessToken: string;
  userId: string;
  /** ISO 8601 — the next 06:00 IST after `now`. */
  expiresAt: string;
  raw: unknown;
}

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The next 06:00 IST strictly after `now` — Kite access tokens expire at
 * ~6am IST regardless of when during the previous day they were issued.
 * Handles "already past 06:00 today" by rolling to tomorrow.
 */
export function nextSixAmIst(now: Date): string {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  let sixAmUtcMs = Date.UTC(y, m, d, 6, 0, 0, 0) - IST_OFFSET_MS;
  if (sixAmUtcMs <= now.getTime()) {
    sixAmUtcMs += ONE_DAY_MS;
  }
  return new Date(sixAmUtcMs).toISOString();
}

const SessionTokenDataSchema = z.looseObject({
  access_token: z.string().min(1),
  user_id: z.string().min(1),
});

/** `POST /session/token` — combine the login's `request_token` with `api_secret`. */
export async function exchangeRequestToken(
  http: HttpClient,
  params: ExchangeRequestTokenParams,
  now: Date,
  baseUrl: string = KITE_BASE_URL,
): Promise<ExchangeRequestTokenResult> {
  const checksum = computeChecksum(params.apiKey, params.requestToken, params.apiSecret);
  const body = formEncode({
    api_key: params.apiKey,
    request_token: params.requestToken,
    checksum,
  });

  let res;
  try {
    res = await http.request({
      method: 'POST',
      url: `${baseUrl}/session/token`,
      headers: {
        'X-Kite-Version': KITE_API_VERSION,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  } catch (err) {
    throw mapTransportError(err);
  }

  const data = parseKiteEnvelope(res);
  const parsed = SessionTokenDataSchema.safeParse(data);
  if (!parsed.success) {
    throw new BrokerError(
      'UNKNOWN',
      `Malformed Kite session/token response: ${parsed.error.message}`,
      data,
    );
  }

  return {
    accessToken: parsed.data.access_token,
    userId: parsed.data.user_id,
    expiresAt: nextSixAmIst(now),
    raw: data,
  };
}

/** A live Kite session — the minimum the adapter needs to make an authenticated call. */
export interface KiteSession {
  apiKey: string;
  accessToken: string;
  /** ISO 8601 token expiry. */
  expiresAt: string;
}

/**
 * `true` when the session is valid at least `marginMs` before its `expiresAt`.
 * A non-parseable `expiresAt` fails closed (`false`).
 */
export function isSessionValid(session: KiteSession, now: Date, marginMs = 0): boolean {
  const expiresAtMs = Date.parse(session.expiresAt);
  if (Number.isNaN(expiresAtMs)) return false;
  return now.getTime() + marginMs < expiresAtMs;
}
