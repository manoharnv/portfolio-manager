import { BrokerError } from '@pm/core';
import { describe, expect, it } from 'vitest';
import { DHAN_TOKEN_TTL_MS } from './auth.js';
import {
  DHAN_AUTH_BASE_URL,
  consentLoginUrl,
  consumeConsent,
  generateConsent,
} from './consent.js';
import { DHAN_AUTH_ERROR, FIXED_NOW, FakeHttpClient, jsonResponse } from './test-utils.js';

const APP = { apiKey: 'app-key', apiSecret: 'app-secret' };
const AUTH = 'https://auth.dhan.test';
const APP_HEADERS = { app_id: 'app-key', app_secret: 'app-secret' };

const CONSUMED = {
  dhanClientId: '1100112233',
  dhanClientName: 'Test User',
  dhanClientUcc: 'UCC001',
  givenPowerOfAttorney: false,
  accessToken: 'daily-jwt',
  expiryTime: '2026-01-14 09:00:00',
};

describe('consentLoginUrl', () => {
  it('points at the production auth host by default and encodes the id', () => {
    expect(consentLoginUrl('c 1/2')).toBe(
      `${DHAN_AUTH_BASE_URL}/login/consentApp-login?consentAppId=c%201%2F2`,
    );
  });
});

describe('generateConsent', () => {
  it('POSTs generate-consent with the app headers and the client id in the query', async () => {
    const http = new FakeHttpClient(
      jsonResponse(200, { consentAppId: 'consent-123', status: 'success' }),
    );
    const started = await generateConsent(http, APP, '1100112233', { authBaseUrl: AUTH });

    expect(http.count).toBe(1);
    expect(http.last).toEqual({
      method: 'POST',
      url: `${AUTH}/app/generate-consent?client_id=1100112233`,
      headers: APP_HEADERS,
    });
    expect(started).toEqual({
      consentAppId: 'consent-123',
      loginUrl: `${AUTH}/login/consentApp-login?consentAppId=consent-123`,
    });
  });

  it('uses the production auth host and forwards a timeout when asked', async () => {
    const http = new FakeHttpClient(jsonResponse(200, { consentAppId: 'c' }));
    await generateConsent(http, APP, '1', { timeoutMs: 1234 });
    expect(http.last?.url).toBe(`${DHAN_AUTH_BASE_URL}/app/generate-consent?client_id=1`);
    expect(http.last?.timeoutMs).toBe(1234);
  });

  it('accepts a {data:{consentAppId}} wrapper', async () => {
    const http = new FakeHttpClient(jsonResponse(200, { data: { consentAppId: 'wrapped' } }));
    await expect(generateConsent(http, APP, '1', { authBaseUrl: AUTH })).resolves.toMatchObject({
      consentAppId: 'wrapped',
    });
  });

  it('refuses a response without a consent id', async () => {
    const http = new FakeHttpClient(jsonResponse(200, { status: 'success' }));
    const err = await generateConsent(http, APP, '1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect((err as BrokerError).message).toContain('consent id');
  });

  it('surfaces a non-2xx as a BrokerError', async () => {
    const http = new FakeHttpClient(jsonResponse(401, DHAN_AUTH_ERROR));
    await expect(generateConsent(http, APP, '1')).rejects.toBeInstanceOf(BrokerError);
  });
});

describe('consumeConsent', () => {
  it('GETs consumeApp-consent with the token id and returns the session', async () => {
    const http = new FakeHttpClient(jsonResponse(200, CONSUMED));
    const consumed = await consumeConsent(http, APP, 'tok-1', { authBaseUrl: AUTH });

    expect(http.last).toEqual({
      method: 'GET',
      url: `${AUTH}/app/consumeApp-consent?tokenId=tok-1`,
      headers: APP_HEADERS,
    });
    expect(consumed).toEqual({
      accessToken: 'daily-jwt',
      expiresAt: '2026-01-14T09:00:00+05:30',
      clientId: '1100112233',
      clientName: 'Test User',
    });
  });

  it('encodes the token id', async () => {
    const http = new FakeHttpClient(jsonResponse(200, CONSUMED));
    await consumeConsent(http, APP, 'a b/c&d', { authBaseUrl: AUTH });
    expect(http.last?.url).toBe(`${AUTH}/app/consumeApp-consent?tokenId=a%20b%2Fc%26d`);
  });

  it('derives a 24h expiry from `now` when Dhan sends none', async () => {
    const http = new FakeHttpClient(
      jsonResponse(200, { accessToken: 'daily-jwt', dhanClientId: '1100112233' }),
    );
    await expect(consumeConsent(http, APP, 'tok', { now: FIXED_NOW })).resolves.toMatchObject({
      expiresAt: new Date(FIXED_NOW.getTime() + DHAN_TOKEN_TTL_MS).toISOString(),
    });
  });

  it('refuses to guess an expiry when neither Dhan nor the caller supplies one', async () => {
    const http = new FakeHttpClient(
      jsonResponse(200, { accessToken: 'daily-jwt', dhanClientId: '1100112233' }),
    );
    const err = await consumeConsent(http, APP, 'tok').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect((err as BrokerError).message).toContain('no `now` was supplied');
  });

  it('refuses a response without a token or without a client id, naming fields not values', async () => {
    const noToken = new FakeHttpClient(jsonResponse(200, { dhanClientId: '1100112233' }));
    const e1 = await consumeConsent(noToken, APP, 'tok').catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(BrokerError);
    expect((e1 as BrokerError).message).toContain('access token');

    const noClient = new FakeHttpClient(
      jsonResponse(200, { accessToken: 'daily-jwt', expiryTime: '2026-01-14 09:00:00' }),
    );
    const e2 = await consumeConsent(noClient, APP, 'tok').catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(BrokerError);
    expect((e2 as BrokerError).message).toContain('client id');
    expect(JSON.stringify((e2 as BrokerError).raw ?? null)).not.toContain('daily-jwt');
  });

  it('treats a Dhan "failed" status as an error even with HTTP 200', async () => {
    const http = new FakeHttpClient(
      jsonResponse(200, { status: 'failed', errorCode: 'DH-901', errorMessage: 'invalid token' }),
    );
    await expect(consumeConsent(http, APP, 'tok')).rejects.toBeInstanceOf(BrokerError);
  });
});
