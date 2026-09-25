/**
 * Shared push-send path used by every handler: look up the user's FCM tokens,
 * send a multicast, and prune tokens FCM reports as dead. Never throws — a
 * push is best-effort and must never fail the Firestore trigger / scheduled
 * run that called it (docs task spec: "never throws on FCM failure").
 */
import * as logger from 'firebase-functions/logger';

import type { PushPayload } from './catalogue.js';
import type { Db, Messaging } from './ports.js';

export interface UserDoc {
  fcmTokens?: string[] | undefined;
}

/**
 * FCM error codes that mean "this token will never work again — stop sending
 * to it." Sourced from the Admin SDK's documented messaging error codes
 * (firebase-admin 13.10.0's `MessagingClientErrorCode` table).
 * VERIFY-LIVE (see functions/README.md): confirm this set against a real FCM
 * response before relying on it in prod; re-check if firebase-admin is bumped.
 */
export const UNREGISTERED_TOKEN_CODES: ReadonlySet<string> = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

export interface SendToUserResult {
  /** Number of tokens the multicast reported as successfully handed off. */
  sent: number;
  /** Tokens removed from `users/{uid}.fcmTokens` because FCM said they're dead. */
  pruned: string[];
}

export async function sendToUser(
  deps: { db: Db; messaging: Messaging },
  uid: string,
  payload: PushPayload,
): Promise<SendToUserResult> {
  const user = await deps.db.getDoc<UserDoc>(`users/${uid}`);
  const tokens = user?.fcmTokens ?? [];

  if (tokens.length === 0) {
    logger.info('notify.sendToUser: no fcmTokens, skipping send', { uid });
    return { sent: 0, pruned: [] };
  }

  try {
    const result = await deps.messaging.sendEachForMulticast({
      tokens,
      notification: payload.notification,
      data: payload.data,
    });

    const pruned = result.failures
      .filter((failure) => UNREGISTERED_TOKEN_CODES.has(failure.code))
      .map((failure) => failure.token);

    if (pruned.length > 0) {
      const keep = tokens.filter((token) => !pruned.includes(token));
      await deps.db.updateDoc(`users/${uid}`, { fcmTokens: keep });
      logger.info('notify.sendToUser: pruned dead tokens', { uid, pruned });
    }

    return { sent: tokens.length - result.failures.length, pruned };
  } catch (err) {
    logger.error('notify.sendToUser: FCM send failed, swallowing', {
      uid,
      error: err instanceof Error ? err.message : String(err),
    });
    return { sent: 0, pruned: [] };
  }
}
