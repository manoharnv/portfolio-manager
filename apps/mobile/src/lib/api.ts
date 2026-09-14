/**
 * The execution-backend client — docs/04 §4.3, docs/06 §6.2/§6.7.
 *
 * Contract kept deliberately narrow:
 *   - Every request but `/health` carries `Authorization: Bearer <Firebase ID
 *     token>`, fetched fresh from the SDK per call so an expired token
 *     self-heals.
 *   - Every response is normalised into `ApiResult` — an `ok:true` payload or an
 *     `ApiFailure` carrying the backend's own `reason`. Nothing throws for a
 *     *protocol* failure; only programmer errors (bad config) throw.
 *   - A token never reaches a log, an error message or a thrown object. The
 *     header is built at the last moment and the value is never stored.
 *   - Every call is bounded by an AbortController timeout. A hung backend must
 *     degrade to "execution unavailable" (docs/06 §6.6), not to a spinner.
 */
import type {
  Broker,
  BrokerErrorKind,
  Funds,
  GuardrailCheck,
  Holding,
  OrderRecord,
  OrderStatusCode,
  Position,
  Quote,
  SessionStatus,
} from '@pm/core';

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

/** The `ExecuteResult` union from apps/backend/src/services/execution.ts. */
export const EXECUTION_REASONS = [
  'UNAUTHORIZED',
  'IDEMPOTENT_REPLAY',
  'STALE_PROPOSAL',
  'HALTED',
  'MARKET_CLOSED',
  'SESSION_INVALID',
  'GUARDRAIL_BLOCKED',
  'PRICE_MOVED',
  'BUDGET_EXCEEDED',
  'OWNERSHIP',
  'BROKER_ERROR',
] as const;
export type ExecutionReason = (typeof EXECUTION_REASONS)[number];

/** Everything else the HTTP surface can answer, plus the client-side failures. */
export const TRANSPORT_REASONS = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'NOT_FOUND',
  'NOT_CANCELLABLE',
  'INVALID_REQUEST',
  'INVALID_PAYLOAD',
  'SECRET_MISSING',
  'EXCHANGE_FAILED',
  'NOT_IMPLEMENTED',
  'INTERNAL',
  /** Client-side: request never completed. */
  'NETWORK',
  'TIMEOUT',
  /** Client-side: the app is not configured / not signed in. */
  'CONFIG',
] as const;
export type TransportReason = (typeof TRANSPORT_REASONS)[number];

export type ApiReason = ExecutionReason | TransportReason;

export interface ApiFailure {
  ok: false;
  reason: ApiReason;
  detail: string;
  /** HTTP status, or 0 when the request never reached the backend. */
  status: number;
  /** GUARDRAIL_BLOCKED only — the failed checks, for the checklist. */
  failedChecks?: GuardrailCheck[] | undefined;
  brokerErrorKind?: BrokerErrorKind | undefined;
  /** Set by the backend on SESSION_INVALID. */
  needsLogin?: boolean | undefined;
}

export type ApiResult<T> = ({ ok: true } & T) | ApiFailure;

export function isFailure<T>(result: ApiResult<T>): result is ApiFailure {
  return result.ok === false;
}

const EXECUTION_SET: ReadonlySet<string> = new Set(EXECUTION_REASONS);
const TRANSPORT_SET: ReadonlySet<string> = new Set(TRANSPORT_REASONS);

export function isExecutionReason(value: string): value is ExecutionReason {
  return EXECUTION_SET.has(value);
}

function coerceReason(value: unknown, status: number): ApiReason {
  if (typeof value === 'string' && (EXECUTION_SET.has(value) || TRANSPORT_SET.has(value))) {
    return value as ApiReason;
  }
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 423) return 'HALTED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 501) return 'NOT_IMPLEMENTED';
  if (status === 502 || status === 503 || status === 504) return 'BROKER_ERROR';
  return 'INTERNAL';
}

// ---------------------------------------------------------------------------
// Human copy — every reason renders meaningfully (docs/06 §6.1 "fail visible")
// ---------------------------------------------------------------------------

export interface ReasonCopy {
  title: string;
  message: string;
  /** What the human can do about it, if anything. */
  action?: string | undefined;
  tone: 'danger' | 'warn' | 'info';
  /** true ⇒ refreshing the quote and approving again is the right next step. */
  retryable: boolean;
}

