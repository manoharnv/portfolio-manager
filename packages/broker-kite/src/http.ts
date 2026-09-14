/**
 * Transport-level HTTP abstraction. Nothing here knows about Kite's wire
 * format — that lives in `wire.ts`/`auth.ts`/`instruments.ts`. Isolating this
 * interface is what lets every other module be tested with a `FakeHttpClient`
 * and never touch the network (docs/00-dev-conventions.md §0.5).
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string | undefined;
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

export interface CreateFetchHttpClientOptions {
  /** Applied when a request does not set its own `timeoutMs`. Default 10_000. */
  defaultTimeoutMs?: number | undefined;
  /** Injectable for tests that want to exercise the real client without a real network. */
  fetchImpl?: typeof fetch | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Default {@link HttpClient} backed by the global `fetch`. Applies an
 * `AbortController`-based timeout since `fetch` has no built-in one.
 *
 * Never used directly in unit tests — see `test-utils.ts#FakeHttpClient`.
 */
export function createFetchHttpClient(opts?: CreateFetchHttpClientOptions): HttpClient {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const defaultTimeoutMs = opts?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const controller = new AbortController();
      const timeoutMs = req.timeoutMs ?? defaultTimeoutMs;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const init: RequestInit = {
          method: req.method,
          headers: req.headers,
          signal: controller.signal,
        };
        if (req.body !== undefined) {
          init.body = req.body;
        }
        const res = await fetchImpl(req.url, init);
        const bodyText = await res.text();
        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return { status: res.status, headers, bodyText };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
