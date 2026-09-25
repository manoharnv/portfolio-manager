/**
 * {@link BrokerGateway} — turns a uid into a usable {@link BrokerAdapter}.
 *
 * This is the only place credentials are assembled, and the only place the
 * dry-run/paper swap happens (docs/04 §4.8): in anything but `prod` the order
 * half of the adapter is the simulator while every *read* still goes to the real
 * broker, so a dry run exercises the same live data prod would see.
 *
 * Fail closed throughout: no config, no session metadata, no token, or a token
 * with no recorded expiry ⇒ {@link SessionUnavailableError}, never an adapter.
 */

import { createAdapter as coreCreateAdapter } from '@pm/core';
import type { Broker, BrokerAdapter, BrokerCreds } from '@pm/core';
import type { BackendEnvironment, BrokerSecretNames } from '../config.js';
import { SimulatedOrderExecutor } from '../simulator.js';
import { toSessionStatus } from '../session-status.js';
import type {
  BrokerContext,
  BrokerGateway,
  Clock,
  ConfigRepo,
  SecretStore,
  SessionStore,
} from '../ports/index.js';
import { SessionUnavailableError } from '../ports/index.js';

export interface BrokerGatewayDeps {
  configs: ConfigRepo;
  sessions: SessionStore;
  secrets: SecretStore;
  clock: Clock;
  environment: BackendEnvironment;
  secretNames: { dhan: BrokerSecretNames; kite: BrokerSecretNames };
  simulatorFillAfterMs: number;
  /** Defaults to core's registry lookup; tests inject a fake adapter factory. */
  createAdapter?: ((creds: BrokerCreds) => BrokerAdapter) | undefined;
}

export function createBrokerGateway(deps: BrokerGatewayDeps): BrokerGateway {
  const build = deps.createAdapter ?? coreCreateAdapter;

  return {
    async forUser(uid: string): Promise<BrokerContext> {
      const config = await deps.configs.get(uid);
      if (config === undefined) {
        throw new SessionUnavailableError('dhan', `no config for uid '${uid}'`);
      }
      const broker: Broker = config.activeBroker;

      const stored = await deps.sessions.get(uid, broker);
      if (stored === undefined) {
        throw new SessionUnavailableError(broker, 'no session recorded — daily login required');
      }

      const names = deps.secretNames[broker];
      const token = await deps.secrets.get(names.accessToken);
      if (token === undefined || token.value.trim() === '') {
        throw new SessionUnavailableError(broker, `secret '${names.accessToken}' is not set`);
      }
      // Prefer the expiry stored *with* the token; the Firestore copy is only
      // metadata and may lag a re-auth.
      const expiresAt = token.expiresAt ?? stored.expiresAt ?? undefined;
      if (expiresAt === undefined) {
        throw new SessionUnavailableError(broker, 'token expiry unknown — refusing to use it');
      }

      const creds = await buildCreds(deps, broker, token.value, expiresAt);
      const real = build(creds);
      const adapter: BrokerAdapter =
        deps.environment === 'prod'
          ? real
          : new SimulatedOrderExecutor({
              read: real,
              clock: deps.clock,
              fillAfterMs: deps.simulatorFillAfterMs,
            });

      return {
        broker,
        adapter,
        session: toSessionStatus({ ...stored, expiresAt }),
      };
    },
  };
}

async function buildCreds(
  deps: BrokerGatewayDeps,
  broker: Broker,
  accessToken: string,
  expiresAt: string,
): Promise<BrokerCreds> {
  const names = deps.secretNames[broker];
  if (broker === 'dhan') {
    const clientId = await deps.secrets.get(names.clientId);
    if (clientId === undefined || clientId.value.trim() === '') {
      throw new SessionUnavailableError(broker, `secret '${names.clientId}' is not set`);
    }
    return { broker, dhan: { clientId: clientId.value, accessToken, expiresAt } };
  }
  const apiKey = await deps.secrets.get(names.apiKey);
  if (apiKey === undefined || apiKey.value.trim() === '') {
    throw new SessionUnavailableError(broker, `secret '${names.apiKey}' is not set`);
  }
  return { broker, kite: { apiKey: apiKey.value, accessToken, expiresAt } };
}
