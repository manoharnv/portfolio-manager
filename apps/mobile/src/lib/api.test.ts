import {
  EXECUTION_REASONS,
  TRANSPORT_REASONS,
  createApiClient,
  describeReason,
  isExecutionReason,
  isFailure,
  safeErrorDetail,
  type ApiClient,
  type ApiReason,
} from './api';

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1MSJ9.signature-part-here';

interface Call {
  url: string;
  init: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function harness(
  responder: (call: Call) => Response | Promise<Response>,
  options: { token?: string; tokenError?: Error } = {},
): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = createApiClient({
    baseUrl: 'https://backend.test/',
    getIdToken: async () => {
      if (options.tokenError !== undefined) throw options.tokenError;
      return options.token ?? TOKEN;
    },
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return responder({ url, init });
    }) as unknown as typeof fetch,
  });
  return { client, calls };
}

describe('auth header', () => {
  it('sends the Firebase ID token as a bearer token on an authenticated route', async () => {
    const { client, calls } = harness(() =>
      jsonResponse(200, { ok: true, activeBroker: 'kite', brokers: [] }),
    );
    const result = await client.session();

    expect(result.ok).toBe(true);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.url).toBe('https://backend.test/v1/session');
  });

  it('does not send a token to /health — the only public route', async () => {
    const { client, calls } = harness(() => jsonResponse(200, { ok: true, status: 'ok' }));
    await client.health();
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBeUndefined();
  });

  it('fails with CONFIG rather than calling fetch when no token can be minted', async () => {
    const { client, calls } = harness(() => jsonResponse(200, { ok: true }), {
      tokenError: new Error('not signed in'),
    });
    const result = await client.session();

    expect(isFailure(result)).toBe(true);
    expect((result as { reason: ApiReason }).reason).toBe('CONFIG');
    expect(calls).toHaveLength(0);
  });

  it('sets a JSON content-type only when there is a body', async () => {
    const { client, calls } = harness(() => jsonResponse(200, { ok: true, enabled: true }));
    await client.setKillSwitch(true, 'because');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      enabled: true,
      reason: 'because',
    });
  });

  it('omits the optional reason when it is not supplied', async () => {
    const { client, calls } = harness(() => jsonResponse(200, { ok: true, enabled: false }));
    await client.setKillSwitch(false);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ enabled: false });
  });
});

