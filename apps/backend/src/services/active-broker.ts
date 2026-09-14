/**
 * `POST /v1/config/active-broker` — docs/02 §2.4, docs/06 §6.3.
 *
 * Switching brokers is a backend call, not a client write: the Firestore rules
 * (docs/03 §3.9) let the app edit guardrails but never `activeBroker`, because
 * pointing the execution path at a broker with no live session would turn every
 * subsequent approval into a 409 at the worst possible moment.
 *
 * So the switch is gated on the **target** broker's session being usable right
 * now — the same `sessionRefusal` check the execution path runs, read from the
 * same non-secret session metadata.
 */

import type { Broker, Config } from '@pm/core';
import { sessionRefusal, toSessionStatus } from '../session-status.js';
import type { Clock, ConfigRepo, SessionStore } from '../ports/index.js';
import type { AuditWriter } from './audit.js';
import type { StrategyCredsSync } from './strategy-creds.js';

export interface SetActiveBrokerInput {
  uid: string;
  broker: Broker;
}

export type SetActiveBrokerResult =
  | { ok: true; activeBroker: Broker }
  | {
      ok: false;
      reason: 'SESSION_INVALID' | 'NOT_FOUND';
      detail: string;
    };

export interface ActiveBrokerDeps {
  configs: ConfigRepo;
  sessions: SessionStore;
  audit: AuditWriter;
  clock: Clock;
  /** Re-points the strategy engine's read-creds at the new broker; optional in tests. */
  strategyCreds?: StrategyCredsSync | undefined;
}

export interface ActiveBrokerService {
  setActiveBroker(input: SetActiveBrokerInput): Promise<SetActiveBrokerResult>;
}

export function createActiveBrokerService(deps: ActiveBrokerDeps): ActiveBrokerService {
  return {
    async setActiveBroker(input: SetActiveBrokerInput): Promise<SetActiveBrokerResult> {
      const current: Config | undefined = await deps.configs.get(input.uid);
      if (current === undefined) {
        return {
          ok: false,
          reason: 'NOT_FOUND',
          detail: `no config for uid '${input.uid}'`,
        };
      }

      // Gate on the TARGET broker, always — including a switch to the broker
      // that is already active, so "200 OK" never means "and it works" when the
      // token behind it has died.
      const stored = await deps.sessions.get(input.uid, input.broker);
      const status =
        stored === undefined
          ? { broker: input.broker, connected: false, staticIpOk: false }
          : toSessionStatus(stored);
      const problem = sessionRefusal(status, input.broker, deps.clock.now());
      if (problem !== undefined) {
        return {
          ok: false,
          reason: 'SESSION_INVALID',
          detail: `cannot switch to '${input.broker}': ${problem}`,
        };
      }

      // Already there: report success without writing or auditing a non-change.
      if (current.activeBroker === input.broker) {
        return { ok: true, activeBroker: input.broker };
      }

      const next = await deps.configs.patch(input.uid, {
        activeBroker: input.broker,
        updatedAt: deps.clock.now().toISOString(),
      });
      await deps.audit.record({
        uid: input.uid,
        type: 'config.changed',
        actor: 'app-user',
        detail: { field: 'activeBroker', from: current.activeBroker, to: next.activeBroker },
      });
      // Best-effort (services/strategy-creds.ts): the switch itself is done.
      await deps.strategyCreds?.setActive(next.activeBroker);
      return { ok: true, activeBroker: next.activeBroker };
    },
  };
}
