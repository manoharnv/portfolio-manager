import { describe, expect, it } from 'vitest';
import { BrokerError, isRetryableBrokerErrorKind } from '@pm/core';
import { OrderValidationError, mapKiteError, mapTransportError } from './errors.js';

describe('mapKiteError', () => {
  it('maps HTTP 403 to AUTH_EXPIRED', () => {
    const err = mapKiteError({ httpStatus: 403, message: 'Invalid session' });
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.kind).toBe('AUTH_EXPIRED');
    expect(err.message).toBe('Invalid session');
  });

  it('maps error_type TokenException to AUTH_EXPIRED regardless of status', () => {
    const err = mapKiteError({
      httpStatus: 400,
      errorType: 'TokenException',
      message: 'token expired',
    });
    expect(err.kind).toBe('AUTH_EXPIRED');
  });

  it('checks AUTH_EXPIRED before IP_NOT_WHITELISTED: a 403 wins even with whitelist text', () => {
    const err = mapKiteError({
      httpStatus: 403,
      message: 'Sorry, your IP address is not whitelisted.',
    });
    expect(err.kind).toBe('AUTH_EXPIRED');
  });

  it('maps an IP-whitelist message (non-403) to IP_NOT_WHITELISTED', () => {
    const err = mapKiteError({ httpStatus: 400, message: 'IP not whitelisted for this app' });
    expect(err.kind).toBe('IP_NOT_WHITELISTED');
  });

  it('maps HTTP 429 to RATE_LIMITED', () => {
    const err = mapKiteError({ httpStatus: 429, message: 'Too many requests' });
    expect(err.kind).toBe('RATE_LIMITED');
  });

  it('maps a NetworkException with rate-limit text to RATE_LIMITED', () => {
    const err = mapKiteError({
      httpStatus: 500,
      errorType: 'NetworkException',
      message: 'Too many requests, please try later',
    });
    expect(err.kind).toBe('RATE_LIMITED');
  });

  it('does not treat every NetworkException as rate limiting', () => {
    const err = mapKiteError({
      httpStatus: 500,
      errorType: 'NetworkException',
      message: 'gateway down',
    });
    expect(err.kind).toBe('UNKNOWN');
  });

  it('maps insufficient funds/margin text to INSUFFICIENT_FUNDS', () => {
    expect(
      mapKiteError({ httpStatus: 400, message: 'Insufficient funds to place order' }).kind,
    ).toBe('INSUFFICIENT_FUNDS');
    expect(mapKiteError({ httpStatus: 400, message: 'Insufficient margin available' }).kind).toBe(
      'INSUFFICIENT_FUNDS',
    );
  });

  it('maps OrderException to RISK_REJECTED', () => {
    const err = mapKiteError({
      httpStatus: 400,
      errorType: 'OrderException',
      message: 'RMS blocked order',
    });
    expect(err.kind).toBe('RISK_REJECTED');
  });

  it('maps RMS text without OrderException to RISK_REJECTED', () => {
    const err = mapKiteError({ httpStatus: 400, message: 'Blocked by risk management system' });
    expect(err.kind).toBe('RISK_REJECTED');
  });

  it('maps unknown-instrument text to INSTRUMENT_UNKNOWN', () => {
    const err = mapKiteError({ httpStatus: 400, message: 'Invalid instrument specified' });
    expect(err.kind).toBe('INSTRUMENT_UNKNOWN');
  });

  it('falls back to UNKNOWN for InputException and anything unrecognised', () => {
    expect(
      mapKiteError({ httpStatus: 400, errorType: 'InputException', message: 'bad param' }).kind,
    ).toBe('UNKNOWN');
    expect(mapKiteError({ httpStatus: 500 }).kind).toBe('UNKNOWN');
  });

  it('carries the raw payload through', () => {
    const raw = { status: 'error', error_type: 'InputException' };
    expect(mapKiteError({ httpStatus: 400, errorType: 'InputException' }, raw).raw).toBe(raw);
  });

  it('synthesises a message when Kite sends none', () => {
    const err = mapKiteError({ httpStatus: 500, errorType: 'GeneralException' });
    expect(err.message).toContain('500');
    expect(err.message).toContain('GeneralException');
  });

  it('never marks AUTH_EXPIRED or IP_NOT_WHITELISTED as retryable (core.isRetryableBrokerErrorKind)', () => {
    const authExpired = mapKiteError({ httpStatus: 403 });
    const ipBlocked = mapKiteError({ httpStatus: 400, message: 'IP not whitelisted' });
    expect(authExpired.kind).toBe('AUTH_EXPIRED');
    expect(ipBlocked.kind).toBe('IP_NOT_WHITELISTED');
    expect(isRetryableBrokerErrorKind(authExpired.kind)).toBe(false);
    expect(isRetryableBrokerErrorKind(ipBlocked.kind)).toBe(false);
  });

  it('marks every other mapped kind as retryable', () => {
    const retryableCases: KiteErrorInfoLike[] = [
      { httpStatus: 429 },
      { httpStatus: 400, message: 'Insufficient funds' },
      { httpStatus: 400, errorType: 'OrderException' },
      { httpStatus: 400, message: 'unknown instrument' },
      { httpStatus: 500 },
    ];
    for (const info of retryableCases) {
      expect(isRetryableBrokerErrorKind(mapKiteError(info).kind)).toBe(true);
    }
  });
});

type KiteErrorInfoLike = Parameters<typeof mapKiteError>[0];

describe('mapTransportError', () => {
  it('maps an AbortError to NETWORK', () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    const err = mapTransportError(abort);
    expect(err.kind).toBe('NETWORK');
    expect(err.raw).toBe(abort);
  });

  it('maps a TimeoutError to NETWORK', () => {
    const timeout = new DOMException('timed out', 'TimeoutError');
    expect(mapTransportError(timeout).kind).toBe('NETWORK');
  });

  it('surfaces the cause fetch hides behind "fetch failed"', () => {
    const cause = Object.assign(new Error('getaddrinfo EAI_AGAIN api.kite.trade'), {
      code: 'EAI_AGAIN',
    });
    const err = mapTransportError(new TypeError('fetch failed', { cause }));
    expect(err.message).toBe(
      'Kite network request failed: fetch failed (EAI_AGAIN: getaddrinfo EAI_AGAIN api.kite.trade)',
    );
  });

  it('maps a generic Error to NETWORK, keeping the message', () => {
    const err = mapTransportError(new TypeError('fetch failed'));
    expect(err.kind).toBe('NETWORK');
    expect(err.message).toContain('fetch failed');
  });

  it('maps a non-Error thrown value to NETWORK', () => {
    const err = mapTransportError('a plain string failure');
    expect(err.kind).toBe('NETWORK');
    expect(err.message).toContain('a plain string failure');
  });

  it('does not double-wrap an already-mapped BrokerError', () => {
    const original = new BrokerError('INSUFFICIENT_FUNDS', 'not enough cash');
    expect(mapTransportError(original)).toBe(original);
  });

  it('NETWORK is retryable (core.isRetryableBrokerErrorKind)', () => {
    expect(isRetryableBrokerErrorKind(mapTransportError(new TypeError('down')).kind)).toBe(true);
  });
});

describe('OrderValidationError', () => {
  it('is a typed Error carrying its reason', () => {
    const err = new OrderValidationError('LOT_SIZE', 'quantity 7 is not a multiple of lot size 10');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('OrderValidationError');
    expect(err.reason).toBe('LOT_SIZE');
    expect(err.message).toContain('lot size');
  });
});
