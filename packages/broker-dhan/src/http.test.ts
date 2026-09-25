import { BrokerError } from '@pm/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEOUT_MS, createFetchHttpClient, toNetworkError } from './http.js';

/** Minimal `Response` stand-in — no network, no undici. */
function fakeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): unknown {
  return {
    status,
    text: () => Promise.resolve(bodyText),
    headers: {
      forEach: (cb: (value: string, key: string) => void) => {
        for (const [key, value] of Object.entries(headers)) cb(value, key);
      },
    },
  };
}

type FetchImpl = typeof globalThis.fetch;

describe('createFetchHttpClient', () => {
  it('passes method, url, headers and body through and normalises response headers', async () => {
    const calls: { url: unknown; init: RequestInit | undefined }[] = [];
    const fetchImpl = ((url: unknown, init: RequestInit | undefined) => {
      calls.push({ url, init });
      return Promise.resolve(
        fakeResponse(200, '{"ok":true}', { 'Content-Type': 'application/json' }),
      );
    }) as unknown as FetchImpl;

    const client = createFetchHttpClient({ fetchImpl });
    const res = await client.request({
      method: 'POST',
      url: 'https://dhan.test/v2/orders',
      headers: { 'access-token': 'x' },
      body: '{"a":1}',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://dhan.test/v2/orders');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.headers).toEqual({ 'access-token': 'x' });
    expect(calls[0]!.init?.body).toBe('{"a":1}');
    expect(res).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyText: '{"ok":true}',
    });
  });

  it('omits the body entirely for GET/DELETE', async () => {
    let init: RequestInit | undefined;
    const fetchImpl = ((_url: unknown, i: RequestInit | undefined) => {
      init = i;
      return Promise.resolve(fakeResponse(200, '[]'));
    }) as unknown as FetchImpl;

    await createFetchHttpClient({ fetchImpl }).request({
      method: 'GET',
      url: 'https://dhan.test/v2/orders',
      headers: {},
    });
    expect(init).toBeDefined();
    expect('body' in (init as object)).toBe(false);
  });

  it('aborts after the timeout and reports NETWORK', async () => {
    const fetchImpl = ((_url: unknown, init: RequestInit | undefined) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as unknown as FetchImpl;

    const client = createFetchHttpClient({ fetchImpl, defaultTimeoutMs: 5 });
    const err = await client
      .request({ method: 'GET', url: 'https://dhan.test/v2/orders', headers: {} })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BrokerError);
    expect((err as BrokerError).kind).toBe('NETWORK');
    expect((err as BrokerError).message).toContain('timed out after 5ms');
  });

  it('honours a per-request timeout override', async () => {
    const fetchImpl = ((_url: unknown, init: RequestInit | undefined) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as unknown as FetchImpl;

    const err = await createFetchHttpClient({ fetchImpl, defaultTimeoutMs: 60_000 })
      .request({ method: 'GET', url: 'https://dhan.test/v2/orders', headers: {}, timeoutMs: 5 })
      .catch((e: unknown) => e);

    expect((err as BrokerError).message).toContain('timed out after 5ms');
  });

  it('maps a transport failure to NETWORK', async () => {
    const fetchImpl = (() =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as unknown as FetchImpl;

    const err = await createFetchHttpClient({ fetchImpl })
      .request({ method: 'GET', url: 'https://dhan.test/v2/orders', headers: {} })
      .catch((e: unknown) => e);

    expect((err as BrokerError).kind).toBe('NETWORK');
    expect((err as BrokerError).message).toContain('ENOTFOUND');
  });

  it('fails closed when no fetch implementation exists', async () => {
    const client = createFetchHttpClient({ fetchImpl: undefined as unknown as FetchImpl });
    // Force the "no fetch" branch even on a runtime that has one.
    const broken = createFetchHttpClient({ fetchImpl: 'not-a-function' as unknown as FetchImpl });
    expect(client).toBeDefined();
    const err = await broken
      .request({ method: 'GET', url: 'https://dhan.test/v2/orders', headers: {} })
      .catch((e: unknown) => e);
    expect((err as BrokerError).kind).toBe('NETWORK');
  });

  it('defaults to a 10s timeout', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
  });
});

describe('toNetworkError', () => {
  it('surfaces the cause fetch hides behind "fetch failed"', () => {
    const cause = Object.assign(new Error('connect ENETUNREACH 108.158.46.69:443'), {
      code: 'ENETUNREACH',
    });
    const err = toNetworkError(new TypeError('fetch failed', { cause }), 1000);
    expect(err.message).toBe(
      'Dhan request failed: fetch failed (ENETUNREACH: connect ENETUNREACH 108.158.46.69:443)',
    );
  });

  it('stringifies a non-Error rejection', () => {
    const err = toNetworkError('socket hang up', 1000);
    expect(err.kind).toBe('NETWORK');
    expect(err.message).toContain('socket hang up');
  });
});
