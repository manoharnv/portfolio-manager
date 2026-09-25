/**
 * Dhan's API-key consent flow — the machine half of the daily login
 * (docs/02 §2.8; DhanHQ v2 docs → Authentication → "API Key & Secret").
 *
 * Three legs. Two are HTTP calls that carry the app secret and are therefore
 * made *only* by the execution backend; the middle one is the user's browser:
 *
 *   1. {@link generateConsent}  POST {auth}/app/generate-consent?client_id=…  → consentAppId
 *   2. the browser              GET  {auth}/login/consentApp-login?consentAppId=…
 *                               — the user signs in on Dhan's own page; Dhan then
 *                               redirects to the app's registered Redirect URL
 *                               with `?tokenId=…`
 *   3. {@link consumeConsent}   GET  {auth}/app/consumeApp-consent?tokenId=…    → accessToken (24h)
 *
 * The API key + secret are the one-year credential from "Generate new API Key"
 * on web.dhan.co; the access token they mint is the 24-hour one every other
 * call in this package uses. Nothing here reads the clock or the environment
 * and the transport is injected (docs/00 §0.5).
 *
 * VERIFY-LIVE (docs/11 §11.1): paths, header names and response fields are
 * transcribed from the docs and not yet exercised against auth.dhan.co.
 */

import { BrokerError } from '@pm/core';
import { DHAN_TOKEN_TTL_MS, EXPIRY_KEYS, readExpiry } from './auth.js';
import { dhanParseError } from './errors.js';
import type { HttpClient } from './http.js';
import { decodeJson, ensureOk } from './wire.js';

export const DHAN_AUTH_BASE_URL = 'https://auth.dhan.co';

/** The one-year API key + secret generated on web.dhan.co. */
export interface DhanAppCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface ConsentOptions {
  authBaseUrl?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface ConsentStart {
  consentAppId: string;
  /** Where to send the user's browser. */
  loginUrl: string;
}

export interface ConsumedConsent {
  accessToken: string;
  /** ISO-8601 with offset. */
  expiresAt: string;
  /**
   * The `dhanClientId` Dhan says the token belongs to. Callers MUST compare it
   * with the client id they configured — a consent completed by any other Dhan
   * account must never become this backend's session.
   */
  clientId: string;
  clientName?: string | undefined;
}

const TOKEN_KEYS = ['accessToken', 'access_token', 'token', 'jwt'] as const;
const CONSENT_ID_KEYS = ['consentAppId', 'consent_app_id'] as const;
const CLIENT_ID_KEYS = ['dhanClientId', 'clientId', 'client_id'] as const;
const CLIENT_NAME_KEYS = ['dhanClientName', 'clientName'] as const;

function appHeaders(app: DhanAppCredentials): Record<string, string> {
  return { app_id: app.apiKey, app_secret: app.apiSecret };
}

/** Body, with a `{ data: {…} }` wrapper flattened over it when present. */
function unwrap(raw: unknown, context: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) {
    throw dhanParseError(context, 'expected a JSON object', raw);
  }
  const body = raw as Record<string, unknown>;
  const nested = body['data'];
  return typeof nested === 'object' && nested !== null
    ? { ...body, ...(nested as Record<string, unknown>) }
    : body;
}

function optionalString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * Like {@link optionalString} but throws. The error carries only the field
 * names present, never the values — the body may hold a live token.
 */
function requiredString(
  source: Record<string, unknown>,
  keys: readonly string[],
  context: string,
  what: string,
): string {
  const value = optionalString(source, keys);
  if (value === undefined) {
    throw dhanParseError(context, `no ${what} field (tried ${keys.join(', ')})`, {
      fields: Object.keys(source),
    });
  }
  return value;
}

/** Leg 2's URL — where the app opens the system browser. */
export function consentLoginUrl(
  consentAppId: string,
  authBaseUrl: string = DHAN_AUTH_BASE_URL,
): string {
  return `${authBaseUrl}/login/consentApp-login?consentAppId=${encodeURIComponent(consentAppId)}`;
}

/**
 * Leg 1: `POST /app/generate-consent?client_id={dhanClientId}` with the app
 * key/secret as headers. Dhan allows at most 25 of these per day; a consent
 * is valid until its tokenId is generated.
 */
export async function generateConsent(
  http: HttpClient,
  app: DhanAppCredentials,
  clientId: string,
  opts: ConsentOptions = {},
): Promise<ConsentStart> {
  const context = 'generate consent';
  const base = opts.authBaseUrl ?? DHAN_AUTH_BASE_URL;
  const res = await http.request({
    method: 'POST',
    url: `${base}/app/generate-consent?client_id=${encodeURIComponent(clientId)}`,
    headers: appHeaders(app),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  ensureOk(res, context);
  const source = unwrap(decodeJson(res, context), context);
  const consentAppId = requiredString(source, CONSENT_ID_KEYS, context, 'consent id');
  return { consentAppId, loginUrl: consentLoginUrl(consentAppId, base) };
}

/**
 * Leg 3: `GET /app/consumeApp-consent?tokenId=…` with the app key/secret as
 * headers. Returns the minted 24h token, its expiry (`expiryTime`, an IST
 * wall-clock time — normalised to ISO with offset) and the owning client id.
 *
 * When Dhan sends no expiry the 24h TTL is measured from `opts.now`; omitting
 * both is an error rather than a guess (docs/02 §2.4 — an unknown expiry has
 * to fail closed).
 */
export async function consumeConsent(
  http: HttpClient,
  app: DhanAppCredentials,
  tokenId: string,
  opts: ConsentOptions & { now?: Date | undefined } = {},
): Promise<ConsumedConsent> {
  const context = 'consume consent';
  const base = opts.authBaseUrl ?? DHAN_AUTH_BASE_URL;
  const res = await http.request({
    method: 'GET',
    url: `${base}/app/consumeApp-consent?tokenId=${encodeURIComponent(tokenId)}`,
    headers: appHeaders(app),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  ensureOk(res, context);
  const source = unwrap(decodeJson(res, context), context);

  const accessToken = requiredString(source, TOKEN_KEYS, context, 'access token');
  const clientId = requiredString(source, CLIENT_ID_KEYS, context, 'client id');

  let expiresAt: string | undefined;
  for (const key of EXPIRY_KEYS) {
    expiresAt = readExpiry(source[key], context);
    if (expiresAt !== undefined) break;
  }
  if (expiresAt === undefined) {
    if (opts.now === undefined) {
      throw new BrokerError(
        'UNKNOWN',
        'Dhan consume consent: response carries no expiry and no `now` was supplied to derive one',
        { fields: Object.keys(source) },
      );
    }
    expiresAt = new Date(opts.now.getTime() + DHAN_TOKEN_TTL_MS).toISOString();
  }

  const clientName = optionalString(source, CLIENT_NAME_KEYS);
  return {
    accessToken,
    expiresAt,
    clientId,
    ...(clientName === undefined ? {} : { clientName }),
  };
}