const REASON_COPY: Record<ApiReason, ReasonCopy> = {
  UNAUTHORIZED: {
    title: 'Not your proposal',
    message: 'This proposal belongs to a different account.',
    tone: 'danger',
    retryable: false,
  },
  IDEMPOTENT_REPLAY: {
    title: 'Already submitted',
    message: 'This approval was already sent — the order was not placed twice.',
    action: 'Check Orders for the live status.',
    tone: 'info',
    retryable: false,
  },
  STALE_PROPOSAL: {
    title: 'Proposal expired',
    message: 'Its TTL elapsed or it is no longer pending, so it can no longer be executed.',
    tone: 'warn',
    retryable: false,
  },
  HALTED: {
    title: 'Trading halted',
    message: 'The kill switch is on, or trading is disabled in settings.',
    action: 'Turn the kill switch off on the dashboard to resume.',
    tone: 'danger',
    retryable: false,
  },
  MARKET_CLOSED: {
    title: 'Market closed',
    message: 'Orders are only accepted between 9:15 am and 3:30 pm IST on trading days.',
    tone: 'warn',
    retryable: false,
  },
  SESSION_INVALID: {
    title: 'Broker session invalid',
    message: 'The daily broker login has expired or was never completed today.',
    action: 'Connect your broker, then approve again.',
    tone: 'warn',
    retryable: true,
  },
  GUARDRAIL_BLOCKED: {
    title: 'Guardrail blocked',
    message: 'One or more guardrails failed on the live numbers.',
    action: 'See the failed checks below.',
    tone: 'danger',
    retryable: false,
  },
  PRICE_MOVED: {
    title: 'Price moved',
    message: 'The live price drifted outside the collar since you looked at it.',
    action: 'Refresh the quote and approve at the new price.',
    tone: 'warn',
    retryable: true,
  },
  BUDGET_EXCEEDED: {
    title: 'Book budget exceeded',
    message: 'This order would push the book past its allocated capital.',
    action: 'Free capital in this book, or raise its allocation in Settings.',
    tone: 'danger',
    retryable: false,
  },
  OWNERSHIP: {
    title: 'Not owned by this book',
    message: 'The ledger says this book does not hold the quantity it is trying to close.',
    tone: 'danger',
    retryable: false,
  },
  BROKER_ERROR: {
    title: 'Broker error',
    message: 'The broker refused or failed the request. Nothing was retried automatically.',
    action: 'Check Orders before trying again.',
    tone: 'danger',
    retryable: true,
  },
  UNAUTHENTICATED: {
    title: 'Signed out',
    message: 'Your sign-in expired.',
    action: 'Sign in again.',
    tone: 'danger',
    retryable: false,
  },
  FORBIDDEN: {
    title: 'Account not permitted',
    message: 'This account is not on the backend allowlist.',
    tone: 'danger',
    retryable: false,
  },
  RATE_LIMITED: {
    title: 'Too many requests',
    message: 'Slow down — the backend rate limit kicked in.',
    action: 'Wait a few seconds and try again.',
    tone: 'warn',
    retryable: true,
  },
  NOT_FOUND: {
    title: 'Not found',
    message: 'The backend has no record of this.',
    tone: 'warn',
    retryable: false,
  },
  NOT_CANCELLABLE: {
    title: 'Cannot cancel',
    message: 'This order is no longer in a cancellable state.',
    tone: 'warn',
    retryable: false,
  },
  INVALID_REQUEST: {
    title: 'Rejected by the backend',
    message: 'The request was malformed. This is a bug — nothing was sent to the broker.',
    tone: 'danger',
    retryable: false,
  },
  INVALID_PAYLOAD: {
    title: 'Invalid payload',
    message: 'The broker callback did not carry what the backend expected.',
    action: 'Start the broker login again.',
    tone: 'danger',
    retryable: true,
  },
  SECRET_MISSING: {
    title: 'Backend not configured',
    message: 'The broker API key is not set on the backend.',
    tone: 'danger',
    retryable: false,
  },
  EXCHANGE_FAILED: {
    title: 'Login exchange failed',
    message: 'The broker rejected the request token.',
    action: 'Start the broker login again.',
    tone: 'danger',
    retryable: true,
  },
  NOT_IMPLEMENTED: {
    title: 'Not available',
    message: 'The backend does not expose this yet.',
    tone: 'info',
    retryable: false,
  },
  INTERNAL: {
    title: 'Backend error',
    message: 'Something failed inside the backend. Nothing was retried automatically.',
    tone: 'danger',
    retryable: true,
  },
  NETWORK: {
    title: 'Backend unreachable',
    message: 'The app could not reach the execution backend.',
    action: 'Approvals stay disabled until it answers.',
    tone: 'danger',
    retryable: true,
  },
  TIMEOUT: {
    title: 'Backend timed out',
    message: 'The backend did not answer in time. The order may or may not have been placed.',
    action: 'Check Orders before approving again.',
    tone: 'danger',
    retryable: true,
  },
  CONFIG: {
    title: 'App not configured',
    message: 'The backend URL or Firebase config is missing from this build.',
    tone: 'danger',
    retryable: false,
  },
};

