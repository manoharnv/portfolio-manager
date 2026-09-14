import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BrokerError } from '@pm/core';
import {
  computeChecksum,
  exchangeRequestToken,
  isSessionValid,
  loginUrl,
  nextSixAmIst,
} from './auth.js';
import { FakeHttpClient, kiteError, sampleSessionTokenResponse } from './test-utils.js';

describe('computeChecksum', () => {
  it('matches a hand-computed SHA-256 vector for a fixed triple', () => {
    // Hard-coded known value (independently verified via `node -e`, not
    // derived from the same code path as `expectedViaCrypto` below).
    const KNOWN_HEX = '1710e71e38ca2c12842c4c235d1c619d088619f24db8cea3d356c511baf2dff0';
    expect(computeChecksum('abc123', 'reqtok456', 'secretXYZ')).toBe(KNOWN_HEX);
  });

  it('matches node:crypto computed independently from the same inputs', () => {
    const apiKey = 'my-api-key';
    const requestToken = 'req-tok-789';
    const apiSecret = 'super-secret';
    const expected = createHash('sha256')
      .update(apiKey + requestToken + apiSecret, 'utf8')
      .digest('hex');
    expect(computeChecksum(apiKey, requestToken, apiSecret)).toBe(expected);
  });

  it('is sensitive to every input', () => {
    const base = computeChecksum('a', 'b', 'c');
    expect(computeChecksum('x', 'b', 'c')).not.toBe(base);
    expect(computeChecksum('a', 'x', 'c')).not.toBe(base);
    expect(computeChecksum('a', 'b', 'x')).not.toBe(base);
  });
});

describe('loginUrl', () => {
  it('builds the Kite Connect v3 login URL', () => {
    expect(loginUrl('my_key')).toBe('https://kite.zerodha.com/connect/login?v=3&api_key=my_key');
  });

  it('URL-encodes the api key', () => {
    expect(loginUrl('a key/b')).toBe(
      'https://kite.zerodha.com/connect/login?v=3&api_key=a%20key%2Fb',
    );
  });

  it('carries redirect params as one URL-encoded query string, per the Kite docs', () => {
    expect(loginUrl('my_key', { redirectParams: { state: 'n 1', x: 'a&b' } })).toBe(
      'https://kite.zerodha.com/connect/login?v=3&api_key=my_key&redirect_params=state%3Dn%2B1%26x%3Da%2526b',
    );
    expect(loginUrl('my_key', { redirectParams: {} })).toBe(
      'https://kite.zerodha.com/connect/login?v=3&api_key=my_key',
    );
  });
});

describe('nextSixAmIst', () => {
  it("returns today's 06:00 IST when now is earlier in the same IST day", () => {
    expect(nextSixAmIst(new Date('2026-01-13T00:00:00.000Z'))).toBe('2026-01-13T00:30:00.000Z');
  });

  it('rolls to tomorrow when now is already past 06:00 IST today', () => {
    expect(nextSixAmIst(new Date('2026-01-13T04:30:00.000Z'))).toBe('2026-01-14T00:30:00.000Z');
  });

  it('treats exactly 06:00:00.000 IST as "already past" and rolls to tomorrow', () => {
    expect(nextSixAmIst(new Date('2026-01-13T00:30:00.000Z'))).toBe('2026-01-14T00:30:00.000Z');
  });

  it('returns today just 1ms before the boundary', () => {
    expect(nextSixAmIst(new Date('2026-01-13T00:29:59.999Z'))).toBe('2026-01-13T00:30:00.000Z');
  });

  it('always returns an instant strictly after `now`', () => {
    for (const iso of [
      '2026-06-01T18:45:00.000Z',
      '2025-12-31T23:59:59.999Z',
      '2026-03-15T00:00:00.000Z',
    ]) {
      const now = new Date(iso);
      expect(Date.parse(nextSixAmIst(now))).toBeGreaterThan(now.getTime());
    }
  });
});

