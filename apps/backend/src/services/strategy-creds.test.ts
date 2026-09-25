import { describe, expect, it } from 'vitest';
import type { SecretValue } from '../ports/index.js';
import { FakeSecretStore } from '../test-utils/fakes.js';
import { createStrategyCredsSync } from './strategy-creds.js';

const NAME = 'pm-strategy-read-creds';

const DHAN = {
  clientId: '1100112233',
  accessToken: 'dhan-jwt',
  expiresAt: '2026-01-14T03:30:00.000Z',
};
const KITE = {
  apiKey: 'kite-key',
  accessToken: 'kite-token',
  expiresAt: '2026-01-14T00:30:00.000Z',
};

function stored(secrets: FakeSecretStore): unknown {
  const value = secrets.docs.get(NAME)?.value;
  return value === undefined ? undefined : JSON.parse(value);
}

describe('createStrategyCredsSync.update', () => {
  it('writes the login as BrokerCreds with the active broker, bare (no envelope expiry)', async () => {
    const secrets = new FakeSecretStore();
    const sync = createStrategyCredsSync({ secrets, secretName: NAME });

    await expect(sync.update({ broker: 'dhan', activeBroker: 'dhan', dhan: DHAN })).resolves.toBe(
      'written',
    );
    expect(stored(secrets)).toEqual({ broker: 'dhan', dhan: DHAN });
    expect(secrets.docs.get(NAME)?.expiresAt).toBeUndefined();
  });

  it('keeps the other broker credentials and follows the active broker, not the login', async () => {
    const secrets = new FakeSecretStore({
      [NAME]: { value: JSON.stringify({ broker: 'dhan', dhan: DHAN }) },
    });
    const sync = createStrategyCredsSync({ secrets, secretName: NAME });

    await sync.update({ broker: 'kite', activeBroker: 'dhan', kite: KITE });

    expect(stored(secrets)).toEqual({ broker: 'dhan', dhan: DHAN, kite: KITE });
  });

  it('falls back to the login broker when no active broker is configured yet', async () => {
    const secrets = new FakeSecretStore();
    const sync = createStrategyCredsSync({ secrets, secretName: NAME });
    await sync.update({ broker: 'kite', activeBroker: undefined, kite: KITE });
    expect(stored(secrets)).toEqual({ broker: 'kite', kite: KITE });
  });

  it('ignores an unparseable or placeholder payload instead of failing', async () => {
    const secrets = new FakeSecretStore({ [NAME]: { value: 'not json' } });
    const sync = createStrategyCredsSync({ secrets, secretName: NAME });
    await expect(sync.update({ broker: 'dhan', activeBroker: 'dhan', dhan: DHAN })).resolves.toBe(
      'written',
    );
    expect(stored(secrets)).toEqual({ broker: 'dhan', dhan: DHAN });
  });

  it('is skipped when no secret name is configured', async () => {
    const secrets = new FakeSecretStore();
    const sync = createStrategyCredsSync({ secrets, secretName: '' });
    await expect(sync.update({ broker: 'dhan', activeBroker: 'dhan', dhan: DHAN })).resolves.toBe(
      'skipped',
    );
    expect(secrets.docs.size).toBe(0);
  });

  it('reports a write failure without throwing — a login must not fail because of it', async () => {
    class Broken extends FakeSecretStore {
      override set(_name: string, _secret: SecretValue): Promise<void> {
        return Promise.reject(new Error('PERMISSION_DENIED'));
      }
    }
    const warnings: unknown[] = [];
    const logger = {
      warn: (obj: unknown) => {
        warnings.push(obj);
      },
    };
    const sync = createStrategyCredsSync({
      secrets: new Broken(),
      secretName: NAME,
      logger: logger as never,
    });
    await expect(sync.update({ broker: 'dhan', activeBroker: 'dhan', dhan: DHAN })).resolves.toBe(
      'failed',
    );
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).not.toContain('dhan-jwt');
  });
});

describe('createStrategyCredsSync.setActive', () => {
  it('re-points the engine at a broker that already has credentials', async () => {
    const secrets = new FakeSecretStore({
      [NAME]: { value: JSON.stringify({ broker: 'dhan', dhan: DHAN, kite: KITE }) },
    });
    const sync = createStrategyCredsSync({ secrets, secretName: NAME });
    await expect(sync.setActive('kite')).resolves.toBe('written');
    expect(stored(secrets)).toEqual({ broker: 'kite', dhan: DHAN, kite: KITE });
  });

  it('skips when the new active broker has no stored credentials', async () => {
    const secrets = new FakeSecretStore({
      [NAME]: { value: JSON.stringify({ broker: 'dhan', dhan: DHAN }) },
    });
    const sync = createStrategyCredsSync({ secrets, secretName: NAME });
    await expect(sync.setActive('kite')).resolves.toBe('skipped');
    expect(stored(secrets)).toEqual({ broker: 'dhan', dhan: DHAN });
  });
});