describe('execute', () => {
  it('returns the order ids on success', async () => {
    const { client, calls } = harness(() =>
      jsonResponse(200, {
        ok: true,
        orderId: 'o1',
        brokerOrderId: 'BRK-1',
        status: 'SUBMITTED',
      }),
    );
    const result = await client.executeProposal('p1', {
      idempotencyKey: 'pm-key-0001',
      clientSeenLtp: 1500,
    });

    expect(result).toEqual({
      ok: true,
      orderId: 'o1',
      brokerOrderId: 'BRK-1',
      status: 'SUBMITTED',
    });
    expect(calls[0]?.url).toBe('https://backend.test/v1/proposals/p1/execute');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      idempotencyKey: 'pm-key-0001',
      clientSeenLtp: 1500,
    });
  });

  it('percent-encodes the proposal id into the path', async () => {
    const { client, calls } = harness(() => jsonResponse(200, { ok: true, orderId: 'o1' }));
    await client.executeProposal('a/b?c', { idempotencyKey: 'k', clientSeenLtp: 1 });
    expect(calls[0]?.url).toBe('https://backend.test/v1/proposals/a%2Fb%3Fc/execute');
  });

  // docs/04 §4.3 — the full ExecuteResult union with its HTTP status.
  const CASES: [ApiReason, number][] = [
    ['UNAUTHORIZED', 401],
    ['IDEMPOTENT_REPLAY', 409],
    ['STALE_PROPOSAL', 409],
    ['HALTED', 423],
    ['MARKET_CLOSED', 409],
    ['SESSION_INVALID', 409],
    ['GUARDRAIL_BLOCKED', 200],
    ['PRICE_MOVED', 409],
    ['BUDGET_EXCEEDED', 200],
    ['OWNERSHIP', 200],
    ['BROKER_ERROR', 502],
  ];

  it.each(CASES)('maps %s (HTTP %i) to a rendered failure', async (reason, status) => {
    const { client } = harness(() =>
      jsonResponse(status, { ok: false, reason, detail: `detail for ${reason}` }),
    );
    const result = await client.executeProposal('p1', {
      idempotencyKey: 'k',
      clientSeenLtp: 1,
    });

    expect(isFailure(result)).toBe(true);
    if (!isFailure(result)) return;
    expect(result.reason).toBe(reason);
    expect(result.status).toBe(status);
    expect(result.detail).toBe(`detail for ${reason}`);

    const copy = describeReason(result.reason);
    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.message.length).toBeGreaterThan(0);
  });

  it('carries failedChecks through on GUARDRAIL_BLOCKED', async () => {
    const failedChecks = [{ name: 'dailyNotional', ok: false, detail: 'over the daily cap' }];
    const { client } = harness(() =>
      jsonResponse(200, {
        ok: false,
        reason: 'GUARDRAIL_BLOCKED',
        detail: 'blocked',
        failedChecks,
      }),
    );
    const result = await client.executeProposal('p1', { idempotencyKey: 'k', clientSeenLtp: 1 });

    expect(isFailure(result) && result.failedChecks).toEqual(failedChecks);
  });

  it('carries brokerErrorKind and needsLogin through', async () => {
    const { client } = harness(() =>
      jsonResponse(409, {
        ok: false,
        reason: 'SESSION_INVALID',
        detail: 'expired',
        needsLogin: true,
        brokerErrorKind: 'AUTH_EXPIRED',
      }),
    );
    const result = await client.executeProposal('p1', { idempotencyKey: 'k', clientSeenLtp: 1 });

    expect(isFailure(result) && result.needsLogin).toBe(true);
    expect(isFailure(result) && result.brokerErrorKind).toBe('AUTH_EXPIRED');
  });
});

describe('HTTP status handling', () => {
  it.each([
    [401, { ok: false, reason: 'UNAUTHENTICATED', detail: 'invalid token' }, 'UNAUTHENTICATED'],
    [403, { ok: false, reason: 'FORBIDDEN', detail: 'not allowlisted' }, 'FORBIDDEN'],
    [409, { ok: false, reason: 'NOT_CANCELLABLE', detail: 'already filled' }, 'NOT_CANCELLABLE'],
    [423, { ok: false, reason: 'HALTED', detail: 'kill switch' }, 'HALTED'],
    [429, { ok: false, reason: 'RATE_LIMITED', detail: 'slow down' }, 'RATE_LIMITED'],
    [502, { ok: false, reason: 'BROKER_ERROR', detail: 'upstream' }, 'BROKER_ERROR'],
  ])('maps HTTP %i to %s', async (status, body, expected) => {
    const { client } = harness(() => jsonResponse(status, body));
    const result = await client.cancelOrder('o1');
    expect(isFailure(result) && result.reason).toBe(expected);
  });

  it('falls back to a status-derived reason when the body has none', async () => {
    const { client } = harness(() => jsonResponse(404, {}));
    const result = await client.order('o1');
    expect(isFailure(result) && result.reason).toBe('NOT_FOUND');
    // With no `detail`, the human still gets the catalogue copy.
    expect(isFailure(result) && result.detail).toBe(describeReason('NOT_FOUND').message);
  });

  it('falls back to INTERNAL for an unmapped status', async () => {
    const { client } = harness(() => jsonResponse(418, { detail: 'teapot' }));
    const result = await client.order('o1');
    expect(isFailure(result) && result.reason).toBe('INTERNAL');
  });

  it('ignores an unrecognised reason string and grades on the status', async () => {
    const { client } = harness(() => jsonResponse(403, { ok: false, reason: 'WAT' }));
    const result = await client.session();
    expect(isFailure(result) && result.reason).toBe('FORBIDDEN');
  });

  it('survives a non-JSON body', async () => {
    const { client } = harness(
      () =>
        ({
          ok: false,
          status: 502,
          json: async () => {
            throw new Error('not json');
          },
        }) as unknown as Response,
    );
    const result = await client.session();
    expect(isFailure(result) && result.reason).toBe('BROKER_ERROR');
  });

  it('treats HTTP 200 with ok:false as a failure, not a payload', async () => {
    const { client } = harness(() =>
      jsonResponse(200, { ok: false, reason: 'BUDGET_EXCEEDED', detail: 'no headroom' }),
    );
    const result = await client.executeProposal('p1', { idempotencyKey: 'k', clientSeenLtp: 1 });
    expect(isFailure(result)).toBe(true);
  });
});

