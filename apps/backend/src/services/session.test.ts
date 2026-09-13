import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpClient, HttpRequest, HttpResponse } from '@pm/broker-kite';
import { createAuditWriter } from './audit.js';
import { createSessionService, type SessionService } from './session.js';
import {
  FakeAuditLog,
  FakeSecretStore,
  FakeSessionStore,
  FixedClock,
  SeqIdGenerator,
} from '../test-utils/fakes.js';
import { MARKET_OPEN_NOW, makeBackendConfig, makeBrokerSession } from '../test-utils/fixtures.js';

/** Scripted Kite transport — no network, ever (docs/00 §0.5). */
class FakeHttp implements HttpClient {
  readonly requests: HttpRequest[] = [];
  responses: HttpResponse[] = [];
  error?: Error | undefined;

  request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    if (this.error !== undefined) return Promise.reject(this.error);
    const next = this.responses.shift();
    if (next === undefined) return Promise.reject(new Error('no scripted response'));
    return Promise.resolve(next);
  }
}

const OK_SESSION = {
  status: 200,
  headers: {},
  bodyText: JSON.stringify({
    status: 'success',
    data: { access_token: 'kite-daily-token', user_id: 'AB1234' },
  }),
};

interface Harness {
  service: SessionService;
  secrets: FakeSecretStore;
  sessions: FakeSessionStore;
  auditLog: FakeAuditLog;
  http: FakeHttp;
  clock: FixedClock;
}

