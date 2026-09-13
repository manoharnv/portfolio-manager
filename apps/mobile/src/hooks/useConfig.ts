/**
 * `config/{uid}` — the control panel (docs/03 §3.2).
 *
 * Reads are a plain listener. Writes go through `updateConfig`, which refuses
 * to carry `environment`, `activeBroker` or `uid`: firestore.rules rejects a
 * diff that touches them, and the app must not even try (docs/06 §6.3 (6)).
 */
import { useCallback, useMemo } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { ConfigSchema, clampConfigToCeilings, type Config, type GuardrailConfig } from '@pm/core';
import { getDb } from '../lib/firebase';
import { useDocumentSnapshot, type Subscription } from './firestore';

/** Fields the client may never send. Enforced here *and* by the rules. */
export const IMMUTABLE_CONFIG_FIELDS = ['environment', 'activeBroker', 'uid'] as const;

export type ConfigPatch = Partial<
  Pick<
    Config,
    'killSwitch' | 'tradingEnabled' | 'guardrails' | 'totalManagedCapitalInr' | 'reservePct'
  >
>;

export interface ConfigSubscription extends Subscription<Config | undefined> {
  /** `min(config, ABS_*)` — what the backend will actually enforce. */
  effective: Config | undefined;
  update: (patch: ConfigPatch, now: Date) => Promise<void>;
}

export function stripImmutable(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if ((IMMUTABLE_CONFIG_FIELDS as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  return out;
}

export function useConfig(uid: string | undefined): ConfigSubscription {
  const ref = useMemo(() => (uid === undefined ? null : doc(getDb(), 'config', uid)), [uid]);
  const snapshot = useDocumentSnapshot(ref, ConfigSchema, 'config');

  const update = useCallback(
    async (patch: ConfigPatch, now: Date) => {
      if (ref === null) throw new Error('not signed in');
      const safe = stripImmutable(patch as Record<string, unknown>);
      await updateDoc(ref, { ...safe, updatedAt: now.toISOString() });
    },
    [ref],
  );

  const effective = useMemo(
    () => (snapshot.data === undefined ? undefined : clampConfigToCeilings(snapshot.data)),
    [snapshot.data],
  );

  return { ...snapshot, effective, update };
}

/** Convenience for the guardrails screen. */
export function guardrailsOf(config: Config | undefined): GuardrailConfig | undefined {
  return config?.guardrails;
}
