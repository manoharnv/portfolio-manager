/**
 * FCM via `@react-native-firebase/messaging` — docs/06 §6.5.
 *
 * The one place the two Firebase runtimes meet: RNFB owns the *native* push
 * token, and the JS SDK writes it into `users/{uid}.fcmTokens`. `arrayUnion` is
 * what firestore.rules allows (only `fcmTokens` and `prefs` are client-owned),
 * and it is also what `functions/src/notify.ts` prunes from when FCM reports a
 * dead token.
 *
 * RNFB v26's **modular** API is used throughout (`getMessaging(...)` + free
 * functions); the `messaging()` namespace form is deprecated and no longer in
 * the typings.
 *
 * Nothing here navigates by itself: handlers hand a route back to the caller
 * (`app/_layout.tsx` owns the router) so this module stays testable and the
 * routing rules live in one pure function (`deeplink.ts`).
 */
import {
  AuthorizationStatus,
  getInitialNotification,
  getMessaging,
  getToken,
  onMessage,
  onNotificationOpenedApp,
  requestPermission,
  setBackgroundMessageHandler,
  type RemoteMessage,
} from '@react-native-firebase/messaging';
import { arrayUnion, doc, updateDoc } from 'firebase/firestore';
import { routeForPushData } from './deeplink';
import { getDb } from './firebase';
import { log } from './log';

export type PermissionOutcome = 'granted' | 'provisional' | 'denied' | 'unavailable';

/**
 * Ask once. iOS returns `provisional` for quiet notifications, which is still
 * good enough to receive a proposal alert, so it is not treated as a refusal.
 */
export async function requestPushPermission(): Promise<PermissionOutcome> {
  try {
    const status = await requestPermission(getMessaging());
    if (status === AuthorizationStatus.AUTHORIZED) return 'granted';
    if (status === AuthorizationStatus.PROVISIONAL) return 'provisional';
    return 'denied';
  } catch (error) {
    log.warn('push permission request failed', { error: String(error) });
    return 'unavailable';
  }
}

export async function getFcmToken(): Promise<string | undefined> {
  try {
    const token = await getToken(getMessaging());
    return token === '' ? undefined : token;
  } catch (error) {
    log.warn('could not read the FCM token', { error: String(error) });
    return undefined;
  }
}

/**
 * `users/{uid}.fcmTokens` ∪ {token}. An `update` (not `set`) because the rules
 * only permit `update`, and the document is backend-provisioned.
 */
export async function registerFcmToken(uid: string, token: string): Promise<boolean> {
  try {
    await updateDoc(doc(getDb(), 'users', uid), { fcmTokens: arrayUnion(token) });
    return true;
  } catch (error) {
    // Not fatal: the app still works, you just will not be pinged.
    log.warn('could not register the FCM token', { error: String(error) });
    return false;
  }
}

export interface RegistrationResult {
  permission: PermissionOutcome;
  registered: boolean;
  /** Never rendered anywhere; kept for the caller's own logic. */
  token?: string | undefined;
}

/** Permission → token → Firestore, in one call. Safe to run on every sign-in. */
export async function registerForPush(uid: string): Promise<RegistrationResult> {
  const permission = await requestPushPermission();
  if (permission === 'denied' || permission === 'unavailable') {
    return { permission, registered: false };
  }
  const token = await getFcmToken();
  if (token === undefined) return { permission, registered: false };
  const registered = await registerFcmToken(uid, token);
  return { permission, registered, token };
}

function dataOf(message: RemoteMessage | null | undefined): Record<string, string> | undefined {
  const raw = message?.data;
  if (raw === undefined || raw === null) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export function routeForMessage(message: RemoteMessage | null | undefined): string | undefined {
  return routeForPushData(dataOf(message));
}

export interface PushHandlers {
  /** A push arrived while the app was open. */
  onForeground: (message: RemoteMessage) => void;
  /** The human tapped a notification; `route` is where to go. */
  onOpened: (route: string, message: RemoteMessage) => void;
}

/**
 * Wires the three RNFB entry points and returns an unsubscribe. The cold-start
 * case (`getInitialNotification`) is resolved once and routed through the same
 * `onOpened` callback.
 */
export function attachPushHandlers(handlers: PushHandlers): () => void {
  const messaging = getMessaging();

  const unsubscribeForeground = onMessage(messaging, (message) => {
    handlers.onForeground(message);
  });

  const unsubscribeOpened = onNotificationOpenedApp(messaging, (message) => {
    const route = routeForMessage(message);
    if (route !== undefined) handlers.onOpened(route, message);
  });

  let cancelled = false;
  void getInitialNotification(messaging)
    .then((message) => {
      if (cancelled || message === null) return;
      const route = routeForMessage(message);
      if (route !== undefined) handlers.onOpened(route, message);
    })
    .catch((error: unknown) => log.warn('getInitialNotification failed', { error: String(error) }));

  return () => {
    cancelled = true;
    unsubscribeForeground();
    unsubscribeOpened();
  };
}

/**
 * Registered from the app entry (outside React) so a data push delivered while
 * the app is backgrounded does not crash. There is nothing to do off-screen —
 * Firestore listeners re-sync on resume — so this only logs.
 */
export function registerBackgroundHandler(): void {
  setBackgroundMessageHandler(getMessaging(), async (message) => {
    log.info('background push', { type: dataOf(message)?.['type'] });
  });
}
