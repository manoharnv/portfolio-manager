/**
 * The REST surface of docs/04 §4.3, driven through `app.inject()` — no socket,
 * no network, the same hooks and handlers a real request runs through.
 *
 * Services are stubbed here on purpose: their behaviour is pinned in
 * `services/*.test.ts`, and what these tests own is the contract between a
 * service result and the wire — status codes, auth, rate limiting, and the
 * promise that nothing secret leaves the process.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BrokerError } from '@pm/core';
import { silentLogger } from '../logger.js';
import { buildApp, sanitizeOrder, type AppDeps, type Services } from './app.js';
import { FakeTokenVerifier, FixedClock } from '../test-utils/fakes.js';
import { MARKET_OPEN_NOW, makeBackendConfig, makeOrderRecord } from '../test-utils/fixtures.js';
import type { ExecutionResult } from '../services/execution.js';
import type { RejectResult } from '../services/reject.js';
import type { CancelResult } from '../services/cancel.js';
import type { KillSwitchResult } from '../services/killswitch.js';
import type {
  CompleteLoginResult,
  LoginUrlResult,
  SessionStatusResult,
} from '../services/session.js';
import type { PortfolioResult } from '../services/portfolio.js';
import type { SyncResult } from '../services/reconcile.js';

const AUTH = { authorization: 'Bearer token-u1' };

interface Stubs {
  execution: ExecutionResult;
  reject: RejectResult;
  cancel: CancelResult;
  killswitch: KillSwitchResult;
  sessionStatus: SessionStatusResult;
  loginUrl: LoginUrlResult;
  completeLogin: CompleteLoginResult;
  portfolio: PortfolioResult;
  sync: SyncResult;
  /** When set, every execute call throws it — exercises the error handler. */
  executionThrows?: Error | undefined;
  executeCalls: unknown[];
}

function stubs(): Stubs {
  return {
    execution: { ok: true, orderId: 'ord_1', brokerOrderId: 'BRK-1', status: 'SUBMITTED' },
    reject: { ok: true, status: 'rejected' },
    cancel: { ok: true, orderId: 'ord_1', status: 'CANCELLED' },
    killswitch: { ok: true, killSwitch: true },
    sessionStatus: {
      ok: true,
      activeBroker: 'dhan',
      brokers: [
        {
          broker: 'dhan',
          connected: true,
          expiresAt: '2026-01-13T18:30:00.000Z',
          staticIpOk: true,
          needsLogin: false,
          reason: null,
        },
      ],
    },
    loginUrl: {
      ok: true,
      broker: 'kite',
      url: 'https://kite.zerodha.com/connect/login',
      verifyLive: false,
    },
    completeLogin: {
      ok: true,
      broker: 'kite',
      connected: true,
      expiresAt: '2026-01-14T00:30:00.000Z',
    },
    portfolio: {
      ok: true,
      at: MARKET_OPEN_NOW,
      snapshot: {
        holdings: [],
        positions: [],
        funds: { availableCash: 1, usedMargin: 0, availableMargin: 1, raw: null },
      },
    },
    sync: { ok: true, order: makeOrderRecord(), changed: false },
    executeCalls: [],
  };
}

function servicesFrom(s: Stubs): Services {
  return {
    execution: {
      executeProposal: (input) => {
        s.executeCalls.push(input);
        if (s.executionThrows !== undefined) return Promise.reject(s.executionThrows);
        return Promise.resolve(s.execution);
      },
    },
    reject: { rejectProposal: () => Promise.resolve(s.reject) },
    cancel: { cancelOrder: () => Promise.resolve(s.cancel) },
    killswitch: { setKillSwitch: () => Promise.resolve(s.killswitch) },
    session: {
      status: () => Promise.resolve(s.sessionStatus),
      loginUrl: () => Promise.resolve(s.loginUrl),
      completeLogin: () => Promise.resolve(s.completeLogin),
    },
    portfolio: { refresh: () => Promise.resolve(s.portfolio) },
    reconcile: {
      reconcileUser: () => Promise.resolve({ checked: 0, updated: 0, errors: 0, stuck: 0 }),
      syncOrder: () => Promise.resolve(s.sync),
    },
  };
}

