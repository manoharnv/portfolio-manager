/**
 * `users/{uid}.prefs` — one of exactly two client-writable fields on the user
 * document (the other is `fcmTokens`; firestore.rules `hasOnly` enforces both).
 *
 * `@pm/core` does not model this document — it is app-owned presentation state,
 * not part of the trading data model — so the schema lives here.
 */
import { useCallback, useMemo } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { z } from 'zod';
import { getDb } from '../lib/firebase';
import { useDocumentSnapshot, type Subscription } from './firestore';

export const NotificationPrefsSchema = z.object({
  proposals: z.boolean().default(true),
  fills: z.boolean().default(true),
  blocks: z.boolean().default(true),
  session: z.boolean().default(true),
  killSwitch: z.boolean().default(true),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

export const UserDocSchema = z.object({
  fcmTokens: z.array(z.string()).optional(),
  prefs: NotificationPrefsSchema.partial().optional(),
});
export type UserDoc = z.infer<typeof UserDocSchema>;

export const DEFAULT_PREFS: NotificationPrefs = {
  proposals: true,
  fills: true,
  blocks: true,
  session: true,
  killSwitch: true,
};

export const PREF_LABELS: Record<keyof NotificationPrefs, string> = {
  proposals: 'New and expiring proposals',
  fills: 'Order fills and rejections',
  blocks: 'Guardrail blocks',
  session: 'Broker session needed',
  killSwitch: 'Kill switch changes',
};

export interface UserPrefsState extends Subscription<UserDoc | undefined> {
  prefs: NotificationPrefs;
  setPref: (key: keyof NotificationPrefs, value: boolean) => Promise<void>;
}

export function useUserPrefs(uid: string | undefined): UserPrefsState {
  const ref = useMemo(() => (uid === undefined ? null : doc(getDb(), 'users', uid)), [uid]);
  const snapshot = useDocumentSnapshot(ref, UserDocSchema, 'user');

  const prefs = useMemo<NotificationPrefs>(() => {
    const stored = snapshot.data?.prefs ?? {};
    const merged = { ...DEFAULT_PREFS };
    // `exactOptionalPropertyTypes`: an explicit `undefined` in the stored doc
    // must fall back to the default, not overwrite it with `undefined`.
    for (const key of Object.keys(DEFAULT_PREFS) as (keyof NotificationPrefs)[]) {
      const value = stored[key];
      if (typeof value === 'boolean') merged[key] = value;
    }
    return merged;
  }, [snapshot.data]);

  const setPref = useCallback(
    async (key: keyof NotificationPrefs, value: boolean) => {
      if (ref === null) throw new Error('not signed in');
      // Only `prefs` is sent — the rules reject a diff touching anything else.
      await updateDoc(ref, { prefs: { ...prefs, [key]: value } });
    },
    [ref, prefs],
  );

  return { ...snapshot, prefs, setPref };
}
