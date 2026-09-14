import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpClient, HttpRequest, HttpResponse } from '@pm/broker-kite';
import { createAuditWriter } from './audit.js';
import { DHAN_CONSENT_TTL_MS, createSessionService, type SessionService } from './session.js';
import { createStrategyCredsSync } from './strategy-creds.js';

const STRATEGY_SECRET = 'pm-strategy-read-creds';
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

/** Dhan leg 1 — `POST /app/generate-consent`. */
const CONSENT_STARTED = {
  status: 200,
  headers: {},
  bodyText: JSON.stringify({ consentAppId: 'consent-1', status: 'success' }),
};

/** Dhan leg 3 — `GET /app/consumeApp-consent`. `expiryTime` is IST wall-clock. */
const CONSENT_CONSUMED = {
  status: 200,
  headers: {},
  bodyText: JSON.stringify({
    dhanClientId: '1100112233',
    dhanClientName: 'Test User',
    accessToken: 'dhan-daily-token',
    expiryTime: '2026-01-14 09:00:00',
  }),
};
const CONSUMED_EXPIRY = '2026-01-14T09:00:00+05:30';

const DHAN_APP_HEADERS = { app_id: 'dhan-key', app_secret: 'dhan-secret' };

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
    'dhan-api-secret': { value: 'dhan-secret' },
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
    dhanHttp: http,
    secretNames: makeBackendConfig().secrets,
    activeBrokerFor: () => Promise.resolve('dhan'),
    strategyCreds: createStrategyCredsSync({ secrets, secretName: STRATEGY_SECRET }),
    kiteBaseUrl: 'https://kite.test/v3',
    dhanAuthBaseUrl: 'https://auth.dhan.test',
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

  it('generates a Dhan consent with the app secrets and returns its login URL', async () => {
    h.http.responses.push(CONSENT_STARTED);
    const result = await h.service.loginUrl('u1', 'dhan');

    expect(result).toEqual({
      ok: true,
      broker: 'dhan',
      url: 'https://auth.dhan.test/login/consentApp-login?consentAppId=consent-1',
      verifyLive: false,
    });
    expect(h.http.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://auth.dhan.test/app/generate-consent?client_id=1100112233',
      headers: DHAN_APP_HEADERS,
    });
  });

  it('refuses a Dhan login when any of key, secret or client id is missing', async () => {
    h.secrets.docs.delete('dhan-api-secret');
    expect(await h.service.loginUrl('u1', 'dhan')).toMatchObject({
      ok: false,
      reason: 'SECRET_MISSING',
      detail: expect.stringContaining('dhan-api-secret') as string,
    });
    expect(h.http.requests).toHaveLength(0);
  });

  it('reports a failed consent generation without a URL', async () => {
    h.http.responses.push({
      status: 401,
      headers: {},
      bodyText: JSON.stringify({ errorCode: 'DH-901', errorMessage: 'invalid app' }),
    });
    expect(await h.service.loginUrl('u1', 'dhan')).toMatchObject({
      ok: false,
      reason: 'CONSENT_FAILED',
    });
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
  it('never accepts a token from a client — the login completes on the redirect route', async () => {
    const result = await h.service.completeLogin('u1', 'dhan', {
      accessToken: 'dhan-daily-token',
      expiresAt: '2026-01-14T03:30:00.000Z',
    });

    expect(result).toMatchObject({ ok: false, reason: 'NOT_SUPPORTED' });
    expect(await h.secrets.get('dhan-access-token')).toBeUndefined();
    expect(await h.sessions.get('u1', 'dhan')).toBeUndefined();
    expect(h.http.requests).toHaveLength(0);
  });
});

