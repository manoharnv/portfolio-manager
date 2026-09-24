/**
 * {@link SecretStore} backed by Google Secret Manager — docs/04 §4.9.
 *
 * Thin on purpose: no caching, no decision-making. A daily access token's
 * expiry travels **inside the payload**, as a small marked JSON envelope
 * (`{"__pm":1,"value":…,"expiresAt":…}`), because the roles the VM actually
 * holds cannot read or write secret metadata:
 *
 *   - `roles/secretmanager.secretAccessor` is `versions.access` and nothing
 *     else — no `secrets.get`, so a label on the secret is invisible;
 *   - `roles/secretmanager.secretVersionManager` adds/lists/destroys versions
 *     but has no `secrets.update`, so a label could not be written either.
 *
 * (Observed live on 2026-09-24: with labels every `get` failed closed as
 * "not set" — docs/11 §11.5.) Operator-entered secrets (api keys, client ids)
 * are plain strings and come back as-is; only what this backend writes with an
 * expiry is enveloped, and the strategy engine's read-creds secret is written
 * bare so the engine can parse it directly.
 */

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import type { SecretStore, SecretValue } from '../ports/index.js';

export interface SecretManagerStoreOptions {
  projectId: string;
  client?: SecretManagerServiceClient | undefined;
}

const ENVELOPE_MARK = 1;

interface Envelope {
  __pm: typeof ENVELOPE_MARK;
  value: string;
  expiresAt: string;
}

/** Payload text for a value, enveloped only when it carries an expiry. */
export function encodePayload(secret: SecretValue): string {
  if (secret.expiresAt === undefined) return secret.value;
  const envelope: Envelope = {
    __pm: ENVELOPE_MARK,
    value: secret.value,
    expiresAt: secret.expiresAt,
  };
  return JSON.stringify(envelope);
}

/** Inverse of {@link encodePayload}; anything not carrying the mark is a plain value. */
export function decodePayload(text: string): SecretValue {
  if (!text.startsWith('{')) return { value: text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { value: text };
  }
  if (typeof parsed !== 'object' || parsed === null) return { value: text };
  const record = parsed as Record<string, unknown>;
  if (
    record['__pm'] !== ENVELOPE_MARK ||
    typeof record['value'] !== 'string' ||
    typeof record['expiresAt'] !== 'string'
  ) {
    return { value: text };
  }
  return { value: record['value'], expiresAt: record['expiresAt'] };
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
        return decodePayload(Buffer.from(payload as Uint8Array).toString('utf8'));
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
        payload: { data: Buffer.from(encodePayload(secret), 'utf8') },
      });
      await retireOtherVersions(parent, added?.name);
    },
  };
}
