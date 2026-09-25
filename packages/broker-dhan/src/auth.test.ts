import { BrokerError, SESSION_EXPIRY_MARGIN_SECONDS } from '@pm/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_MARGIN_MS,
  DHAN_TOKEN_TTL_MS,
  describeSession,
  isSessionValid,
  renewToken,
  type DhanSession,
} from './auth.js';
import {
  DHAN_AUTH_ERROR,
  DHAN_RENEW_TOKEN,
  EXPECTED_HEADERS,
  FIXED_NOW,
  FakeHttpClient,
  TEST_BASE_URL,
  TEST_SESSION,
  jsonResponse,
} from './test-utils.js';

const creds = { clientId: TEST_SESSION.clientId, accessToken: TEST_SESSION.accessToken };

describe('renewToken', () => {
  it('POSTs /v2/RenewToken with the Dhan auth headers and no body', async () => {
    const http = new FakeHttpClient(jsonResponse(200, DHAN_RENEW_TOKEN));
    await renewToken(http, creds, { baseUrl: TEST_BASE_URL });
    expect(http.count).toBe(1);
    expect(http.last).toEqual({
      method: 'POST',
      url: `${TEST_BASE_URL}/RenewToken`,
      headers: EXPECTED_HEADERS,
    });
  });

  it('returns the new token and the expiry Dhan reported', async () => {
    const http = new FakeHttpClient(jsonResponse(200, DHAN_RENEW_TOKEN));
    await expect(renewToken(http, creds, { baseUrl: TEST_BASE_URL })).resolves.toEqual({
      accessToken: DHAN_RENEW_TOKEN.accessToken,
      expiresAt: '2026-01-14T09:00:00+05:30',
    });
  });

  it('accepts snake_case fields, a {data:{…}} wrapper and an epoch expiry', async () => {
    const expiry = Math.floor((FIXED_NOW.getTime() + DHAN_TOKEN_TTL_MS) / 1000);
    const http = new FakeHttpClient(
      jsonResponse(200, { data: { access_token: 'another-test-token', expiry } }),
    );
    await expect(renewToken(http, creds)).resolves.toEqual({
      accessToken: 'another-test-token',
      expiresAt: '2026-01-14T04:30:00.000Z',
    });
  });

  it('derives a 24h expiry from the injected `now` when Dhan sends none', async () => {
    const http = new FakeHttpClient(jsonResponse(200, { accessToken: 'a-test-token' }));
    await expect(renewToken(http, creds, { now: FIXED_NOW })).resolves.toEqual({
      accessToken: 'a-test-token',
      expiresAt: '2026-01-14T04:30:00.000Z',
    });
  });

  it('refuses to guess an expiry when neither Dhan nor the caller supplies one', async () => {
    const http = new FakeHttpClient(jsonResponse(200, { accessToken: 'a-test-token' }));
    const err = await renewToken(http, creds).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect((err as BrokerError).message).toContain('no `now` was supplied');
  });

  it('refuses a response with no token, or one that is not an object', async () => {
    await expect(
      renewToken(new FakeHttpClient(jsonResponse(200, { nope: 1 })), creds),
    ).rejects.toThrow(/no access token field/);
    await expect(
      renewToken(new FakeHttpClient(jsonResponse(200, '"a-string"')), creds),
    ).rejects.toThrow(/expected a JSON object/);
  });

  it('maps a rejected renewal to AUTH_EXPIRED', async () => {
    const err = await renewToken(
      new FakeHttpClient(jsonResponse(401, DHAN_AUTH_ERROR)),
      creds,
    ).catch((e: unknown) => e);
    expect((err as BrokerError).kind).toBe('AUTH_EXPIRED');
  });

  it('passes a timeout through to the HTTP client', async () => {
    const http = new FakeHttpClient(jsonResponse(200, DHAN_RENEW_TOKEN));
    await renewToken(http, creds, { timeoutMs: 2500 });
    expect(http.last.timeoutMs).toBe(2500);
  });
});

describe('isSessionValid', () => {
  const at = (offsetMs: number): Date => new Date(FIXED_NOW.getTime() + offsetMs);
  const session: DhanSession = { ...TEST_SESSION, expiresAt: FIXED_NOW.toISOString() };

  it("uses core's expiry margin by default", () => {
    expect(DEFAULT_SESSION_MARGIN_MS).toBe(SESSION_EXPIRY_MARGIN_SECONDS * 1000);
  });

  it('is valid strictly beyond the margin and invalid at or inside it', () => {
    const margin = DEFAULT_SESSION_MARGIN_MS;
    expect(isSessionValid(session, at(-margin - 1))).toBe(true);
    expect(isSessionValid(session, at(-margin))).toBe(false);
    expect(isSessionValid(session, at(0))).toBe(false);
    expect(isSessionValid(session, at(1))).toBe(false);
  });

  it('honours an explicit margin', () => {
    expect(isSessionValid(session, at(-1000), 500)).toBe(true);
    expect(isSessionValid(session, at(-1000), 5000)).toBe(false);
  });

  it('fails closed on an unknown, unparseable or empty session', () => {
    expect(isSessionValid({ clientId: 'c', accessToken: 't' }, FIXED_NOW)).toBe(false);
    expect(
      isSessionValid({ clientId: 'c', accessToken: 't', expiresAt: 'tomorrow' }, FIXED_NOW),
    ).toBe(false);
    expect(
      isSessionValid(
        { clientId: 'c', accessToken: '  ', expiresAt: TEST_SESSION.expiresAt },
        FIXED_NOW,
      ),
    ).toBe(false);
  });
});

describe('describeSession', () => {
  it('reports the neutral SessionStatus for a live session', () => {
    expect(describeSession(TEST_SESSION, FIXED_NOW)).toEqual({
      broker: 'dhan',
      connected: true,
      expiresAt: TEST_SESSION.expiresAt,
    });
  });

  it('reports disconnected once the token has expired', () => {
    const later = new Date(Date.parse(TEST_SESSION.expiresAt!) + 1);
    expect(describeSession(TEST_SESSION, later)).toMatchObject({ connected: false });
  });

  it('omits expiresAt entirely when the session has none', () => {
    const status = describeSession({ clientId: 'c', accessToken: 't' }, FIXED_NOW);
    expect(status).toEqual({ broker: 'dhan', connected: false });
    expect('expiresAt' in status).toBe(false);
  });
});
