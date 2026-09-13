/**
 * Broker session status, from both sides.
 *
 * `brokerSessions/{uid}/brokers/{broker}` is the Firestore mirror (docs/03
 * §3.5) — it survives the backend being down and is what the dashboard chip
 * reads. `GET /v1/session` is the authoritative grade: only the backend knows
 * whether an order placed *right now* would be refused, and it is also the
 * liveness probe the approval gate uses.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { collection, query } from 'firebase/firestore';
import { BrokerSessionSchema, type BrokerSession } from '@pm/core';
import { backend } from '../lib/backend';
import { getDb } from '../lib/firebase';
import type { SessionPayload } from '../lib/api';
import { describeReason, isFailure } from '../lib/api';
import { useQuerySnapshot, type Subscription } from './firestore';

export function useBrokerSessionDocs(uid: string | undefined): Subscription<BrokerSession[]> {
  const q = useMemo(() => {
    if (uid === undefined) return null;
    return query(collection(getDb(), 'brokerSessions', uid, 'brokers'));
  }, [uid]);

  return useQuerySnapshot(q, BrokerSessionSchema, 'brokerSession');
}

export interface BackendSessionState {
  session: SessionPayload | undefined;
  /** false ⇒ "execution unavailable" (docs/06 §6.6). */
  reachable: boolean;
  loading: boolean;
  error: string | undefined;
  refresh: () => Promise<void>;
}

export const SESSION_POLL_MS = 60_000;

/**
 * Polls `GET /v1/session`. A transport failure marks the backend unreachable —
 * a *protocol* failure (403, 429) does not: the backend answered, so execution
 * is "up" even though this call did not succeed.
 */
export function useBackendSession(
  uid: string | undefined,
  pollMs = SESSION_POLL_MS,
): BackendSessionState {
  const [state, setState] = useState<{
    session: SessionPayload | undefined;
    reachable: boolean;
    loading: boolean;
    error: string | undefined;
  }>({ session: undefined, reachable: true, loading: uid !== undefined, error: undefined });

  const refresh = useCallback(async () => {
    if (uid === undefined) return;
    setState((prev) => ({ ...prev, loading: true }));
    const result = await backend().session();
    if (isFailure(result)) {
      const transport =
        result.reason === 'NETWORK' ||
        result.reason === 'TIMEOUT' ||
        result.reason === 'CONFIG' ||
        result.status >= 500;
      setState({
        session: undefined,
        reachable: !transport,
        loading: false,
        error: `${describeReason(result.reason).title}: ${result.detail}`,
      });
      return;
    }
    const { ok: _ok, ...payload } = result;
    setState({ session: payload, reachable: true, loading: false, error: undefined });
  }, [uid]);

  useEffect(() => {
    if (uid === undefined) {
      setState({ session: undefined, reachable: true, loading: false, error: undefined });
      return;
    }
    void refresh();
    const id = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(id);
  }, [uid, pollMs, refresh]);

  return { ...state, refresh };
}

/** Merged view for the Broker Connect screen. */
export interface BrokerView {
  broker: 'dhan' | 'kite';
  connected: boolean;
  expiresAt: string | null | undefined;
  staticIpOk: boolean;
  lastConnectedAt: string | null | undefined;
  needsLogin: boolean;
  reason: string | null;
  isActive: boolean;
}

export function mergeBrokerViews(
  docs: readonly BrokerSession[],
  session: SessionPayload | undefined,
): BrokerView[] {
  const brokers: ('dhan' | 'kite')[] = ['dhan', 'kite'];
  return brokers.map((broker) => {
    const stored = docs.find((d) => d.broker === broker);
    const live = session?.brokers.find((b) => b.broker === broker);
    return {
      broker,
      connected: live?.connected ?? stored?.connected ?? false,
      expiresAt: live?.expiresAt ?? stored?.expiresAt,
      staticIpOk: live?.staticIpOk ?? stored?.staticIpOk ?? false,
      lastConnectedAt: stored?.lastConnectedAt,
      // Fail closed: with no live grade, assume a login is needed.
      needsLogin: live?.needsLogin ?? true,
      reason: live?.reason ?? (live === undefined ? 'backend has not graded this session' : null),
      isActive: session?.activeBroker === broker,
    };
  });
}
