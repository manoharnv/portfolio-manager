import { describe, expect, it } from 'vitest';
import type { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import {
  EXPIRES_AT_LABEL,
  createSecretManagerStore,
  isoToLabel,
  labelToIso,
} from './secret-manager.js';

/** The four calls the store makes — no GCP client, no network. */
class FakeSecretClient {
  readonly versions = new Map<string, string>();
  readonly labels = new Map<string, Record<string, string>>();
  readonly added: { parent: string; value: string }[] = [];
  accessThrows = false;

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
    this.added.push({ parent: req.parent, value: req.payload.data.toString('utf8') });
    this.versions.set(req.parent, req.payload.data.toString('utf8'));
    return Promise.resolve([{}]);
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
