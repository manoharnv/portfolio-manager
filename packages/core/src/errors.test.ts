import { describe, expect, it } from 'vitest';
import {
  AdapterNotRegisteredError,
  BrokerError,
  NON_RETRYABLE_BROKER_ERROR_KINDS,
  UnsupportedMappingError,
  isBrokerError,
  isRetryableBrokerErrorKind,
  type BrokerErrorKind,
} from './errors.js';

describe('BrokerError', () => {
  it('carries kind and raw payload and is an Error', () => {
    const raw = { code: 'DH-901' };
    const err = new BrokerError('AUTH_EXPIRED', 'token expired', raw);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.kind).toBe('AUTH_EXPIRED');
    expect(err.raw).toBe(raw);
    expect(err.name).toBe('BrokerError');
    expect(err.message).toBe('token expired');
  });

  it('works without a raw payload', () => {
    expect(new BrokerError('NETWORK', 'timeout').raw).toBeUndefined();
  });

  it('isBrokerError narrows only BrokerError instances', () => {
    expect(isBrokerError(new BrokerError('UNKNOWN', 'x'))).toBe(true);
    expect(isBrokerError(new Error('x'))).toBe(false);
    expect(isBrokerError('AUTH_EXPIRED')).toBe(false);
  });

  it('never retries AUTH_EXPIRED or IP_NOT_WHITELISTED', () => {
    expect([...NON_RETRYABLE_BROKER_ERROR_KINDS].sort()).toEqual([
      'AUTH_EXPIRED',
      'IP_NOT_WHITELISTED',
    ]);
    expect(isRetryableBrokerErrorKind('AUTH_EXPIRED')).toBe(false);
    expect(isRetryableBrokerErrorKind('IP_NOT_WHITELISTED')).toBe(false);
  });

  it.each<BrokerErrorKind>([
    'INSUFFICIENT_FUNDS',
    'INSTRUMENT_UNKNOWN',
    'RATE_LIMITED',
    'RISK_REJECTED',
    'NETWORK',
    'UNKNOWN',
  ])('treats %s as retryable', (kind) => {
    expect(isRetryableBrokerErrorKind(kind)).toBe(true);
  });
});

describe('UnsupportedMappingError', () => {
  it('describes an unsupported neutral value', () => {
    const err = new UnsupportedMappingError('kite', 'product', 'MTF', 'to-broker');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('kite does not support product=MTF');
    expect(err.broker).toBe('kite');
    expect(err.field).toBe('product');
    expect(err.direction).toBe('to-broker');
  });

  it('describes an unrecognised broker code', () => {
    const err = new UnsupportedMappingError('dhan', 'orderType', 'WAT', 'from-broker');
    expect(err.message).toContain('Unrecognised dhan orderType code: WAT');
  });
});

describe('AdapterNotRegisteredError', () => {
  it('names the broker, the surface and what is registered', () => {
    const err = new AdapterNotRegisteredError('kite', 'full', ['dhan']);
    expect(err.message).toContain("full (read+write) broker adapter registered for 'kite'");
    expect(err.message).toContain('Registered: [dhan]');
    expect(err.broker).toBe('kite');
    expect(err.surface).toBe('full');
  });

  it('says "none" when nothing is registered', () => {
    expect(new AdapterNotRegisteredError('dhan', 'read', []).message).toContain(
      'Registered: [none]',
    );
  });
});