describe('completeDhanRedirect', () => {
  async function startLogin(): Promise<void> {
    h.http.responses.push(CONSENT_STARTED);
    expect(await h.service.loginUrl('u1', 'dhan')).toMatchObject({ ok: true });
  }

  it('refuses a redirect when no login is pending — nothing is sent to Dhan', async () => {
    expect(await h.service.completeDhanRedirect('tok-1')).toMatchObject({
      ok: false,
      reason: 'NO_PENDING_LOGIN',
    });
    expect(h.http.requests).toHaveLength(0);
  });

  it('consumes the consent, stores the token, records the expiry and syncs the engine creds', async () => {
    await startLogin();
    h.http.responses.push(CONSENT_CONSUMED);

    const result = await h.service.completeDhanRedirect('tok-1');

    expect(result).toEqual({
      ok: true,
      broker: 'dhan',
      uid: 'u1',
      connected: true,
      expiresAt: CONSUMED_EXPIRY,
    });
    expect(h.http.requests[1]).toMatchObject({
      method: 'GET',
      url: 'https://auth.dhan.test/app/consumeApp-consent?tokenId=tok-1',
      headers: DHAN_APP_HEADERS,
    });
    expect(await h.secrets.get('dhan-access-token')).toEqual({
      value: 'dhan-daily-token',
      expiresAt: CONSUMED_EXPIRY,
    });
    expect(await h.sessions.get('u1', 'dhan')).toMatchObject({
      broker: 'dhan',
      connected: true,
      expiresAt: CONSUMED_EXPIRY,
      staticIpOk: true,
    });
    expect(h.auditLog.byType('session.connected')[0]?.detail['broker']).toBe('dhan');
    expect(JSON.parse(h.secrets.docs.get(STRATEGY_SECRET)?.value ?? 'null')).toEqual({
      broker: 'dhan',
      dhan: { clientId: '1100112233', accessToken: 'dhan-daily-token', expiresAt: CONSUMED_EXPIRY },
    });
  });

  it('is single-use: a second redirect after success is refused', async () => {
    await startLogin();
    h.http.responses.push(CONSENT_CONSUMED);
    await h.service.completeDhanRedirect('tok-1');

    expect(await h.service.completeDhanRedirect('tok-2')).toMatchObject({
      ok: false,
      reason: 'NO_PENDING_LOGIN',
    });
    expect(h.http.requests).toHaveLength(2);
  });

  it('refuses a consent completed by a different Dhan account and stores nothing', async () => {
    await startLogin();
    h.http.responses.push({
      ...CONSENT_CONSUMED,
      bodyText: JSON.stringify({
        dhanClientId: '9999999999',
        accessToken: 'someone-elses-token',
        expiryTime: '2026-01-14 09:00:00',
      }),
    });

    expect(await h.service.completeDhanRedirect('tok-1')).toMatchObject({
      ok: false,
      reason: 'CLIENT_MISMATCH',
    });
    expect(await h.secrets.get('dhan-access-token')).toBeUndefined();
    expect(await h.sessions.get('u1', 'dhan')).toBeUndefined();
    expect(h.secrets.docs.has(STRATEGY_SECRET)).toBe(false);
    // The spent login cannot be retried against a fresh consent from an attacker.
    expect(await h.service.completeDhanRedirect('tok-1')).toMatchObject({
      reason: 'NO_PENDING_LOGIN',
    });
  });

  it('surfaces a failed exchange and keeps the login pending for a genuine retry', async () => {
    await startLogin();
    h.http.responses.push({
      status: 400,
      headers: {},
      bodyText: JSON.stringify({ errorCode: 'DH-901', errorMessage: 'invalid token' }),
    });
    expect(await h.service.completeDhanRedirect('bad')).toMatchObject({
      ok: false,
      reason: 'EXCHANGE_FAILED',
    });

    h.http.responses.push(CONSENT_CONSUMED);
    expect(await h.service.completeDhanRedirect('tok-1')).toMatchObject({ ok: true });
  });

  it('refuses when the app secrets vanished between start and redirect', async () => {
    await startLogin();
    h.secrets.docs.delete('dhan-client-id');
    expect(await h.service.completeDhanRedirect('tok-1')).toMatchObject({
      ok: false,
      reason: 'SECRET_MISSING',
    });
    expect(h.http.requests).toHaveLength(1);
  });

  it('refuses a pending login older than the TTL — nothing is sent to Dhan', async () => {
    await startLogin();
    h.clock.advance(DHAN_CONSENT_TTL_MS + 1_000);

    expect(await h.service.completeDhanRedirect('tok-1')).toMatchObject({
      ok: false,
      reason: 'NO_PENDING_LOGIN',
      detail: expect.stringContaining('too long') as string,
    });
    expect(h.http.requests).toHaveLength(1);
  });

  it('a fresh login replaces a stale pending one', async () => {
    await startLogin();
    h.clock.advance(DHAN_CONSENT_TTL_MS + 1_000);
    await startLogin();
    h.http.responses.push(CONSENT_CONSUMED);
    expect(await h.service.completeDhanRedirect('tok-1')).toMatchObject({ ok: true });
  });

  it('never puts the token in the result or the audit trail', async () => {
    await startLogin();
    h.http.responses.push(CONSENT_CONSUMED);
    const result = await h.service.completeDhanRedirect('tok-1');
    expect(JSON.stringify(result)).not.toContain('dhan-daily-token');
    expect(JSON.stringify(h.auditLog.byType('session.connected'))).not.toContain(
      'dhan-daily-token',
    );
  });
});
