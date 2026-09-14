import { describe, expect, it } from 'vitest';
import type { ExecutionFailureReason } from '../services/execution.js';
import { brokerErrorStatus, executionOutcome, failureBody, simpleStatus } from './mapping.js';

describe('executionOutcome', () => {
  it('maps a success to 200 with the docs/04 §4.3 body', () => {
    expect(
      executionOutcome({
        ok: true,
        orderId: 'ord_1',
        brokerOrderId: '112111182198',
        status: 'SUBMITTED',
      }),
    ).toEqual({
      status: 200,
      body: { ok: true, orderId: 'ord_1', brokerOrderId: '112111182198', status: 'SUBMITTED' },
    });
  });

  it.each([
    ['UNAUTHORIZED', 401],
    ['IDEMPOTENT_REPLAY', 409],
    ['STALE_PROPOSAL', 409],
    ['HALTED', 423],
    ['MARKET_CLOSED', 409],
    ['SESSION_INVALID', 409],
    ['GUARDRAIL_BLOCKED', 200],
    ['PRICE_MOVED', 409],
    ['BUDGET_EXCEEDED', 200],
    ['OWNERSHIP', 200],
    ['BROKER_ERROR', 502],
  ] as [ExecutionFailureReason, number][])('maps %s to %i', (reason, status) => {
    const outcome = executionOutcome({ ok: false, reason, detail: 'why' });
    expect(outcome.status).toBe(status);
    expect(outcome.body).toMatchObject({ ok: false, reason, detail: 'why' });
  });

  it('carries failedChecks for a guardrail block', () => {
    const outcome = executionOutcome({
      ok: false,
      reason: 'GUARDRAIL_BLOCKED',
      detail: '1 guardrail check(s) failed',
      failedChecks: [{ name: 'maxOrderValue', ok: false, detail: '₹120000 > cap ₹100000' }],
    });
    expect(outcome.body['failedChecks']).toHaveLength(1);
  });

  it('carries the broker error kind and flags a re-login', () => {
    expect(
      executionOutcome({
        ok: false,
        reason: 'BROKER_ERROR',
        detail: 'boom',
        brokerErrorKind: 'RATE_LIMITED',
      }).body['brokerErrorKind'],
    ).toBe('RATE_LIMITED');

    expect(
      executionOutcome({ ok: false, reason: 'SESSION_INVALID', detail: 'expired' }).body[
        'needsLogin'
      ],
    ).toBe(true);
  });

  it('falls back to 500 for a reason it does not know', () => {
    expect(
      executionOutcome({
        ok: false,
        reason: 'WAT' as ExecutionFailureReason,
        detail: 'x',
      }).status,
    ).toBe(500);
  });
});

describe('brokerErrorStatus', () => {
  it('sends AUTH_EXPIRED to 409 and everything else to 502', () => {
    expect(brokerErrorStatus('AUTH_EXPIRED')).toBe(409);
    expect(brokerErrorStatus('IP_NOT_WHITELISTED')).toBe(502);
    expect(brokerErrorStatus('NETWORK')).toBe(502);
  });
});

describe('simpleStatus', () => {
  it('maps the smaller services’ reasons', () => {
    expect(simpleStatus('UNAUTHORIZED')).toBe(401);
    expect(simpleStatus('NOT_FOUND')).toBe(404);
    expect(simpleStatus('NOT_CANCELLABLE')).toBe(409);
    expect(simpleStatus('INVALID_PAYLOAD')).toBe(400);
    expect(simpleStatus('SECRET_MISSING')).toBe(503);
    expect(simpleStatus('EXCHANGE_FAILED')).toBe(502);
    expect(simpleStatus('something-else')).toBe(500);
  });
});

describe('failureBody', () => {
  it('always carries ok:false plus the reason', () => {
    expect(failureBody('NOT_FOUND', 'gone')).toEqual({
      ok: false,
      reason: 'NOT_FOUND',
      detail: 'gone',
    });
  });

  it('adds needsLogin for session failures and merges extras', () => {
    expect(failureBody('SESSION_INVALID', 'expired', { brokerErrorKind: 'AUTH_EXPIRED' })).toEqual({
      ok: false,
      reason: 'SESSION_INVALID',
      detail: 'expired',
      needsLogin: true,
      brokerErrorKind: 'AUTH_EXPIRED',
    });
  });
});
