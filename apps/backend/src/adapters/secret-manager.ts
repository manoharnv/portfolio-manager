/**
 * {@link SecretStore} backed by Google Secret Manager — docs/04 §4.9.
 *
 * Thin on purpose: no caching, no decision-making. The daily access token's
 * expiry rides along as a Secret Manager **label** on the version's parent
 * secret, because a secret payload should stay opaque and a label is the only
 * metadata the accessor role can read back cheaply.
 *
 * VERIFY-LIVE:
 *   - label keys must match `[a-z0-9_-]{0,63}`, so the ISO expiry is stored
 *     lower-cased with `:`/`.`/`+` replaced — `isoToLabel`/`labelToIso` below;
 *   - `addVersion` requires `secretmanager.versionAdder` on the secret, which is
 *     broader than the `secretAccessor` the VM has for read-only secrets.
 */

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import type { SecretStore, SecretValue } from '../ports/index.js';

export const EXPIRES_AT_LABEL = 'expires-at';

/** ISO-8601 → a Secret Manager label value (`[a-z0-9_-]{0,63}`). */
export function isoToLabel(iso: string): string {
  return iso.toLowerCase().replace(/[:.+]/g, '-');
}

/** Inverse of {@link isoToLabel} for the shapes this backend writes. */
export function labelToIso(label: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})t(\d{2})-(\d{2})-(\d{2})-(\d{3})z$/.exec(label);
  if (m === null) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
}

export interface SecretManagerStoreOptions {
  projectId: string;
  client?: SecretManagerServiceClient | undefined;
}

export function createSecretManagerStore(options: SecretManagerStoreOptions): SecretStore {
  const client = options.client ?? new SecretManagerServiceClient();
  const secretName = (name: string): string => `projects/${options.projectId}/secrets/${name}`;

  return {
    async get(name: string): Promise<SecretValue | undefined> {
      try {
        const [version] = await client.accessSecretVersion({
          name: `${secretName(name)}/versions/latest`,
        });
        const payload = version.payload?.data;
        if (payload === null || payload === undefined) return undefined;
        const value = Buffer.from(payload as Uint8Array).toString('utf8');

        const [secret] = await client.getSecret({ name: secretName(name) });
        const label = secret.labels?.[EXPIRES_AT_LABEL];
        const expiresAt = typeof label === 'string' ? labelToIso(label) : undefined;
        return expiresAt === undefined ? { value } : { value, expiresAt };
      } catch {
        // A missing secret is indistinguishable from a permission error here,
        // and both mean the same thing to the caller: no usable credential.
        return undefined;
      }
    },

    async set(name: string, secret: SecretValue): Promise<void> {
      await client.addSecretVersion({
        parent: secretName(name),
        payload: { data: Buffer.from(secret.value, 'utf8') },
      });
      if (secret.expiresAt !== undefined) {
        await client.updateSecret({
          secret: {
            name: secretName(name),
            labels: { [EXPIRES_AT_LABEL]: isoToLabel(secret.expiresAt) },
          },
          updateMask: { paths: ['labels'] },
        });
      }
    },
  };
}
