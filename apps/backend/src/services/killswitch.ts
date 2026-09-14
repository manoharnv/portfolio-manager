/**
 * `POST /v1/config/killswitch` — docs/04 §4.3, docs/07 §7.8.
 *
 * "`config.killSwitch=true` → backend refuses all orders immediately. Fail-closed:
 * if the backend can't read config, it refuses." Turning the switch *on* must
 * therefore always be possible; the only failure mode here is a config that does
 * not exist, and that already means "refuse everything".
 */

import type { Config } from '@pm/core';
import type { AuditWriter } from './audit.js';
import type { Clock, ConfigRepo } from '../ports/index.js';

export interface KillSwitchInput {
  uid: string;
  enabled: boolean;
  reason?: string | undefined;
}

export type KillSwitchResult =
  { ok: true; killSwitch: boolean } | { ok: false; reason: 'NOT_FOUND'; detail: string };

export interface KillSwitchDeps {
  configs: ConfigRepo;
  audit: AuditWriter;
  clock: Clock;
}

export interface KillSwitchService {
  setKillSwitch(input: KillSwitchInput): Promise<KillSwitchResult>;
}

export function createKillSwitchService(deps: KillSwitchDeps): KillSwitchService {
  return {
    async setKillSwitch(input: KillSwitchInput): Promise<KillSwitchResult> {
      const current: Config | undefined = await deps.configs.get(input.uid);
      if (current === undefined) {
        return {
          ok: false,
          reason: 'NOT_FOUND',
          detail: `no config for uid '${input.uid}' — the backend is already refusing all orders`,
        };
      }
      const updatedAt = deps.clock.now().toISOString();
      const next = await deps.configs.patch(input.uid, { killSwitch: input.enabled, updatedAt });
      await deps.audit.record({
        uid: input.uid,
        type: 'killswitch.toggled',
        actor: 'app-user',
        detail: {
          from: current.killSwitch,
          to: next.killSwitch,
          reason: input.reason ?? null,
        },
      });
      return { ok: true, killSwitch: next.killSwitch };
    },
  };
}