describe('isSessionValid', () => {
  const session = { apiKey: 'k', accessToken: 'a', expiresAt: '2026-01-13T18:30:00.000Z' };

  it('is valid well before expiry', () => {
    expect(isSessionValid(session, new Date('2026-01-13T04:30:00.000Z'))).toBe(true);
  });

  it('is invalid at/after expiry', () => {
    expect(isSessionValid(session, new Date('2026-01-13T18:30:00.000Z'))).toBe(false);
    expect(isSessionValid(session, new Date('2026-01-13T18:30:01.000Z'))).toBe(false);
  });

  it('honours a margin: "expiring soon" becomes invalid ahead of the real expiry', () => {
    const justBeforeExpiry = new Date('2026-01-13T18:25:00.000Z'); // 5 min before expiry
    expect(isSessionValid(session, justBeforeExpiry, 0)).toBe(true);
    expect(isSessionValid(session, justBeforeExpiry, 10 * 60 * 1000)).toBe(false); // 10 min margin
  });

  it('fails closed when expiresAt is not parseable', () => {
    expect(isSessionValid({ ...session, expiresAt: 'not-a-date' }, new Date())).toBe(false);
  });
});

describe('exchangeRequestToken', () => {
  it('POSTs the checksum-signed form body to /session/token and parses the result', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleSessionTokenResponse());

    const now = new Date('2026-01-13T04:30:00.000Z');
    const result = await exchangeRequestToken(
      http,
      { apiKey: 'my-key', apiSecret: 'my-secret', requestToken: 'req-tok' },
      now,
      'https://api.kite.trade',
    );

    expect(http.requests).toHaveLength(1);
    const req = http.requests[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('https://api.kite.trade/session/token');
    expect(req?.headers['X-Kite-Version']).toBe('3');
    expect(req?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(req?.headers['Authorization']).toBeUndefined();

    const expectedChecksum = computeChecksum('my-key', 'req-tok', 'my-secret');
    expect(req?.body).toBe(`api_key=my-key&request_token=req-tok&checksum=${expectedChecksum}`);

    expect(result.accessToken).toBe('daily-access-token');
    expect(result.userId).toBe('AB1234');
    expect(result.expiresAt).toBe(nextSixAmIst(now));
    expect(result.raw).toMatchObject({ access_token: 'daily-access-token' });
  });

  it('defaults to the real Kite base URL when none is given', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleSessionTokenResponse());
    await exchangeRequestToken(
      http,
      { apiKey: 'k', apiSecret: 's', requestToken: 'r' },
      new Date(),
    );
    expect(http.requests[0]?.url).toBe('https://api.kite.trade/session/token');
  });

  it('throws a typed AUTH_EXPIRED error when Kite rejects the request token', async () => {
    const http = new FakeHttpClient();
    http.enqueue(kiteError(403, 'TokenException', 'Invalid request token'));
    await expect(
      exchangeRequestToken(http, { apiKey: 'k', apiSecret: 's', requestToken: 'bad' }, new Date()),
    ).rejects.toMatchObject({ kind: 'AUTH_EXPIRED' });
  });

  it('throws a typed UNKNOWN error when the success payload is malformed', async () => {
    const http = new FakeHttpClient();
    http.enqueue({
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ status: 'success', data: {} }),
    });
    const promise = exchangeRequestToken(
      http,
      { apiKey: 'k', apiSecret: 's', requestToken: 'r' },
      new Date(),
    );
    await expect(promise).rejects.toBeInstanceOf(BrokerError);
    await expect(promise).rejects.toMatchObject({ kind: 'UNKNOWN' });
  });

  it('maps a transport failure to NETWORK', async () => {
    const http = new FakeHttpClient();
    http.onRequest(() => {
      throw new TypeError('network down');
    });
    await expect(
      exchangeRequestToken(http, { apiKey: 'k', apiSecret: 's', requestToken: 'r' }, new Date()),
    ).rejects.toMatchObject({ kind: 'NETWORK' });
  });
});
