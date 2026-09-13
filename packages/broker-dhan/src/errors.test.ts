import { BrokerError, NON_RETRYABLE_BROKER_ERROR_KINDS, type BrokerErrorKind } from '@pm/core';
import { describe, expect, it } from 'vitest';
import {
  classifyDhanError,
  dhanHttpError,
  dhanParseError,
  isRetryableError,
  parseDhanErrorInfo,
} from './errors.js';
import type { HttpResponse } from './http.js';
import {
  DHAN_AUTH_ERROR,
  DHAN_FUNDS_ERROR,
  DHAN_INSTRUMENT_ERROR,
  DHAN_IP_ERROR,
  DHAN_RATE_LIMIT_ERROR,
  DHAN_RMS_ERROR,
  jsonResponse,
  textResponse,
} from './test-utils.js';

const res = (status: number, body: unknown): HttpResponse => jsonResponse(status, body);

describe('parseDhanErrorInfo', () => {
  it('reads the flat {errorCode, errorMessage} envelope', () => {
    const info = parseDhanErrorInfo(JSON.stringify(DHAN_AUTH_ERROR));
    expect(info.code).toBe('DH-901');
    expect(info.message).toBe(DHAN_AUTH_ERROR.errorMessage);
  });

  it('reads the nested order-API {status:failed, remarks:{…}} envelope', () => {
    const info = parseDhanErrorInfo(JSON.stringify(DHAN_FUNDS_ERROR));
    expect(info.code).toBe('DH-906');
    expect(info.message).toBe('Insufficient funds to place this order');
  });

  it('keeps a non-JSON body as the message', () => {
    const info = parseDhanErrorInfo('<html>502 Bad Gateway</html>');
    expect(info.message).toBe('<html>502 Bad Gateway</html>');
    expect(info.code).toBeUndefined();
  });

  it('never throws on an empty or scalar body', () => {
    expect(parseDhanErrorInfo('')).toEqual({ raw: '' });
    expect(parseDhanErrorInfo('"boom"').message).toBe('boom');
    expect(parseDhanErrorInfo('null').raw).toBeNull();
  });
});

describe('classifyDhanError — one case per BrokerErrorKind', () => {
  const cases: [BrokerErrorKind, number, unknown][] = [
    ['AUTH_EXPIRED', 401, DHAN_AUTH_ERROR],
    ['IP_NOT_WHITELISTED', 403, DHAN_IP_ERROR],
    ['RATE_LIMITED', 429, DHAN_RATE_LIMIT_ERROR],
    ['INSUFFICIENT_FUNDS', 200, DHAN_FUNDS_ERROR],
    ['RISK_REJECTED', 200, DHAN_RMS_ERROR],
    ['INSTRUMENT_UNKNOWN', 400, DHAN_INSTRUMENT_ERROR],
    [
      'NETWORK',
      500,
      { errorCode: 'DH-909', errorMessage: 'Network error talking to the exchange' },
    ],
    ['UNKNOWN', 500, { errorCode: 'DH-908', errorMessage: 'Internal server error' }],
  ];

  it.each(cases)('classifies %s', (kind, status, body) => {
    expect(classifyDhanError(status, parseDhanErrorInfo(JSON.stringify(body)))).toBe(kind);
  });

  it('prefers IP_NOT_WHITELISTED over AUTH_EXPIRED when both are implied', () => {
    const info = parseDhanErrorInfo(
      JSON.stringify({
        errorCode: 'DH-903',
        errorMessage: 'Invalid authorization: access token used from a non-whitelisted IP',
      }),
    );
    expect(classifyDhanError(403, info)).toBe('IP_NOT_WHITELISTED');
  });

  it('classifies a bare 401/403/429 with no payload', () => {
    expect(classifyDhanError(401, { raw: '' })).toBe('AUTH_EXPIRED');
    expect(classifyDhanError(403, { raw: '' })).toBe('AUTH_EXPIRED');
    expect(classifyDhanError(429, { raw: '' })).toBe('RATE_LIMITED');
    expect(classifyDhanError(500, { raw: '' })).toBe('UNKNOWN');
  });

  it('recognises a margin shortfall as INSUFFICIENT_FUNDS, not RISK_REJECTED', () => {
    const info = parseDhanErrorInfo(
      JSON.stringify({ errorMessage: 'RMS: margin shortfall of 12000 for this order' }),
    );
    expect(classifyDhanError(200, info)).toBe('INSUFFICIENT_FUNDS');
  });

  it('does not see an IP problem in unrelated words containing "ip"', () => {
    const info = parseDhanErrorInfo(
      JSON.stringify({ errorMessage: 'Multiple description fields in participant payload' }),
    );
    expect(classifyDhanError(400, info)).toBe('UNKNOWN');
  });
});

describe('dhanHttpError', () => {
  it('carries the kind, the code, the message and the raw payload', () => {
    const err = dhanHttpError(res(401, DHAN_AUTH_ERROR), 'place order');
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.kind).toBe('AUTH_EXPIRED');
    expect(err.message).toContain('place order');
    expect(err.message).toContain('HTTP 401');
    expect(err.message).toContain('[DH-901]');
    expect(err.raw).toEqual(DHAN_AUTH_ERROR);
  });

  it('degrades gracefully on an empty body', () => {
    const err = dhanHttpError(textResponse(503, ''), 'holdings');
    expect(err.kind).toBe('UNKNOWN');
    expect(err.message).toContain('(no body)');
  });
});

describe('retry policy', () => {
  it('never retries AUTH_EXPIRED or IP_NOT_WHITELISTED', () => {
    expect(NON_RETRYABLE_BROKER_ERROR_KINDS).toEqual(['AUTH_EXPIRED', 'IP_NOT_WHITELISTED']);
    expect(isRetryableError(dhanHttpError(res(401, DHAN_AUTH_ERROR), 'place order'))).toBe(false);
    expect(isRetryableError(dhanHttpError(res(403, DHAN_IP_ERROR), 'place order'))).toBe(false);
  });

  it('allows a retry for transient kinds', () => {
    expect(isRetryableError(dhanHttpError(res(429, DHAN_RATE_LIMIT_ERROR), 'holdings'))).toBe(true);
    expect(isRetryableError(new BrokerError('NETWORK', 'socket hang up'))).toBe(true);
  });

  it('refuses to call a non-BrokerError retryable', () => {
    expect(isRetryableError(new Error('nope'))).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe('dhanParseError', () => {
  it('is UNKNOWN — the caller must treat it as "did not place"', () => {
    const err = dhanParseError('place order', 'orderId: expected a non-empty string', { a: 1 });
    expect(err.kind).toBe('UNKNOWN');
    expect(err.message).toContain('malformed response');
    expect(err.raw).toEqual({ a: 1 });
  });
});