async function build(overrides?: Partial<AppDeps>, s: Stubs = stubs()): Promise<FastifyInstance> {
  return buildApp({
    config: makeBackendConfig(),
    logger: silentLogger(),
    clock: new FixedClock(MARKET_OPEN_NOW),
    verifier: new FakeTokenVerifier({ 'token-u1': 'u1', 'token-stranger': 'stranger' }),
    services: servicesFrom(s),
    ...overrides,
  });
}

let s: Stubs;
let app: FastifyInstance;

beforeEach(async () => {
  s = stubs();
  app = await build(undefined, s);
});

afterEach(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------

describe('authentication', () => {
  it('serves /health without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: 'ok', environment: 'dry-run' });
  });

  it('rejects every other route without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/session' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, reason: 'UNAUTHENTICATED' });
  });

  it('rejects a malformed Authorization header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/session',
      headers: { authorization: 'token-u1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/session',
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a valid token whose uid is not on the allowlist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/session',
      headers: { authorization: 'Bearer token-stranger' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: 'FORBIDDEN' });
  });

  it('denies everyone when the allowlist is empty', async () => {
    const closed = await build({ config: makeBackendConfig({ allowedUids: [] }) });
    const res = await closed.inject({ method: 'GET', url: '/v1/session', headers: AUTH });

    expect(res.statusCode).toBe(403);
    await closed.close();
  });

  it('answers 404 with a clean body for an unknown route', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/nope', headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------

describe('POST /v1/proposals/:id/execute', () => {
  const body = { idempotencyKey: 'idem-00000001', clientSeenLtp: 2951 };

  it('returns the order on success and forwards the request faithfully', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/proposals/p1/execute',
      headers: AUTH,
      payload: { ...body, biometricAssertion: 'bio' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      orderId: 'ord_1',
      brokerOrderId: 'BRK-1',
      status: 'SUBMITTED',
    });
    expect(s.executeCalls[0]).toEqual({
      uid: 'u1',
      proposalId: 'p1',
      idempotencyKey: 'idem-00000001',
      clientSeenLtp: 2951,
      biometricAssertion: 'bio',
    });
  });

  it('omits an absent biometric assertion rather than passing undefined', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/proposals/p1/execute',
      headers: AUTH,
      payload: body,
    });
    expect('biometricAssertion' in (s.executeCalls[0] as object)).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ['missing idempotencyKey', { clientSeenLtp: 2951 }],
    ['missing clientSeenLtp', { idempotencyKey: 'idem-00000001' }],
    ['idempotency key too short', { idempotencyKey: 'short', clientSeenLtp: 1 }],
    ['negative ltp', { idempotencyKey: 'idem-00000001', clientSeenLtp: -1 }],
    ['non-numeric ltp', { idempotencyKey: 'idem-00000001', clientSeenLtp: 'x' }],
  ])('rejects a bad body: %s', async (_label, payload) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/proposals/p1/execute',
      headers: AUTH,
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, reason: 'INVALID_REQUEST' });
    expect(s.executeCalls).toHaveLength(0);
  });

  it('maps a guardrail block to 200 ok:false with the failing checks', async () => {
    s.execution = {
      ok: false,
      reason: 'GUARDRAIL_BLOCKED',
      detail: '1 guardrail check(s) failed',
      failedChecks: [{ name: 'maxOrderValueInr', ok: false, detail: '₹120000 > cap ₹100000' }],
    };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/proposals/p1/execute',
      headers: AUTH,
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'GUARDRAIL_BLOCKED' });
    expect(res.json().failedChecks).toHaveLength(1);
  });

  it.each([
    ['UNAUTHORIZED', 401],
    ['STALE_PROPOSAL', 409],
    ['HALTED', 423],
    ['MARKET_CLOSED', 409],
    ['SESSION_INVALID', 409],
    ['PRICE_MOVED', 409],
    ['IDEMPOTENT_REPLAY', 409],
    ['BUDGET_EXCEEDED', 200],
    ['OWNERSHIP', 200],
    ['BROKER_ERROR', 502],
  ] as const)('maps %s to %i', async (reason, status) => {
    s.execution = { ok: false, reason, detail: 'nope' };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/proposals/p1/execute',
      headers: AUTH,
      payload: body,
    });

    expect(res.statusCode).toBe(status);
    expect(res.json().reason).toBe(reason);
  });

  it('turns a thrown BrokerError into a typed 502', async () => {
    s.executionThrows = new BrokerError('RATE_LIMITED', 'slow down');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/proposals/p1/execute',
      headers: AUTH,
      payload: body,
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ reason: 'BROKER_ERROR', brokerErrorKind: 'RATE_LIMITED' });
  });

  it('turns a thrown AUTH_EXPIRED into a 409 re-login', async () => {
    s.executionThrows = new BrokerError('AUTH_EXPIRED', 'token dead');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/proposals/p1/execute',
      headers: AUTH,
      payload: body,
    });
    expect(res.statusCode).toBe(409);
  });

  it('never leaks an internal error message or stack', async () => {
    s.executionThrows = new Error('connect ECONNREFUSED 10.0.0.5:5432 (db password=hunter2)');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/proposals/p1/execute',
      headers: AUTH,
      payload: body,
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ ok: false, reason: 'INTERNAL', detail: 'internal error' });
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('at ');
  });
});

