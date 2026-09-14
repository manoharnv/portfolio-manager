import { describe, expect, it } from 'vitest';
import type { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import {
  EXPIRES_AT_LABEL,
  createSecretManagerStore,
  isoToLabel,
  labelToIso,
} from './secret-manager.js';

interface FakeVersion {
  name: string;
  state: 'ENABLED' | 'DISABLED' | 'DESTROYED';
  value: string;
}

/** The six calls the store makes — no GCP client, no network. */
class FakeSecretClient {
  /** latest value per secret (what `versions/latest` resolves to) */
  readonly versions = new Map<string, string>();
  readonly labels = new Map<string, Record<string, string>>();
  readonly added: { parent: string; value: string }[] = [];
  /** every version ever added, per secret, with its lifecycle state */
  readonly history = new Map<string, FakeVersion[]>();
  readonly destroyed: string[] = [];
  accessThrows = false;
  destroyThrows = false;
  /** simulate a client whose add response carries no version name */
  addReturnsNoName = false;

  accessSecretVersion(req: { name: string }): Promise<[unknown]> {
    if (this.accessThrows) return Promise.reject(new Error('PERMISSION_DENIED'));
    const secret = req.name.replace(/\/versions\/latest$/, '');
    const value = this.versions.get(secret);
    if (value === undefined) return Promise.reject(new Error('NOT_FOUND'));
    return Promise.resolve([{ payload: { data: Buffer.from(value, 'utf8') } }]);
  }

  getSecret(req: { name: string }): Promise<[unknown]> {
    return Promise.resolve([{ labels: this.labels.get(req.name) }]);
  }

  addSecretVersion(req: { parent: string; payload: { data: Buffer } }): Promise<[unknown]> {
    const value = req.payload.data.toString('utf8');
    this.added.push({ parent: req.parent, value });
    this.versions.set(req.parent, value);
    const list = this.history.get(req.parent) ?? [];
    const version: FakeVersion = {
      name: `${req.parent}/versions/${list.length + 1}`,
      state: 'ENABLED',
      value,
    };
    list.push(version);
    this.history.set(req.parent, list);
    return Promise.resolve([this.addReturnsNoName ? {} : { name: version.name }]);
  }

  listSecretVersions(req: { parent: string }): Promise<[FakeVersion[]]> {
    return Promise.resolve([this.history.get(req.parent) ?? []]);
  }

  destroySecretVersion(req: { name: string }): Promise<[unknown]> {
    if (this.destroyThrows) return Promise.reject(new Error('PERMISSION_DENIED'));
    for (const list of this.history.values()) {
      const v = list.find((x) => x.name === req.name);
      if (v !== undefined) v.state = 'DESTROYED';
    }
    this.destroyed.push(req.name);
    return Promise.resolve([{}]);
  }

  /** test helper: what is still billable for a secret */
  live(parent: string): string[] {
    return (this.history.get(parent) ?? [])
      .filter((v) => v.state !== 'DESTROYED')
      .map((v) => v.name);
  }

  updateSecret(req: {
    secret: { name: string; labels: Record<string, string> };
  }): Promise<[unknown]> {
    this.labels.set(req.secret.name, req.secret.labels);
    return Promise.resolve([{}]);
  }
}

function setup(): { client: FakeSecretClient; store: ReturnType<typeof createSecretManagerStore> } {
  const client = new FakeSecretClient();
  const store = createSecretManagerStore({
    projectId: 'proj',
    client: client as unknown as SecretManagerServiceClient,
  });
  return { client, store };
}

describe('isoToLabel / labelToIso', () => {
  it('round-trips an ISO instant through a label-safe form', () => {
    const iso = '2026-01-14T00:30:00.000Z';
    const label = isoToLabel(iso);

    expect(label).toMatch(/^[a-z0-9_-]{0,63}$/);
    expect(labelToIso(label)).toBe(iso);
  });

  it('returns undefined for a label it did not write', () => {
    expect(labelToIso('whenever')).toBeUndefined();
    expect(labelToIso('')).toBeUndefined();
  });
});

describe('createSecretManagerStore', () => {
  it('writes a version and stamps the expiry as a label', async () => {
    const { client, store } = setup();
    await store.set('dhan-access-token', {
      value: 'daily-token',
      expiresAt: '2026-01-14T00:30:00.000Z',
    });

    expect(client.added).toEqual([
      { parent: 'projects/proj/secrets/dhan-access-token', value: 'daily-token' },
    ]);
    expect(client.labels.get('projects/proj/secrets/dhan-access-token')).toEqual({
      [EXPIRES_AT_LABEL]: isoToLabel('2026-01-14T00:30:00.000Z'),
    });
  });

  it('skips the label write when there is no expiry', async () => {
    const { client, store } = setup();
    await store.set('dhan-api-key', { value: 'long-lived' });
    expect(client.labels.size).toBe(0);
  });

  it('reads a secret back with its expiry', async () => {
    const { store } = setup();
    await store.set('kite-access-token', {
      value: 'kite-token',
      expiresAt: '2026-01-14T00:30:00.000Z',
    });

    expect(await store.get('kite-access-token')).toEqual({
      value: 'kite-token',
      expiresAt: '2026-01-14T00:30:00.000Z',
    });
  });

  it('reads a secret with no expiry label as having none', async () => {
    const { store } = setup();
    await store.set('kite-api-key', { value: 'key' });
    expect(await store.get('kite-api-key')).toEqual({ value: 'key' });
  });

  it('treats a missing secret as absent rather than throwing', async () => {
    const { store } = setup();
    expect(await store.get('nope')).toBeUndefined();
  });

  it('treats a permission error as absent too — no credential either way', async () => {
    const { client, store } = setup();
    client.accessThrows = true;
    expect(await store.get('dhan-access-token')).toBeUndefined();
  });
});

describe('createSecretManagerStore — version retirement (cost leak guard)', () => {
  const secret = 'projects/proj/secrets/dhan-access-token';

  it('destroys every other live version after a successful add, keeping only the new one', async () => {
    const { client, store } = setup();
    await store.set('dhan-access-token', { value: 'day-1' });
    await store.set('dhan-access-token', { value: 'day-2' });
    await store.set('dhan-access-token', { value: 'day-3' });

    expect(client.live(secret)).toEqual([`${secret}/versions/3`]);
    expect(client.destroyed).toEqual([`${secret}/versions/1`, `${secret}/versions/2`]);
    // the value the backend reads is still the newest token
    await expect(store.get('dhan-access-token')).resolves.toEqual({ value: 'day-3' });
  });

  it('never destroys anything when the add response carries no version name (cannot tell old from new)', async () => {
    const { client, store } = setup();
    client.addReturnsNoName = true;
    await store.set('dhan-access-token', { value: 'day-1' });
    await store.set('dhan-access-token', { value: 'day-2' });

    expect(client.destroyed).toEqual([]);
    expect(client.live(secret)).toHaveLength(2);
  });

  it('skips versions that are already DESTROYED and does not destroy the one just added', async () => {
    const { client, store } = setup();
    await store.set('dhan-access-token', { value: 'day-1' });
    await store.set('dhan-access-token', { value: 'day-2' }); // destroys v1
    client.destroyed.length = 0;
    await store.set('dhan-access-token', { value: 'day-3' }); // must only destroy v2

    expect(client.destroyed).toEqual([`${secret}/versions/2`]);
    expect(client.live(secret)).toEqual([`${secret}/versions/3`]);
  });

  it('is best-effort: a destroy failure does not fail the write, and the new token is still readable', async () => {
    const { client, store } = setup();
    await store.set('dhan-access-token', { value: 'day-1' });
    client.destroyThrows = true;
    await expect(store.set('dhan-access-token', { value: 'day-2' })).resolves.toBeUndefined();
    await expect(store.get('dhan-access-token')).resolves.toEqual({ value: 'day-2' });
  });

  it('does not touch versions on a plain get()', async () => {
    const { client, store } = setup();
    await store.set('dhan-access-token', { value: 'day-1' });
    client.destroyed.length = 0;
    await store.get('dhan-access-token');
    expect(client.destroyed).toEqual([]);
  });
});
