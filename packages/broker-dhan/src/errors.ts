/**
 * HTTP status + Dhan error payload ⇒ `BrokerError` (docs/02 §2.10).
 *
 * Two rules drive every decision here:
 *   1. **Fail closed.** Anything we cannot confidently classify is `UNKNOWN`,
 *      which callers must treat as "the order may or may not exist".
 *   2. **`AUTH_EXPIRED` and `IP_NOT_WHITELISTED` are never retried.** The adapter
 *      contains no retry loop at all; {@link isRetryableError} exists so a caller
 *      that adds one cannot get those two wrong.
 *
 * Dhan returns errors in more than one envelope, so the payload reader below is
 * deliberately tolerant about *shape* while the classifier stays explicit about
 * *meaning*.
 */

import { BrokerError, isRetryableBrokerErrorKind, type BrokerErrorKind } from '@pm/core';
import type { HttpResponse } from './http.js';

/** Everything we could learn from a Dhan error body, plus the body itself. */
export interface DhanErrorInfo {
  code?: string | undefined;
  message?: string | undefined;
  /** Parsed JSON when the body was JSON, else the raw text. */
  raw: unknown;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
}

function pick(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const found = str(source[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

const CODE_KEYS = ['errorCode', 'error_code', 'errorType', 'error_type', 'code'] as const;
const MESSAGE_KEYS = [
  'errorMessage',
  'error_message',
  'errorType',
  'message',
  'remarks',
  'description',
  'internalErrorMessage',
] as const;

/**
 * Read `{errorCode, errorType, errorMessage}`, the order-API
 * `{status:'failed', remarks:{error_code, error_message}}` envelope, or a bare
 * text body. Never throws: a classifier must work even on garbage.
 */
export function parseDhanErrorInfo(bodyText: string): DhanErrorInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    const text = bodyText.trim();
    return text.length > 0 ? { message: text, raw: bodyText } : { raw: bodyText };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { message: str(parsed), raw: parsed };
  }

  const top = parsed as Record<string, unknown>;
  const remarks = top['remarks'];
  const nested: Record<string, unknown> =
    typeof remarks === 'object' && remarks !== null ? (remarks as Record<string, unknown>) : {};

  const code = pick(nested, CODE_KEYS) ?? pick(top, CODE_KEYS);
  const message = pick(nested, MESSAGE_KEYS) ?? pick(top, MESSAGE_KEYS);

  const info: DhanErrorInfo = { raw: parsed };
  if (code !== undefined) info.code = code;
  if (message !== undefined) info.message = message;
  return info;
}

const has = (haystack: string, ...needles: readonly string[]): boolean =>
  needles.some((n) => haystack.includes(n));

/**
 * DhanHQ documented error codes (docs/02 §2.10 maps them onto our taxonomy).
 * VERIFY-LIVE: confirm the DH-9xx code list and that `errorCode` is the field
 * carrying it on every endpoint (order APIs nest it under `remarks`).
 */
export const DHAN_ERROR_CODES = {
  INVALID_AUTHENTICATION: 'DH-901',
  INVALID_ACCESS: 'DH-902',
  INVALID_AUTHORIZATION: 'DH-903',
  RATE_LIMIT: 'DH-904',
  INPUT_EXCEPTION: 'DH-905',
  ORDER_ERROR: 'DH-906',
  DATA_ERROR: 'DH-907',
  INTERNAL_SERVER_ERROR: 'DH-908',
  NETWORK_ERROR: 'DH-909',
  OTHERS: 'DH-910',
} as const;

/**
 * Decide the kind. Precedence matters: the two non-retryable kinds are checked
 * first so a message that mentions both an IP problem and an auth problem is
 * classified as the one that must stop the pipeline.
 */
export function classifyDhanError(status: number, info: DhanErrorInfo): BrokerErrorKind {
  const code = (info.code ?? '').toUpperCase();
  const text = `${info.code ?? ''} ${info.message ?? ''}`.toLowerCase();

  // 1. Static-IP rejection — order APIs only, never retried.
  if (
    has(text, 'whitelist', 'white list', 'white-list', 'static ip', 'ip address', 'ip not') ||
    /\bip\b.*\b(not allowed|blocked|mismatch|register)/.test(text)
  ) {
    return 'IP_NOT_WHITELISTED';
  }

  // 2. Token invalid/expired — never retried; re-login instead.
  if (
    code === DHAN_ERROR_CODES.INVALID_AUTHENTICATION ||
    code === DHAN_ERROR_CODES.INVALID_AUTHORIZATION ||
    code === 'INVALID_AUTHENTICATION' ||
    code === 'INVALID_AUTHORIZATION' ||
    has(
      text,
      'access token',
      'token is invalid',
      'invalid token',
      'token expired',
      'expired token',
      'invalid authentication',
      'unauthorized',
      'unauthorised',
    ) ||
    status === 401 ||
    status === 403
  ) {
    return 'AUTH_EXPIRED';
  }

  if (
    status === 429 ||
    code === DHAN_ERROR_CODES.RATE_LIMIT ||
    has(text, 'rate limit', 'too many')
  ) {
    return 'RATE_LIMITED';
  }

  if (
    has(text, 'insufficient', 'not enough', 'margin shortfall', 'shortage of fund', 'low balance')
  ) {
    return 'INSUFFICIENT_FUNDS';
  }

  if (
    has(
      text,
      'security id',
      'securityid',
      'invalid security',
      'unknown security',
      'instrument not found',
      'invalid instrument',
      'symbol not found',
      'scrip not found',
    )
  ) {
    return 'INSTRUMENT_UNKNOWN';
  }

  if (
    has(text, 'rms', 'risk management', 'blocked for trading', 'not allowed to trade', 'freeze')
  ) {
    return 'RISK_REJECTED';
  }

  if (code === DHAN_ERROR_CODES.NETWORK_ERROR || has(text, 'network error')) {
    return 'NETWORK';
  }

  return 'UNKNOWN';
}

/** Build the `BrokerError` for a non-2xx Dhan response. `context` names the call site. */
export function dhanHttpError(res: HttpResponse, context: string): BrokerError {
  const info = parseDhanErrorInfo(res.bodyText);
  const kind = classifyDhanError(res.status, info);
  const detail =
    info.message ?? (res.bodyText.trim().length > 0 ? res.bodyText.trim() : '(no body)');
  const code = info.code === undefined ? '' : ` [${info.code}]`;
  return new BrokerError(
    kind,
    `Dhan ${context} failed (HTTP ${res.status})${code}: ${detail}`,
    info.raw,
  );
}

/**
 * A Dhan response that was 2xx but is not something we can turn into a domain
 * object. Never a partially-filled result — docs/02 §2.1's "ambiguous ⇒ throw".
 */
export function dhanParseError(context: string, detail: string, raw: unknown): BrokerError {
  return new BrokerError('UNKNOWN', `Dhan ${context}: malformed response — ${detail}`, raw);
}

/**
 * `false` for `AUTH_EXPIRED` / `IP_NOT_WHITELISTED` (docs/02 §2.10) and for
 * anything that is not a `BrokerError` at all.
 */
export function isRetryableError(err: unknown): boolean {
  return err instanceof BrokerError && isRetryableBrokerErrorKind(err.kind);
}
