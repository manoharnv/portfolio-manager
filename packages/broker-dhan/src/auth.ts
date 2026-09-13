/**
 * Dhan daily token lifecycle — docs/02 §2.6 and §2.8.
 *
 * Dhan's API key+secret is a one-year credential from which a **24-hour access
 * token** is minted; the backend renews it once per trading day. This module is
 * the machine half of that flow.
 *
 * The *interactive* half — opening Dhan's consent screen in the app, carrying
 * the consent/`request_token` back to the backend and exchanging it with the
 * api_secret — is deliberately NOT implemented here: the app must never see the
 * secret or the token (docs/02 §2.8). The hook point for it is
 * {@link DhanSession}: whatever performs the consent exchange writes the
 * resulting session into Secret Manager, and the adapter is constructed with a
 * `() => DhanSession` accessor that reads it back.
 */

import { BrokerError, SESSION_EXPIRY_MARGIN_SECONDS, type SessionStatus } from '@pm/core';
import { dhanParseError } from './errors.js';
import type { HttpClient } from './http.js';
import { DHAN_BASE_URL, dhanHeaders, dhanTimeToIso, ensureOk, decodeJson } from './wire.js';

/** A minted daily session. `expiresAt` absent ⇒ unknown ⇒ treated as invalid. */
export interface DhanSession {
  clientId: string;
  accessToken: string;
  /** ISO-8601 with offset. */
  expiresAt?: string | undefined;
}

export interface DhanCredentials {
  clientId: string;
  accessToken: string;
}

export interface RenewedToken {
  accessToken: string;
  /** ISO-8601 with offset. */
  expiresAt: string;
}

/** Dhan's daily token is SEBI-aligned at 24h (docs/02 §2.6). */
export const DHAN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Default safety margin before expiry, shared with core's guardrails. */
export const DEFAULT_SESSION_MARGIN_MS = SESSION_EXPIRY_MARGIN_SECONDS * 1000;

export interface RenewTokenOptions {
  baseUrl?: string | undefined;
  /**
   * Required only when Dhan's response carries no expiry of its own: the TTL is
   * then measured from this instant. Nothing here reads the clock (docs/00 §0.5).
   */
  now?: Date | undefined;
  timeoutMs?: number | undefined;
}

const TOKEN_KEYS = ['accessToken', 'access_token', 'token', 'jwt'] as const;
const EXPIRY_KEYS = [
  'expiresAt',
  'expires_at',
  'expiryTime',
  'expiry_time',
  'tokenValidity',
  'validTill',
  'expiry',
] as const;

function readExpiry(value: unknown, context: string): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return dhanTimeToIso(value, context);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e11 ? value : value * 1000;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) {
      throw dhanParseError(context, `implausible expiry ${String(value)}`, value);
    }
    return date.toISOString();
  }
  return undefined;
}

/**
 * `POST /v2/RenewToken` — mint today's access token from the long-lived one.
 *
 * VERIFY-LIVE: the request body (none is sent here), the response field names,
 * and whether Dhan returns an expiry at all. When it does not, the 24h TTL is
 * measured from `opts.now`, and omitting both is an error rather than a guess.
 */
export async function renewToken(
  http: HttpClient,
  creds: DhanCredentials,
  opts: RenewTokenOptions = {},
): Promise<RenewedToken> {
  const context = 'renew token';
  const baseUrl = opts.baseUrl ?? DHAN_BASE_URL;
  const res = await http.request({
    method: 'POST',
    url: `${baseUrl}/RenewToken`,
    headers: dhanHeaders(creds),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  ensureOk(res, context);
  const raw = decodeJson(res, context);
  if (typeof raw !== 'object' || raw === null) {
    throw dhanParseError(context, 'expected a JSON object', raw);
  }
  const body = raw as Record<string, unknown>;
  const nested = body['data'];
  const source: Record<string, unknown> =
    typeof nested === 'object' && nested !== null ? { ...body, ...nested } : body;

  let accessToken: string | undefined;
  for (const key of TOKEN_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      accessToken = value.trim();
      break;
    }
  }
  if (accessToken === undefined) {
    throw dhanParseError(context, `no access token field (tried ${TOKEN_KEYS.join(', ')})`, raw);
  }

  let expiresAt: string | undefined;
  for (const key of EXPIRY_KEYS) {
    expiresAt = readExpiry(source[key], context);
    if (expiresAt !== undefined) break;
  }
  if (expiresAt === undefined) {
    if (opts.now === undefined) {
      throw new BrokerError(
        'UNKNOWN',
        'Dhan renew token: response carries no expiry and no `now` was supplied to derive one',
        raw,
      );
    }
    expiresAt = new Date(opts.now.getTime() + DHAN_TOKEN_TTL_MS).toISOString();
  }
  return { accessToken, expiresAt };
}

/**
 * `true` only when the session demonstrably has more than `marginMs` left.
 * Unknown or unparseable expiry ⇒ `false` (docs/00 §0.7.1: no session is a
 * failure, never a skip).
 */
export function isSessionValid(
  session: DhanSession,
  now: Date,
  marginMs: number = DEFAULT_SESSION_MARGIN_MS,
): boolean {
  if (session.accessToken.trim().length === 0) return false;
  if (session.expiresAt === undefined) return false;
  const expiry = Date.parse(session.expiresAt);
  if (Number.isNaN(expiry)) return false;
  return expiry - now.getTime() > marginMs;
}

/** The neutral session view handed to the app (docs/02 §2.2). */
export function describeSession(
  session: DhanSession,
  now: Date,
  marginMs: number = DEFAULT_SESSION_MARGIN_MS,
): SessionStatus {
  const status: SessionStatus = {
    broker: 'dhan',
    connected: isSessionValid(session, now, marginMs),
  };
  if (session.expiresAt !== undefined) status.expiresAt = session.expiresAt;
  return status;
}