function harness(): Harness {
  const clock = new FixedClock(MARKET_OPEN_NOW);
  const ids = new SeqIdGenerator();
  const auditLog = new FakeAuditLog();
  const secrets = new FakeSecretStore({
    'dhan-api-key': { value: 'dhan-key' },
    'dhan-client-id': { value: '1100112233' },
    'kite-api-key': { value: 'kite-key' },
    'kite-api-secret': { value: 'kite-secret' },
  });
  const sessions = new FakeSessionStore();
  const http = new FakeHttp();

  const service = createSessionService({
    secrets,
    sessions,
    audit: createAuditWriter({ audit: auditLog, ids, clock, ip: '203.0.113.7' }),
    clock,
    http,
    secretNames: makeBackendConfig().secrets,
    activeBrokerFor: () => Promise.resolve('dhan'),
    kiteBaseUrl: 'https://kite.test/v3',
  });
  return { service, secrets, sessions, auditLog, http, clock };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('status', () => {
  it('reports both brokers as needing login when nothing is stored', async () => {
    const result = await h.service.status('u1');

    expect(result.activeBroker).toBe('dhan');
    expect(result.brokers).toHaveLength(2);
    expect(result.brokers.every((b) => b.needsLogin)).toBe(true);
    expect(result.brokers[0]?.reason).toMatch(/not connected|no broker session/);
  });

  it('reports a live session as usable', async () => {
    await h.sessions.set('u1', makeBrokerSession());
    const result = await h.service.status('u1');

    const dhan = result.brokers.find((b) => b.broker === 'dhan');
    expect(dhan).toMatchObject({ connected: true, needsLogin: false, reason: null });
  });

  it('reports a session inside the expiry margin as needing login', async () => {
    await h.sessions.set('u1', makeBrokerSession({ expiresAt: '2026-01-13T04:31:00.000Z' }));
    const dhan = (await h.service.status('u1')).brokers.find((b) => b.broker === 'dhan');

    expect(dhan?.needsLogin).toBe(true);
    expect(dhan?.reason).toMatch(/safety margin/);
  });

  it('never leaks a token in the status payload', async () => {
    await h.sessions.set('u1', makeBrokerSession());
    const raw = JSON.stringify(await h.service.status('u1'));
    expect(raw).not.toMatch(/token|secret/i);
  });
});

describe('loginUrl', () => {
  it('builds the Kite connect URL from the stored api key', async () => {
    const result = await h.service.loginUrl('u1', 'kite');
    expect(result).toMatchObject({ ok: true, verifyLive: false });
    expect((result as { url: string }).url).toContain('api_key=kite-key');
  });

  it('marks the Dhan consent URL as VERIFY-LIVE', async () => {
    const result = await h.service.loginUrl('u1', 'dhan');
    expect(result).toMatchObject({ ok: true, verifyLive: true });
  });

  it('refuses when the api key secret is missing', async () => {
    h.secrets.docs.delete('kite-api-key');
    expect(await h.service.loginUrl('u1', 'kite')).toMatchObject({
      ok: false,
      reason: 'SECRET_MISSING',
    });
  });
});

describe('completeLogin — kite', () => {
  it('exchanges the request token, stores it and records the expiry', async () => {
    h.http.responses.push(OK_SESSION);
    const result = await h.service.completeLogin('u1', 'kite', { requestToken: 'rt-123' });

    expect(result).toMatchObject({ ok: true, broker: 'kite', connected: true });
    // Kite tokens die at the next 06:00 IST — 00:30 UTC on the 14th.
    expect((result as { expiresAt: string }).expiresAt).toBe('2026-01-14T00:30:00.000Z');

    const stored = await h.secrets.get('kite-access-token');
    expect(stored).toEqual({
      value: 'kite-daily-token',
      expiresAt: '2026-01-14T00:30:00.000Z',
    });

    const session = await h.sessions.get('u1', 'kite');
    expect(session).toMatchObject({ connected: true, staticIpOk: true });
    expect(h.auditLog.types()).toContain('session.connected');
  });

  it('sends the exchange to the configured base url and never echoes the secret', async () => {
    h.http.responses.push(OK_SESSION);
    const result = await h.service.completeLogin('u1', 'kite', { requestToken: 'rt-123' });

    expect(h.http.requests[0]?.url).toBe('https://kite.test/v3/session/token');
    expect(h.http.requests[0]?.body).toContain('api_key=kite-key');
    expect(JSON.stringify(result)).not.toContain('kite-daily-token');
  });

  it('rejects a payload without a request token', async () => {
    expect(await h.service.completeLogin('u1', 'kite', { foo: 1 })).toMatchObject({
      ok: false,
      reason: 'INVALID_PAYLOAD',
    });
    expect(h.http.requests).toHaveLength(0);
  });

  it('refuses when either Kite secret is missing', async () => {
    h.secrets.docs.delete('kite-api-secret');
    expect(await h.service.completeLogin('u1', 'kite', { requestToken: 'rt' })).toMatchObject({
      ok: false,
      reason: 'SECRET_MISSING',
    });
  });

  it('surfaces an exchange failure without storing anything', async () => {
    h.http.responses.push({
      status: 403,
      headers: {},
      bodyText: JSON.stringify({ status: 'error', message: 'bad checksum' }),
    });
    const result = await h.service.completeLogin('u1', 'kite', { requestToken: 'rt' });

    expect(result).toMatchObject({ ok: false, reason: 'EXCHANGE_FAILED' });
    expect(await h.secrets.get('kite-access-token')).toBeUndefined();
    expect(await h.sessions.get('u1', 'kite')).toBeUndefined();
  });
});

describe('completeLogin — dhan', () => {
  it('accepts a minted token plus its true expiry', async () => {
    const result = await h.service.completeLogin('u1', 'dhan', {
      accessToken: 'dhan-daily-token',
      expiresAt: '2026-01-14T03:30:00.000Z',
    });

    expect(result).toMatchObject({ ok: true, broker: 'dhan', connected: true });
    expect(await h.secrets.get('dhan-access-token')).toEqual({
      value: 'dhan-daily-token',
      expiresAt: '2026-01-14T03:30:00.000Z',
    });
    expect((await h.sessions.get('u1', 'dhan'))?.expiresAt).toBe('2026-01-14T03:30:00.000Z');
    expect(h.auditLog.byType('session.connected')[0]?.detail['broker']).toBe('dhan');
  });

  it('refuses a token with no expiry — the adapter would have to fail closed', async () => {
    expect(
      await h.service.completeLogin('u1', 'dhan', { accessToken: 'dhan-daily-token' }),
    ).toMatchObject({ ok: false, reason: 'INVALID_PAYLOAD' });
    expect(await h.secrets.get('dhan-access-token')).toBeUndefined();
  });

  it('refuses a malformed expiry', async () => {
    expect(
      await h.service.completeLogin('u1', 'dhan', {
        accessToken: 't',
        expiresAt: 'tomorrow',
      }),
    ).toMatchObject({ ok: false, reason: 'INVALID_PAYLOAD' });
  });
});