describe('transport failures', () => {
  it('reports NETWORK when fetch rejects', async () => {
    const { client } = harness(() => {
      throw new Error('Network request failed');
    });
    const result = await client.session();
    expect(isFailure(result) && result.reason).toBe('NETWORK');
    expect(isFailure(result) && result.status).toBe(0);
  });

  it('reports TIMEOUT when the request outlives its budget', async () => {
    jest.useFakeTimers();
    const client = createApiClient({
      baseUrl: 'https://backend.test',
      getIdToken: async () => TOKEN,
      timeoutMs: 50,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
        })) as unknown as typeof fetch,
    });

    const pending = client.session();
    // `advanceTimersByTimeAsync` lets the awaited `getIdToken` microtask run
    // first, so the abort timer actually exists by the time it is advanced.
    await jest.advanceTimersByTimeAsync(60);
    const result = await pending;

    expect(isFailure(result) && result.reason).toBe('TIMEOUT');
    jest.useRealTimers();
  });

  it('never lets a token reach a failure detail', async () => {
    const { client } = harness(() => {
      throw new Error(`fetch failed for Authorization: Bearer ${TOKEN}`);
    });
    const result = await client.session();

    expect(isFailure(result)).toBe(true);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain('eyJ');
    expect(isFailure(result) && result.detail).toContain('[redacted]');
  });
});

describe('safeErrorDetail', () => {
  it('redacts bearer tokens and bare JWTs, and truncates', () => {
    expect(safeErrorDetail(new Error(`Bearer ${TOKEN}`))).toBe('Bearer [redacted]');
    expect(safeErrorDetail(new Error(`token=${TOKEN} failed`))).toContain('[redacted]');
    expect(safeErrorDetail('x'.repeat(1000))).toHaveLength(300);
  });

  it('stringifies non-Error throws', () => {
    expect(safeErrorDetail({ nope: 1 })).toBe('[object Object]');
  });
});

describe('reason catalogue', () => {
  it('has copy for every reason the app can produce', () => {
    for (const reason of [...EXECUTION_REASONS, ...TRANSPORT_REASONS]) {
      const copy = describeReason(reason);
      expect(copy.title).toBeTruthy();
      expect(copy.message).toBeTruthy();
      expect(['danger', 'warn', 'info']).toContain(copy.tone);
    }
  });

  it('marks PRICE_MOVED and SESSION_INVALID as retryable and STALE_PROPOSAL as not', () => {
    expect(describeReason('PRICE_MOVED').retryable).toBe(true);
    expect(describeReason('SESSION_INVALID').retryable).toBe(true);
    expect(describeReason('STALE_PROPOSAL').retryable).toBe(false);
  });

  it('classifies execution reasons', () => {
    expect(isExecutionReason('PRICE_MOVED')).toBe(true);
    expect(isExecutionReason('NETWORK')).toBe(false);
  });
});

describe('the remaining routes', () => {
  it('calls the documented paths', async () => {
    const { client, calls } = harness(() => jsonResponse(200, { ok: true, at: 'now' }));
    await client.holdings();
    await client.positions();
    await client.funds();
    await client.loginUrl('kite');
    await client.completeLogin('kite', { requestToken: 'rt' });
    await client.order('o1');
    await client.cancelOrder('o1');

    expect(calls.map((c) => c.url)).toEqual([
      'https://backend.test/v1/portfolio/holdings',
      'https://backend.test/v1/portfolio/positions',
      'https://backend.test/v1/portfolio/funds',
      'https://backend.test/v1/auth/kite/login-url',
      'https://backend.test/v1/auth/kite/callback',
      'https://backend.test/v1/orders/o1',
      'https://backend.test/v1/orders/o1/cancel',
    ]);
  });
});
