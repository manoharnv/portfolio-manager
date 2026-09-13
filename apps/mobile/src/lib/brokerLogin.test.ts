import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { extractRequestToken, runBrokerLogin } from './brokerLogin';
import { fakeApiClient } from '../test-utils';

const REQUEST_TOKEN = 'rt_abc123';
const SUCCESS_REDIRECT = `pm://broker-callback?action=login&status=success&request_token=${REQUEST_TOKEN}`;

describe('extractRequestToken', () => {
  it('reads request_token out of the query string', () => {
    expect(extractRequestToken(SUCCESS_REDIRECT)).toBe(REQUEST_TOKEN);
  });

  it('accepts the camelCase spelling and the fragment form', () => {
    expect(extractRequestToken('pm://cb?requestToken=abc')).toBe('abc');
    expect(extractRequestToken('pm://cb#request_token=frag')).toBe('frag');
  });

  it('returns undefined when there is nothing to take', () => {
    expect(extractRequestToken('pm://broker-callback?status=cancelled')).toBeUndefined();
    expect(extractRequestToken('pm://broker-callback')).toBeUndefined();
    expect(extractRequestToken('pm://cb?request_token=')).toBeUndefined();
  });
});

describe('runBrokerLogin', () => {
  it('asks the backend for the URL, then posts only the request token back', async () => {
    const completeLogin = jest.fn(async () => ({
      ok: true as const,
      broker: 'kite' as const,
      connected: true as const,
      expiresAt: '2026-02-04T00:30:00.000Z',
    }));
    const openAuthSession = jest.fn(async () => ({
      type: 'success' as const,
      url: SUCCESS_REDIRECT,
    }));
    const api = fakeApiClient({
      loginUrl: async () => ({
        ok: true,
        broker: 'kite',
        url: 'https://kite.zerodha.com/connect/login?api_key=redacted',
        verifyLive: false,
      }),
      completeLogin,
    });

    const result = await runBrokerLogin('kite', { api, openAuthSession });

    expect(result).toEqual({
      ok: true,
      broker: 'kite',
      expiresAt: '2026-02-04T00:30:00.000Z',
    });
    expect(openAuthSession).toHaveBeenCalledWith(
      'https://kite.zerodha.com/connect/login?api_key=redacted',
      'pm://broker-callback',
    );
    // The ONLY thing forwarded is the short-lived request token.
    expect(completeLogin).toHaveBeenCalledWith('kite', { requestToken: REQUEST_TOKEN });
  });

  it('never writes the request token to any local store (docs/06 §6.7)', async () => {
    const api = fakeApiClient({
      loginUrl: async () => ({
        ok: true,
        broker: 'kite',
        url: 'https://k/login',
        verifyLive: false,
      }),
      completeLogin: async () => ({
        ok: true,
        broker: 'kite',
        connected: true,
        expiresAt: '2026-02-04T00:30:00.000Z',
      }),
    });

    await runBrokerLogin('kite', {
      api,
      openAuthSession: async () => ({ type: 'success', url: SUCCESS_REDIRECT }) as never,
    });

    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('reports a cancelled session without calling the callback route', async () => {
    const completeLogin = jest.fn();
    const api = fakeApiClient({
      loginUrl: async () => ({
        ok: true,
        broker: 'kite',
        url: 'https://k/login',
        verifyLive: false,
      }),
      completeLogin,
    });

    const result = await runBrokerLogin('kite', {
      api,
      openAuthSession: async () => ({ type: 'dismiss' }) as never,
    });

    expect(result).toMatchObject({ ok: false, reason: 'CANCELLED' });
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it('reports NO_REQUEST_TOKEN when a confirmed redirect carries nothing', async () => {
    const api = fakeApiClient({
      loginUrl: async () => ({
        ok: true,
        broker: 'kite',
        url: 'https://k/login',
        verifyLive: false,
      }),
    });
    const result = await runBrokerLogin('kite', {
      api,
      openAuthSession: async () =>
        ({ type: 'success', url: 'pm://broker-callback?status=ok' }) as never,
    });
    expect(result).toMatchObject({ ok: false, reason: 'NO_REQUEST_TOKEN' });
  });

  it('stops at VERIFY_LIVE for a broker whose redirect shape is unconfirmed', async () => {
    const api = fakeApiClient({
      loginUrl: async () => ({
        ok: true,
        broker: 'dhan',
        url: 'https://auth.dhan.co/login/consentApp-login?consentAppId=x',
        verifyLive: true,
      }),
    });
    const result = await runBrokerLogin('dhan', {
      api,
      openAuthSession: async () => ({ type: 'success', url: 'pm://broker-callback?ok=1' }) as never,
    });

    expect(result).toMatchObject({ ok: false, reason: 'VERIFY_LIVE' });
    expect((result as { detail: string }).detail).toContain('will not carry a broker secret');
  });

  it('surfaces the backend failure when no login URL can be obtained', async () => {
    const api = fakeApiClient({
      loginUrl: async () => ({
        ok: false,
        reason: 'SECRET_MISSING',
        detail: "secret 'kite-api-key' is not set",
        status: 503,
      }),
    });
    const result = await runBrokerLogin('kite', { api, openAuthSession: jest.fn() });
    expect(result).toMatchObject({ ok: false, reason: 'SECRET_MISSING' });
  });

  it('surfaces a failing callback exchange', async () => {
    const api = fakeApiClient({
      loginUrl: async () => ({
        ok: true,
        broker: 'kite',
        url: 'https://k/login',
        verifyLive: false,
      }),
      completeLogin: async () => ({
        ok: false,
        reason: 'EXCHANGE_FAILED',
        detail: 'broker rejected the request token',
        status: 502,
      }),
    });
    const result = await runBrokerLogin('kite', {
      api,
      openAuthSession: async () => ({ type: 'success', url: SUCCESS_REDIRECT }) as never,
    });
    expect(result).toMatchObject({ ok: false, reason: 'EXCHANGE_FAILED' });
  });
});