export function describeReason(reason: ApiReason): ReasonCopy {
  return REASON_COPY[reason];
}

// ---------------------------------------------------------------------------
// Payload shapes (mirrors of apps/backend/src/http/app.ts responses)
// ---------------------------------------------------------------------------

export interface BrokerSessionView extends SessionStatus {
  needsLogin: boolean;
  reason: string | null;
}

export interface SessionPayload {
  activeBroker: Broker | null;
  brokers: BrokerSessionView[];
}

export interface LoginUrlPayload {
  broker: Broker;
  url: string;
  verifyLive: boolean;
}

export interface CompleteLoginPayload {
  broker: Broker;
  connected: true;
  expiresAt: string;
}

export interface ExecutePayload {
  orderId: string;
  brokerOrderId: string;
  status: OrderStatusCode;
}

export interface HealthPayload {
  status: string;
  environment: string;
  time: string;
}

export interface HoldingsPayload {
  at: string;
  holdings: Holding[];
}
export interface PositionsPayload {
  at: string;
  positions: Position[];
}
export interface FundsPayload {
  at: string;
  funds: Funds;
}

export interface OrderPayload {
  order: Omit<OrderRecord, 'brokerRawAck'>;
}

export interface CancelPayload {
  orderId: string;
  status?: OrderStatusCode | undefined;
}

export interface KillSwitchPayload {
  enabled: boolean;
}

export interface ActiveBrokerPayload {
  activeBroker: Broker;
}

export interface QuotesPayload {
  quotes: Quote[];
}

/** `strategies/{uid}/defs/{id}` as the backend echoes it back. */
export interface StrategyDef {
  id: string;
  enabled: boolean;
  params?: Record<string, unknown> | undefined;
  [key: string]: unknown;
}

export interface StrategyPayload {
  def: StrategyDef;
}

export interface StrategyPatch {
  enabled?: boolean | undefined;
  params?: Record<string, unknown> | undefined;
}

/** The backend caps a batch at 20 symbol keys. */
export const MAX_QUOTE_SYMBOLS = 20;