// ---------------------------------------------------------------------------

describe('the other routes', () => {
  it('GET /v1/session returns per-broker status with no token in it', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/session', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ activeBroker: 'dhan' });
    expect(res.body).not.toMatch(/token|secret/i);
  });

  it('POST /v1/auth/:broker/login-url returns the URL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/kite/login-url',
      headers: AUTH,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().url).toContain('kite.zerodha.com');
  });

  it('rejects an unknown broker in the path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/etrade/login-url',
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('maps a missing secret to 503', async () => {
    s.loginUrl = { ok: false, reason: 'SECRET_MISSING', detail: 'kite-api-key is not set' };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/kite/login-url',
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(503);
  });

  it('POST /v1/auth/:broker/callback returns expiry metadata only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/kite/callback',
      headers: AUTH,
      payload: { requestToken: 'rt-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      broker: 'kite',
      connected: true,
      expiresAt: '2026-01-14T00:30:00.000Z',
    });
  });

  it('maps an invalid callback payload to 400', async () => {
    s.completeLogin = { ok: false, reason: 'INVALID_PAYLOAD', detail: 'expected { requestToken }' };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/kite/callback',
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it.each(['holdings', 'positions', 'funds'] as const)('GET /v1/portfolio/%s', async (slice) => {
    const res = await app.inject({ method: 'GET', url: `/v1/portfolio/${slice}`, headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty(slice);
    expect(res.json().at).toBe(MARKET_OPEN_NOW);
  });

  it('maps a portfolio session failure to 409 with needsLogin', async () => {
    s.portfolio = { ok: false, reason: 'SESSION_INVALID', detail: 'expired' };
    const res = await app.inject({ method: 'GET', url: '/v1/portfolio/funds', headers: AUTH });

    expect(res.statusCode).toBe(409);
    expect(res.json().needsLogin).toBe(true);
  });

  it('maps a portfolio broker failure to 502 with the kind', async () => {
    s.portfolio = {
      ok: false,
      reason: 'BROKER_ERROR',
      detail: 'timeout',
      brokerErrorKind: 'NETWORK',
    };
    const res = await app.inject({ method: 'GET', url: '/v1/portfolio/holdings', headers: AUTH });

    expect(res.statusCode).toBe(502);
    expect(res.json().brokerErrorKind).toBe('NETWORK');
  });

  it('POST /v1/proposals/:id/reject', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/proposals/p1/reject',
      headers: AUTH,
      payload: { reason: 'nope' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'rejected' });
  });

  it('maps a stale reject to 409', async () => {
    s.reject = { ok: false, reason: 'STALE_PROPOSAL', detail: 'already placed' };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/proposals/p1/reject',
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects an over-long reject reason', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/proposals/p1/reject',
      headers: AUTH,
      payload: { reason: 'x'.repeat(501) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /v1/orders/:id/cancel', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orders/ord_1/cancel',
      headers: AUTH,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, orderId: 'ord_1', status: 'CANCELLED' });
  });

  it('maps an uncancellable order to 409 and a missing one to 404', async () => {
    s.cancel = { ok: false, reason: 'NOT_CANCELLABLE', detail: 'order is COMPLETE' };
    expect(
      (await app.inject({ method: 'POST', url: '/v1/orders/o/cancel', headers: AUTH })).statusCode,
    ).toBe(409);

    s.cancel = { ok: false, reason: 'NOT_FOUND', detail: 'gone' };
    expect(
      (await app.inject({ method: 'POST', url: '/v1/orders/o/cancel', headers: AUTH })).statusCode,
    ).toBe(404);
  });

  it('GET /v1/orders/:id re-syncs and never returns the raw broker ack', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/orders/ord_0001', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json().order).toMatchObject({ id: 'ord_0001', status: 'SUBMITTED' });
    expect(res.json().order).not.toHaveProperty('brokerRawAck');
  });

  it('maps an order owned by someone else to 401', async () => {
    s.sync = { ok: false, reason: 'UNAUTHORIZED', detail: 'not the owner' };
    const res = await app.inject({ method: 'GET', url: '/v1/orders/ord_1', headers: AUTH });
    expect(res.statusCode).toBe(401);
  });

  it('POST /v1/config/killswitch toggles and validates', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/config/killswitch',
      headers: AUTH,
      payload: { enabled: true, reason: 'weird fills' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, killSwitch: true });

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/config/killswitch',
      headers: AUTH,
      payload: { enabled: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('maps a missing config on killswitch to 404', async () => {
    s.killswitch = { ok: false, reason: 'NOT_FOUND', detail: 'no config' };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/config/killswitch',
      headers: AUTH,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /v1/admin/whitelist-ip answers 501 with a clear message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/whitelist-ip',
      headers: AUTH,
      payload: {},
    });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ reason: 'NOT_IMPLEMENTED', staticIp: '203.0.113.7' });
    expect(res.json().detail).toMatch(/broker console/);
  });
});

// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  it('returns 429 once the per-uid budget is spent', async () => {
    const limited = await build({
      config: makeBackendConfig({ rateLimit: { max: 2, windowMs: 60_000 } }),
    });

    const codes: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      codes.push(
        (await limited.inject({ method: 'GET', url: '/v1/session', headers: AUTH })).statusCode,
      );
    }

    expect(codes).toEqual([200, 200, 429]);
    const last = await limited.inject({ method: 'GET', url: '/v1/session', headers: AUTH });
    expect(last.json()).toMatchObject({ ok: false, reason: 'RATE_LIMITED' });
    await limited.close();
  });

  it('never rate-limits /health', async () => {
    const limited = await build({
      config: makeBackendConfig({ rateLimit: { max: 1, windowMs: 60_000 } }),
    });

    for (let i = 0; i < 5; i += 1) {
      expect((await limited.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    }
    await limited.close();
  });
});

describe('sanitizeOrder', () => {
  it('drops the raw broker ack and keeps everything else', () => {
    const clean = sanitizeOrder(makeOrderRecord());
    expect(clean).not.toHaveProperty('brokerRawAck');
    expect(clean).toMatchObject({ id: 'ord_0001', ipUsed: '203.0.113.7' });
  });
});
