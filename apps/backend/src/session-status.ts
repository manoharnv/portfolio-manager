/**
 * Session validity — the pre-execution refusal of docs/04 §4.6 ("a
 * pre-execution check refuses if the token is expired or within a small margin
 * of expiry") and docs/02 §2.8.
 *
 * Deliberately mirrors core's `sessionValid` guardrail so the early 409 and the
 * authoritative suite can never disagree: the full suite still runs, this just
 * gives the app the specific "needs re-login" answer before any live data is
 * fetched. Pure — `now` is a parameter.
 */

import { SESSION_EXPIRY_MARGIN_SECONDS } from '@pm/core';
import type { Broker, SessionStatus } from '@pm/core';
import type { BrokerSession } from '@pm/core';

/** Firestore session metadata → the neutral status core's guardrails consume. */
export function toSessionStatus(session: BrokerSession): SessionStatus {
  return {
    broker: session.broker,
    connected: session.connected,
    staticIpOk: session.staticIpOk,
    ...(session.expiresAt === null ? {} : { expiresAt: session.expiresAt }),
  };
}

/**
 * `undefined` when the session may be used to place an order; otherwise a
 * human-readable reason it may not. Missing evidence is a refusal, never a skip.
 */
export function sessionRefusal(
  session: SessionStatus | undefined,
  activeBroker: Broker,
  now: Date,
  marginSeconds: number = SESSION_EXPIRY_MARGIN_SECONDS,
): string | undefined {
  if (session === undefined) return 'no broker session — re-login required';
  if (session.broker !== activeBroker) {
    return `session is for '${session.broker}' but activeBroker is '${activeBroker}'`;
  }
  if (!session.connected) return `broker '${session.broker}' not connected — re-login required`;
  if (session.staticIpOk === false) {
    return 'last order call was IP-rejected (staticIpOk=false)';
  }
  if (session.expiresAt === undefined) return 'session token expiry unknown';
  const expiresAt = Date.parse(session.expiresAt);
  if (Number.isNaN(expiresAt)) return `unparseable session expiry: ${session.expiresAt}`;
  if (expiresAt - now.getTime() <= marginSeconds * 1000) {
    return `session expires at ${session.expiresAt}, within the ${marginSeconds}s safety margin`;
  }
  return undefined;
}