export interface ExecuteRequest {
  idempotencyKey: string;
  clientSeenLtp: number;
  biometricAssertion?: string | undefined;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 12_000;
/** Longer: a place can legitimately sit on a broker round-trip. */
export const EXECUTE_TIMEOUT_MS = 25_000;

export interface ApiClientOptions {
  baseUrl: string;
  getIdToken: (forceRefresh?: boolean) => Promise<string>;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** Injected in tests; production passes nothing and uses real timers. */
  now?: (() => number) | undefined;
}

export interface ApiClient {
  health(): Promise<ApiResult<HealthPayload>>;
  session(): Promise<ApiResult<SessionPayload>>;
  loginUrl(broker: Broker): Promise<ApiResult<LoginUrlPayload>>;
  completeLogin(broker: Broker, payload: unknown): Promise<ApiResult<CompleteLoginPayload>>;
  holdings(): Promise<ApiResult<HoldingsPayload>>;
  positions(): Promise<ApiResult<PositionsPayload>>;
  funds(): Promise<ApiResult<FundsPayload>>;
  executeProposal(id: string, body: ExecuteRequest): Promise<ApiResult<ExecutePayload>>;
  cancelOrder(id: string): Promise<ApiResult<CancelPayload>>;
  order(id: string): Promise<ApiResult<OrderPayload>>;
  setKillSwitch(enabled: boolean, reason?: string): Promise<ApiResult<KillSwitchPayload>>;
  /** `config.activeBroker` is rules-locked; this route is the only way to move it. */
  setActiveBroker(broker: Broker): Promise<ApiResult<ActiveBrokerPayload>>;
  /** Live quotes by `EXCHANGE:SEGMENT:TRADINGSYMBOL`, at most 20 per call. */
  quotes(symbolKeys: readonly string[]): Promise<ApiResult<QuotesPayload>>;
  patchStrategy(strategyId: string, patch: StrategyPatch): Promise<ApiResult<StrategyPayload>>;
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
  /** `/health` is the only route that must not carry a token. */
  anonymous?: boolean;
  timeoutMs?: number;
}

function failure(
  reason: ApiReason,
  detail: string,
  status = 0,
  extra: Partial<ApiFailure> = {},
): ApiFailure {
  return { ok: false, reason, detail, status, ...extra };
}

/**
 * Strips anything that could carry a credential out of a thrown value before it
 * becomes a `detail` string. A fetch rejection can embed the full request — and
 * therefore the Authorization header — in its message on some RN engines.
 */
export function safeErrorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+[\w.~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, '[redacted]')
    .slice(0, 300);
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(opts: RequestOptions): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    if (opts.anonymous !== true) {
      try {
        // Built here and never held anywhere else.
        headers['authorization'] = `Bearer ${await options.getIdToken()}`;
      } catch (error) {
        return failure('CONFIG', `could not obtain an ID token: ${safeErrorDetail(error)}`);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? defaultTimeout);

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${opts.path}`, {
        method: opts.method,
        headers,
        signal: controller.signal,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      return failure(
        aborted ? 'TIMEOUT' : 'NETWORK',
        aborted ? 'the backend did not answer in time' : safeErrorDetail(error),
      );
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }

    const body = (parsed ?? {}) as Record<string, unknown>;

    if (response.ok && body['ok'] !== false) {
      const { ok: _ok, ...rest } = body;
      return { ok: true, ...(rest as T) };
    }

    const reason = coerceReason(body['reason'], response.status);
    const detail =
      typeof body['detail'] === 'string' && body['detail'] !== ''
        ? body['detail']
        : describeReason(reason).message;

    return failure(reason, detail, response.status, {
      ...(Array.isArray(body['failedChecks'])
        ? { failedChecks: body['failedChecks'] as GuardrailCheck[] }
        : {}),
      // `/v1/quotes` spells the typed broker failure `kind`; every other route
      // spells it `brokerErrorKind`. Both land in the same field.
      ...(typeof body['brokerErrorKind'] === 'string'
        ? { brokerErrorKind: body['brokerErrorKind'] as BrokerErrorKind }
        : typeof body['kind'] === 'string'
          ? { brokerErrorKind: body['kind'] as BrokerErrorKind }
          : {}),
      ...(body['needsLogin'] === true ? { needsLogin: true } : {}),
    });
  }

  return {
    health: () =>
      request<HealthPayload>({
        method: 'GET',
        path: '/health',
        anonymous: true,
        timeoutMs: 6_000,
      }),
    session: () => request<SessionPayload>({ method: 'GET', path: '/v1/session' }),
    loginUrl: (broker) =>
      request<LoginUrlPayload>({ method: 'POST', path: `/v1/auth/${broker}/login-url` }),
    completeLogin: (broker, payload) =>
      request<CompleteLoginPayload>({
        method: 'POST',
        path: `/v1/auth/${broker}/callback`,
        body: payload,
      }),
    holdings: () => request<HoldingsPayload>({ method: 'GET', path: '/v1/portfolio/holdings' }),
    positions: () => request<PositionsPayload>({ method: 'GET', path: '/v1/portfolio/positions' }),
    funds: () => request<FundsPayload>({ method: 'GET', path: '/v1/portfolio/funds' }),
    executeProposal: (id, body) =>
      request<ExecutePayload>({
        method: 'POST',
        path: `/v1/proposals/${encodeURIComponent(id)}/execute`,
        body,
        timeoutMs: EXECUTE_TIMEOUT_MS,
      }),
    cancelOrder: (id) =>
      request<CancelPayload>({
        method: 'POST',
        path: `/v1/orders/${encodeURIComponent(id)}/cancel`,
      }),
    order: (id) =>
      request<OrderPayload>({ method: 'GET', path: `/v1/orders/${encodeURIComponent(id)}` }),
    setKillSwitch: (enabled, reason) =>
      request<KillSwitchPayload>({
        method: 'POST',
        path: '/v1/config/killswitch',
        body: { enabled, ...(reason === undefined ? {} : { reason }) },
      }),
    setActiveBroker: (broker) =>
      request<ActiveBrokerPayload>({
        method: 'POST',
        path: '/v1/config/active-broker',
        body: { broker },
      }),
    quotes: (symbolKeys) => {
      // The backend rejects an over-long batch with a 400; truncating here
      // keeps a caller bug from turning into a refused quote fetch.
      const keys = symbolKeys.slice(0, MAX_QUOTE_SYMBOLS);
      const query = new URLSearchParams({ symbols: keys.join(',') }).toString();
      return request<QuotesPayload>({
        method: 'GET',
        path: `/v1/quotes?${query}`,
        // A quote is worthless once it is stale, so it gets a tight budget.
        timeoutMs: 6_000,
      });
    },
    patchStrategy: (strategyId, patch) =>
      request<StrategyPayload>({
        method: 'PATCH',
        path: `/v1/strategies/${encodeURIComponent(strategyId)}`,
        body: {
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.params === undefined ? {} : { params: patch.params }),
        },
      }),
  };
}
