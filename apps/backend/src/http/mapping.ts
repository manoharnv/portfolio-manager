/**
 * Service result → HTTP, per docs/04 §4.3/§4.4.
 *
 * Kept pure and separate from the routes so the status-code contract is one
 * readable table rather than something scattered across handlers:
 *
 * | reason            | code | why                                            |
 * |-------------------|------|------------------------------------------------|
 * | UNAUTHORIZED      | 401  | flowchart X1                                    |
 * | STALE_PROPOSAL    | 409  | X2 — stale/expired                              |
 * | HALTED            | 423  | X3 — kill switch / tradingEnabled (Locked)      |
 * | MARKET_CLOSED     | 409  | X4                                              |
 * | SESSION_INVALID   | 409  | X5 — needs re-login                             |
 * | GUARDRAIL_BLOCKED | 200  | X6 — `ok:false` + `failedChecks` (§4.3 body)    |
 * | BUDGET_EXCEEDED   | 200  | guardrail-class refusal (docs/10 §10.3)         |
 * | OWNERSHIP         | 200  | guardrail-class refusal (docs/10 §10.4)         |
 * | PRICE_MOVED       | 409  | X7 — re-confirm at the new price                |
 * | IDEMPOTENT_REPLAY | 409  | a burned key is never re-run                    |
 * | BROKER_ERROR      | 502  | upstream failure, with the typed `kind`         |
 */

import type { BrokerErrorKind } from '@pm/core';
import type { ExecutionResult } from '../services/execution.js';

export interface HttpOutcome {
  status: number;
  body: Record<string, unknown>;
}

const EXECUTION_STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  IDEMPOTENT_REPLAY: 409,
  STALE_PROPOSAL: 409,
  HALTED: 423,
  MARKET_CLOSED: 409,
  SESSION_INVALID: 409,
  GUARDRAIL_BLOCKED: 200,
  PRICE_MOVED: 409,
  BUDGET_EXCEEDED: 200,
  OWNERSHIP: 200,
  BROKER_ERROR: 502,
};

export function executionOutcome(result: ExecutionResult): HttpOutcome {
  if (result.ok) {
    return {
      status: 200,
      body: {
        ok: true,
        orderId: result.orderId,
        brokerOrderId: result.brokerOrderId,
        status: result.status,
      },
    };
  }
  const status = EXECUTION_STATUS[result.reason] ?? 500;
  const body: Record<string, unknown> = {
    ok: false,
    reason: result.reason,
    detail: result.detail,
  };
  if (result.failedChecks !== undefined) body['failedChecks'] = result.failedChecks;
  if (result.brokerErrorKind !== undefined) body['brokerErrorKind'] = result.brokerErrorKind;
  if (result.reason === 'SESSION_INVALID') body['needsLogin'] = true;
  return { status, body };
}

/**
 * `BrokerError` kinds → HTTP. Everything is a 502 *except* `AUTH_EXPIRED`, which
 * is a 409 telling the app to re-login (docs/04 §4.10).
 */
export function brokerErrorStatus(kind: BrokerErrorKind): number {
  return kind === 'AUTH_EXPIRED' ? 409 : 502;
}

const SIMPLE_STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  NOT_CANCELLABLE: 409,
  STALE_PROPOSAL: 409,
  SESSION_INVALID: 409,
  INVALID_PAYLOAD: 400,
  SECRET_MISSING: 503,
  EXCHANGE_FAILED: 502,
  BROKER_ERROR: 502,
};

/** Status for the smaller services (reject/cancel/session/portfolio/orders). */
export function simpleStatus(reason: string): number {
  return SIMPLE_STATUS[reason] ?? 500;
}

export function failureBody(
  reason: string,
  detail: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ok: false,
    reason,
    detail,
    ...(reason === 'SESSION_INVALID' ? { needsLogin: true } : {}),
    ...extra,
  };
}
