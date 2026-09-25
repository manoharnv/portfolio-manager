/**
 * Kite-specific error mapping — docs/02-broker-abstraction.md §2.7 and §2.10.
 *
 * Two kinds of failure reach here:
 *   - a transport failure (fetch threw: network down, DNS, abort/timeout);
 *   - a broker-reported failure (HTTP status + Kite's `{status:'error',
 *     error_type, message}` envelope).
 *
 * Both are normalised to `@pm/core`'s `BrokerError`, never left as raw
 * `Error`/`DOMException` instances, so every caller can switch on `.kind`.
 *
 * `AUTH_EXPIRED` and `IP_NOT_WHITELISTED` are never retried by this adapter —
 * enforced by callers consulting `NON_RETRYABLE_BROKER_ERROR_KINDS` from core,
 * not by anything in this file.
 *
 * A second, deliberately separate error class lives here too:
 * {@link OrderValidationError}. It covers checks *we* perform locally, before
 * any wire call (lot size / tick size) — mirroring core's own split between
 * `BrokerError` (the broker told us) and `UnsupportedMappingError`/
 * `AdapterNotRegisteredError` (decided by us before any wire call happens).
 */

import { BrokerError } from '@pm/core';

/** Fields we can extract from a Kite error envelope, regardless of endpoint. */
export interface KiteErrorInfo {
  httpStatus: number;
  errorType?: string | undefined;
  message?: string | undefined;
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

/**
 * Map an HTTP status + Kite `error_type`/`message` to a typed {@link BrokerError}.
 * Order matters: more specific checks run before the generic fallback.
 */
export function mapKiteError(info: KiteErrorInfo, raw?: unknown): BrokerError {
  const { httpStatus, errorType, message } = info;
  const summary =
    message ??
    `Kite request failed with HTTP ${String(httpStatus)}${errorType !== undefined ? ` (${errorType})` : ''}`;

  // 403 or TokenException → the daily access token is missing/expired.
  if (httpStatus === 403 || errorType === 'TokenException') {
    return new BrokerError('AUTH_EXPIRED', summary, raw);
  }

  // Static-IP rejection. Kite doesn't have a single dedicated error_type for
  // this; go by message content.
  if (message !== undefined && includesAny(message, ['whitelist'])) {
    return new BrokerError('IP_NOT_WHITELISTED', summary, raw);
  }

  // 429, or a NetworkException whose message is clearly about rate limiting.
  if (httpStatus === 429) {
    return new BrokerError('RATE_LIMITED', summary, raw);
  }
  if (
    errorType === 'NetworkException' &&
    message !== undefined &&
    includesAny(message, ['rate limit', 'too many requests'])
  ) {
    return new BrokerError('RATE_LIMITED', summary, raw);
  }

  // Insufficient funds/margin.
  if (
    message !== undefined &&
    includesAny(message, ['insufficient funds', 'insufficient margin', 'insufficient balance'])
  ) {
    return new BrokerError('INSUFFICIENT_FUNDS', summary, raw);
  }

  // Broker-side RMS / order rejection.
  if (
    errorType === 'OrderException' ||
    (message !== undefined && includesAny(message, ['rms', 'risk management']))
  ) {
    return new BrokerError('RISK_REJECTED', summary, raw);
  }

  // Unknown/invalid instrument.
  if (
    message !== undefined &&
    includesAny(message, [
      'unknown instrument',
      'invalid instrument',
      'instrument not found',
      'no such instrument',
    ])
  ) {
    return new BrokerError('INSTRUMENT_UNKNOWN', summary, raw);
  }

  // InputException and anything else we don't specifically recognise.
  return new BrokerError('UNKNOWN', summary, raw);
}

/**
 * Map a transport-level failure (the `HttpClient` call itself threw — network
 * down, DNS failure, `AbortError` from a timeout) to `BrokerError('NETWORK', ...)`.
 */
export function mapTransportError(err: unknown): BrokerError {
  if (err instanceof BrokerError) return err; // already mapped upstream; do not double-wrap
  const name =
    err !== null && typeof err === 'object' ? (err as { name?: unknown }).name : undefined;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new BrokerError('NETWORK', 'Kite request timed out or was aborted', err);
  }
  return new BrokerError(
    'NETWORK',
    `Kite network request failed: ${describeTransportError(err)}`,
    err,
  );
}

/** `fetch failed` plus the `cause` it hides (ECONNREFUSED, ENETUNREACH, EAI_AGAIN, …). */
export function describeTransportError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause =
    err !== null && typeof err === 'object' ? (err as { cause?: unknown }).cause : undefined;
  if (cause === null || typeof cause !== 'object') return message;
  const { code, message: causeMessage } = cause as { code?: unknown; message?: unknown };
  const parts = [
    typeof code === 'string' ? code : undefined,
    typeof causeMessage === 'string' && causeMessage !== message ? causeMessage : undefined,
  ].filter((p): p is string => p !== undefined);
  return parts.length === 0 ? message : `${message} (${parts.join(': ')})`;
}

/** Which local, pre-flight order check failed. */
export type OrderValidationReason = 'LOT_SIZE' | 'TICK_SIZE';

/**
 * A `NormalizedOrder` fails a check *we* enforce locally (quantity not a
 * multiple of lot size, or a price not on the tick grid) — decided before any
 * wire call, so this is never a `BrokerError`.
 */
export class OrderValidationError extends Error {
  readonly reason: OrderValidationReason;

  constructor(reason: OrderValidationReason, message: string) {
    super(message);
    this.name = 'OrderValidationError';
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
