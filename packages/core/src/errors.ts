/**
 * Typed error taxonomy — docs/02-broker-abstraction.md §2.10.
 *
 * `BrokerError` describes something *the broker told us* (or a transport failure
 * talking to it). Two local, pre-flight failures get their own classes because
 * they are decided by us before any wire call happens:
 *   - {@link UnsupportedMappingError} — a neutral enum has no code on this broker
 *     (e.g. MTF on Kite).
 *   - {@link AdapterNotRegisteredError} — no adapter implementation is registered.
 */

import type { Broker } from './domain.js';

export type BrokerErrorKind =
  /** Token invalid/expired → refuse, prompt re-login. */
  | 'AUTH_EXPIRED'
  /** Static-IP rejection → alert, do not retry blindly. */
  | 'IP_NOT_WHITELISTED'
  | 'INSUFFICIENT_FUNDS'
  | 'INSTRUMENT_UNKNOWN'
  | 'RATE_LIMITED'
  /** Broker-side RMS rejection. */
  | 'RISK_REJECTED'
  | 'NETWORK'
  | 'UNKNOWN';

export class BrokerError extends Error {
  readonly kind: BrokerErrorKind;
  readonly raw?: unknown;

  constructor(kind: BrokerErrorKind, message: string, raw?: unknown) {
    super(message);
    this.name = 'BrokerError';
    this.kind = kind;
    this.raw = raw;
    // Keep `instanceof` working when the output is down-levelled.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Kinds that must NEVER be silently retried (docs/02 §2.10): they surface to the
 * app and the audit log immediately.
 */
export const NON_RETRYABLE_BROKER_ERROR_KINDS: readonly BrokerErrorKind[] = [
  'AUTH_EXPIRED',
  'IP_NOT_WHITELISTED',
];

export function isBrokerError(err: unknown): err is BrokerError {
  return err instanceof BrokerError;
}

/** `true` when an error of this kind may be retried by an automated caller. */
export function isRetryableBrokerErrorKind(kind: BrokerErrorKind): boolean {
  return !NON_RETRYABLE_BROKER_ERROR_KINDS.includes(kind);
}

/** Which neutral enum failed to map. */
export type MappingField = 'product' | 'orderType' | 'exchangeSegment' | 'validity';

/**
 * A neutral value has no equivalent on the target broker (e.g. `MTF` on Kite), or
 * a broker code is not one we recognise. Thrown, never returned as `undefined`,
 * so a mis-mapped order can never reach the wire as a silent default.
 */
export class UnsupportedMappingError extends Error {
  readonly broker: Broker;
  readonly field: MappingField;
  readonly value: string;
  readonly direction: 'to-broker' | 'from-broker';

  constructor(
    broker: Broker,
    field: MappingField,
    value: string,
    direction: 'to-broker' | 'from-broker',
  ) {
    super(
      direction === 'to-broker'
        ? `${broker} does not support ${field}=${value}`
        : `Unrecognised ${broker} ${field} code: ${value}`,
    );
    this.name = 'UnsupportedMappingError';
    this.broker = broker;
    this.field = field;
    this.value = value;
    this.direction = direction;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** No adapter implementation has registered itself for this broker. */
export class AdapterNotRegisteredError extends Error {
  readonly broker: Broker;
  readonly surface: 'read' | 'full';

  constructor(broker: Broker, surface: 'read' | 'full', registered: readonly Broker[]) {
    super(
      `No ${surface === 'full' ? 'full (read+write)' : 'read'} broker adapter registered for ` +
        `'${broker}'. Registered: [${registered.join(', ') || 'none'}]. ` +
        `Import the adapter package (e.g. @pm/broker-${broker}) so it can register itself.`,
    );
    this.name = 'AdapterNotRegisteredError';
    this.broker = broker;
    this.surface = surface;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
