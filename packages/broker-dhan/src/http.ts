/**
 * The transport seam.
 *
 * Everything in this package talks to Dhan through {@link HttpClient} and never
 * touches `fetch` directly, so unit tests inject a fake and docs/00 §0.5's "no
 * network in unit tests, ever" holds structurally rather than by discipline.
 *
 * Requests and responses are deliberately dumb value objects (strings in,
 * strings out): the wire layer owns JSON encoding/decoding so that a malformed
 * payload is a *parsing* failure with the raw text attached, not a transport
 * failure that has already thrown away the evidence.
 */

import { BrokerError } from '@pm/core';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string | undefined;
  /** Per-request override of the client's default timeout. */
  timeoutMs?: number | undefined;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** Conservative default: an order API that has not answered in 10s is a NETWORK failure. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface FetchHttpClientOptions {
  /** Injectable for tests; defaults to the global `fetch` (Node ≥ 22). */
  fetchImpl?: typeof globalThis.fetch | undefined;
  defaultTimeoutMs?: number | undefined;
}

/**
 * Turn a thrown transport error into a typed {@link BrokerError} of kind
 * `NETWORK`. An `AbortError` is our own timeout firing, so it is reported as
 * one — the caller must treat it as "did not place" (docs/02 §2.1).
 */
export function toNetworkError(err: unknown, timeoutMs: number): BrokerError {
  const aborted =
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError';
  if (aborted) {
    return new BrokerError('NETWORK', `Dhan request timed out after ${timeoutMs}ms`, err);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new BrokerError('NETWORK', `Dhan request failed: ${message}`, err);
}

/** Default {@link HttpClient} over global `fetch` with an AbortController timeout. */
export function createFetchHttpClient(opts: FetchHttpClientOptions = {}): HttpClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      if (typeof fetchImpl !== 'function') {
        throw new BrokerError('NETWORK', 'No fetch implementation available (Node ≥ 22 required)');
      }
      const timeoutMs = req.timeoutMs ?? defaultTimeoutMs;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        const res = await fetchImpl(req.url, {
          method: req.method,
          headers: req.headers,
          ...(req.body === undefined ? {} : { body: req.body }),
          signal: controller.signal,
        });
        const bodyText = await res.text();
        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        return { status: res.status, headers, bodyText };
      } catch (err) {
        throw toNetworkError(err, timeoutMs);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
