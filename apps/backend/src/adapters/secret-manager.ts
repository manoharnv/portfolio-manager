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
 *   - `set` needs `roles/secretmanager.secretVersionManager` on the secret (add +
 *     destroy) — broader than the `secretAccessor` the VM has for read-only secrets.
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

/** Secret Manager reports `state` as the enum name or its number; DESTROYED = 3. */
function isDestroyed(state: unknown): boolean {
  return state === 'DESTROYED' || state === 3;
}

export function createSecretManagerStore(options: SecretManagerStoreOptions): SecretStore {
  const client = options.client ?? new SecretManagerServiceClient();
  const secretName = (name: string): string => `projects/${options.projectId}/secrets/${name}`;

  /**
   * Destroy every other live version once a new one is in place.
   *
   * Secret Manager bills every ENABLED *or DISABLED* version ($0.06 per
   * version-month after the first six project-wide). The daily broker-token
   * refresh adds one version per day per broker, so without this the bill
   * grows by ~$3.60 every month, forever. Only DESTROYED versions stop
   * billing — so destroy, never merely disable.
   *
   * Best-effort by design: the new token is already durable at this point, and
   * a cleanup failure (e.g. the VM's service account lacking
   * `secretVersionManager` until the IAM change is applied) must not turn a
   * successful broker login into a reported failure. Fail-safe: when the add
   * response carries no version name we cannot tell old from new, so nothing
   * is destroyed.
   */
  async function retireOtherVersions(
    parent: string,
    keep: string | null | undefined,
  ): Promise<void> {
    if (keep === undefined || keep === null || keep === '') return;
    try {
      const [versions] = await client.listSecretVersions({ parent });
      for (const version of versions) {
        const name = version.name;
        if (name === undefined || name === null || name === keep) continue;
        if (isDestroyed(version.state)) continue;
        await client.destroySecretVersion({ name });
      }
    } catch {
      // best-effort — see the doc comment above
    }
  }

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
      const parent = secretName(name);
      const [added] = await client.addSecretVersion({
        parent,
        payload: { data: Buffer.from(secret.value, 'utf8') },
      });
      if (secret.expiresAt !== undefined) {
        await client.updateSecret({
          secret: {
            name: parent,
            labels: { [EXPIRES_AT_LABEL]: isoToLabel(secret.expiresAt) },
          },
          updateMask: { paths: ['labels'] },
        });
      }
      await retireOtherVersions(parent, added?.name);
    },
  };
}
