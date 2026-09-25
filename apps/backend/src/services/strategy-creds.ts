/**
 * Keeps the strategy engine's READ credentials in step with the daily login.
 *
 * The engine (apps/strategy) never touches a login flow: it reads one Secret
 * Manager secret whose payload is `@pm/core`'s `BrokerCreds`
 * (infra/terraform/secrets.tf `pm-strategy-read-creds`). After every
 * successful broker login the backend rewrites that secret here — today's
 * token, its expiry, and which broker is active — so the engine's next start
 * sees the live session. Both brokers' credentials are kept side by side;
 * `broker` names the one the engine should drive.
 *
 * Best-effort by design: a failure here must never turn a successful broker
 * login into a reported failure. It is logged and the outcome returned; the
 * backend's own session state (and `/v1/session`) is already correct.
 */

import type { Broker, BrokerCreds } from '@pm/core';
import type { Logger } from '../logger.js';
import type { SecretStore } from '../ports/index.js';

export interface StrategyCredsSyncDeps {
  secrets: SecretStore;
  /** Secret Manager id; `''` disables the sync entirely. */
  secretName: string;
  logger?: Logger | undefined;
}

export interface StrategyCredsUpdate {
  /** The broker that just logged in. */
  broker: Broker;
  /** `config.activeBroker` at that moment — the engine follows it; absent ⇒ the login's broker. */
  activeBroker: Broker | undefined;
  dhan?: { clientId: string; accessToken: string; expiresAt: string } | undefined;
  kite?: { apiKey: string; accessToken: string; expiresAt: string } | undefined;
}

export type StrategyCredsSyncOutcome = 'written' | 'skipped' | 'failed';

export interface StrategyCredsSync {
  /** Merge one broker's fresh session into the secret. */
  update(input: StrategyCredsUpdate): Promise<StrategyCredsSyncOutcome>;
  /** Re-point `broker` after an active-broker switch; credentials untouched. */
  setActive(broker: Broker): Promise<StrategyCredsSyncOutcome>;
}

type StoredCreds = Pick<BrokerCreds, 'dhan' | 'kite'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Whatever is currently stored, minus anything that is not a credentials object. */
function parseStored(value: string | undefined): StoredCreds {
  if (value === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const out: StoredCreds = {};
  if (isRecord(parsed['dhan'])) out.dhan = parsed['dhan'] as BrokerCreds['dhan'];
  if (isRecord(parsed['kite'])) out.kite = parsed['kite'] as BrokerCreds['kite'];
  return out;
}

export function createStrategyCredsSync(deps: StrategyCredsSyncDeps): StrategyCredsSync {
  const enabled = deps.secretName !== '';

  async function stored(): Promise<StoredCreds> {
    try {
      return parseStored((await deps.secrets.get(deps.secretName))?.value);
    } catch {
      return {};
    }
  }

  /**
   * Written bare — no `expiresAt` on the SecretValue — so the engine can parse
   * the payload straight into `BrokerCreds` (each broker's own `expiresAt` is
   * inside the JSON already).
   */
  async function write(next: BrokerCreds): Promise<'written' | 'failed'> {
    try {
      await deps.secrets.set(deps.secretName, { value: JSON.stringify(next) });
      return 'written';
    } catch (err) {
      deps.logger?.warn(
        { err: err instanceof Error ? err.message : String(err), secret: deps.secretName },
        'strategy read-creds sync failed — the engine keeps its previous credentials',
      );
      return 'failed';
    }
  }

  return {
    async update(input: StrategyCredsUpdate): Promise<StrategyCredsSyncOutcome> {
      if (!enabled) return 'skipped';
      const current = await stored();
      const dhan = input.dhan ?? current.dhan;
      const kite = input.kite ?? current.kite;
      const next: BrokerCreds = {
        broker: input.activeBroker ?? input.broker,
        ...(dhan === undefined ? {} : { dhan }),
        ...(kite === undefined ? {} : { kite }),
      };
      return write(next);
    },

    async setActive(broker: Broker): Promise<StrategyCredsSyncOutcome> {
      if (!enabled) return 'skipped';
      const current = await stored();
      const creds = current[broker];
      if (creds === undefined) {
        deps.logger?.warn(
          { broker },
          'no strategy read-creds stored for the new active broker — the engine keeps the previous one until that broker logs in',
        );
        return 'skipped';
      }
      return write({ broker, ...current });
    },
  };
}
