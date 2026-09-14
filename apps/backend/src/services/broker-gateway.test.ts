import { beforeEach, describe, expect, it } from 'vitest';
import type { BrokerAdapter, BrokerCreds } from '@pm/core';
import { SessionUnavailableError } from '../ports/index.js';
import { SimulatedOrderExecutor } from '../simulator.js';
import { createBrokerGateway } from './broker-gateway.js';
import type { BrokerGatewayDeps } from './broker-gateway.js';
import {
  FakeBrokerAdapter,
  FakeConfigRepo,
  FakeSecretStore,
  FakeSessionStore,
  FixedClock,
} from '../test-utils/fakes.js';
import {
  MARKET_OPEN_NOW,
  makeBackendConfig,
  makeBrokerSession,
  makeConfig,
  makeOrder,
} from '../test-utils/fixtures.js';

interface Harness {
  deps: BrokerGatewayDeps;
  configs: FakeConfigRepo;
  sessions: FakeSessionStore;
  secrets: FakeSecretStore;
  adapter: FakeBrokerAdapter;
  seenCreds: BrokerCreds[];
}

function harness(overrides?: Partial<BrokerGatewayDeps>): Harness {
  const configs = new FakeConfigRepo([makeConfig()]);
  const sessions = new FakeSessionStore([{ uid: 'u1', session: makeBrokerSession() }]);
  const secrets = new FakeSecretStore({
    'dhan-access-token': { value: 'daily-token', expiresAt: '2026-01-13T18:30:00.000Z' },
    'dhan-client-id': { value: '1100112233' },
    'kite-access-token': { value: 'kite-token', expiresAt: '2026-01-14T00:30:00.000Z' },
    'kite-api-key': { value: 'kite-key' },
  });
  const adapter = new FakeBrokerAdapter();
  const seenCreds: BrokerCreds[] = [];

  const deps: BrokerGatewayDeps = {
    configs,
    sessions,
    secrets,
    clock: new FixedClock(MARKET_OPEN_NOW),
    environment: 'prod',
    secretNames: makeBackendConfig().secrets,
    simulatorFillAfterMs: 1_000,
    createAdapter: (creds): BrokerAdapter => {
      seenCreds.push(creds);
      return adapter;
    },
    ...overrides,
  };
  return { deps, configs, sessions, secrets, adapter, seenCreds };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('createBrokerGateway', () => {
  it('builds Dhan credentials from Secret Manager, never from Firestore', async () => {
    const ctx = await createBrokerGateway(h.deps).forUser('u1');

    expect(ctx.broker).toBe('dhan');
    expect(h.seenCreds[0]).toEqual({
      broker: 'dhan',
      dhan: {
        clientId: '1100112233',
        accessToken: 'daily-token',
        expiresAt: '2026-01-13T18:30:00.000Z',
      },
    });
    expect(ctx.session).toMatchObject({ broker: 'dhan', connected: true, staticIpOk: true });
  });

  it('builds Kite credentials when that is the active broker', async () => {
    h.configs.docs.set('u1', makeConfig({ activeBroker: 'kite' }));
    await h.sessions.set('u1', makeBrokerSession({ broker: 'kite' }));

    const ctx = await createBrokerGateway(h.deps).forUser('u1');
    expect(ctx.broker).toBe('kite');
    expect(h.seenCreds[0]?.kite).toMatchObject({ apiKey: 'kite-key', accessToken: 'kite-token' });
  });

  it('prefers the expiry stored with the token over the Firestore copy', async () => {
    await h.sessions.set('u1', makeBrokerSession({ expiresAt: '2026-01-13T06:00:00.000Z' }));
    const ctx = await createBrokerGateway(h.deps).forUser('u1');

    expect(ctx.session.expiresAt).toBe('2026-01-13T18:30:00.000Z');
  });

  it('returns the real adapter in prod', async () => {
    const ctx = await createBrokerGateway(h.deps).forUser('u1');
    expect(ctx.adapter).toBe(h.adapter);
  });

  it.each(['dry-run', 'paper'] as const)(
    'wraps the adapter in the simulator in %s',
    async (env) => {
      const local = harness({ environment: env });
      const ctx = await createBrokerGateway(local.deps).forUser('u1');

      expect(ctx.adapter).toBeInstanceOf(SimulatedOrderExecutor);
      await ctx.adapter.placeOrder(makeOrder(), 'idem-1');
      // The simulator absorbed the order; the real adapter never saw it.
      expect(local.adapter.placeOrderCalls).toHaveLength(0);
      // Reads still go through to the real adapter.
      expect(await ctx.adapter.getFunds()).toEqual(await local.adapter.getFunds());
    },
  );

  it('refuses when the user has no config', async () => {
    h.configs.docs.clear();
    await expect(createBrokerGateway(h.deps).forUser('u1')).rejects.toBeInstanceOf(
      SessionUnavailableError,
    );
  });

  it('refuses when no session was ever recorded', async () => {
    h.sessions.docs.clear();
    await expect(createBrokerGateway(h.deps).forUser('u1')).rejects.toThrow(/daily login required/);
  });

  it('refuses when the access-token secret is absent or blank', async () => {
    h.secrets.docs.set('dhan-access-token', { value: '   ' });
    await expect(createBrokerGateway(h.deps).forUser('u1')).rejects.toThrow(/is not set/);

    h.secrets.docs.delete('dhan-access-token');
    await expect(createBrokerGateway(h.deps).forUser('u1')).rejects.toThrow(/is not set/);
  });

  it('refuses a token whose expiry is unknown — fail closed', async () => {
    h.secrets.docs.set('dhan-access-token', { value: 'daily-token' });
    await h.sessions.set('u1', makeBrokerSession({ expiresAt: null }));

    await expect(createBrokerGateway(h.deps).forUser('u1')).rejects.toThrow(/expiry unknown/);
  });

  it('refuses when the Dhan client id is missing', async () => {
    h.secrets.docs.delete('dhan-client-id');
    await expect(createBrokerGateway(h.deps).forUser('u1')).rejects.toThrow(/dhan-client-id/);
  });

  it('refuses when the Kite api key is missing', async () => {
    h.configs.docs.set('u1', makeConfig({ activeBroker: 'kite' }));
    await h.sessions.set('u1', makeBrokerSession({ broker: 'kite' }));
    h.secrets.docs.delete('kite-api-key');

    await expect(createBrokerGateway(h.deps).forUser('u1')).rejects.toThrow(/kite-api-key/);
  });
});
