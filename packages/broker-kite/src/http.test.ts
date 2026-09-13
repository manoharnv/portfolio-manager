import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchHttpClient } from './http.js';

function fakeFetchOnce(status: number, bodyText: string, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(bodyText, { status, headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function neverResolvingFetch() {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createFetchHttpClient', () => {
  it('sends method, headers and body, and maps the response back', async () => {
    const { impl, calls } = fakeFetchOnce(200, '{"ok":true}', {
      'content-type': 'application/json',
    });
    const client = createFetchHttpClient({ fetchImpl: impl });

    const res = await client.request({
      method: 'POST',
      url: 'https://api.kite.trade/orders/regular',
      headers: { Authorization: 'token k:t' },
      body: 'a=1&b=2',
    });

    expect(res.status).toBe(200);
    expect(res.bodyText).toBe('{"ok":true}');
    expect(res.headers['content-type']).toBe('application/json');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.kite.trade/orders/regular');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe('a=1&b=2');
  });

  it('omits `body` from the underlying fetch call when the request has none', async () => {
    const { impl, calls } = fakeFetchOnce(200, '{}');
    const client = createFetchHttpClient({ fetchImpl: impl });

    await client.request({ method: 'GET', url: 'https://api.kite.trade/orders', headers: {} });

    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('applies the default timeout and aborts a hung request', async () => {
    vi.useFakeTimers();
    const client = createFetchHttpClient({
      fetchImpl: neverResolvingFetch(),
      defaultTimeoutMs: 1_000,
    });

    const pending = client.request({
      method: 'GET',
      url: 'https://api.kite.trade/orders',
      headers: {},
    });
    const expectation = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1_000);
    await expectation;
  });

  it('applies a per-request timeoutMs override instead of the default', async () => {
    vi.useFakeTimers();
    const client = createFetchHttpClient({
      fetchImpl: neverResolvingFetch(),
      defaultTimeoutMs: 60_000,
    });

    const pending = client.request({
      method: 'GET',
      url: 'https://api.kite.trade/orders',
      headers: {},
      timeoutMs: 50,
    });
    const expectation = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(50);
    await expectation;
  });

  it('defaults fetchImpl to the global fetch when not overridden', () => {
    // Construction must not throw or require network access.
    expect(() => createFetchHttpClient()).not.toThrow();
  });
});
