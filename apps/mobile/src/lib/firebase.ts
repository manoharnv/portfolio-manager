/**
 * Firebase JS SDK bootstrap — Auth + Firestore (docs/06 §6.2).
 *
 * The JS SDK (not `@react-native-firebase/firestore`) is deliberate: it is the
 * house rule for this project, it shares the exact document shapes the backend
 * writes, and it keeps `@react-native-firebase/*` down to the one module that
 * genuinely needs native code — messaging. See README "Firebase split".
 *
 * Everything is lazy. Importing this module must not throw when the env is not
 * configured yet; `MissingConfigError` surfaces at the first real use, where a
 * screen can render it (docs/06 §6.1 "fail visible").
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  initializeAuth,
  onAuthStateChanged,
  signOut as fbSignOut,
  type Auth,
  type Persistence,
  type User,
} from 'firebase/auth';
import * as firebaseAuth from 'firebase/auth';
import {
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  type Firestore,
} from 'firebase/firestore';
import { firebaseConfig } from './env';

const APP_NAME = 'pm';

/**
 * `getReactNativePersistence` is only present on the `react-native` export
 * condition and is absent from the package's public typings, so it is read off
 * the namespace rather than imported. Without it Auth falls back to in-memory
 * persistence and the human re-signs-in on every cold start — degraded, not
 * broken, so this never throws.
 */
const reactNativePersistence = (
  firebaseAuth as unknown as {
    getReactNativePersistence?: (storage: unknown) => Persistence;
  }
).getReactNativePersistence;

let appRef: FirebaseApp | undefined;
let authRef: Auth | undefined;
let dbRef: Firestore | undefined;

export function getFirebaseApp(): FirebaseApp {
  if (appRef !== undefined) return appRef;
  const existing = getApps().find((a) => a.name === APP_NAME);
  appRef = existing ?? initializeApp(firebaseConfig(), APP_NAME);
  return appRef;
}

export function getFirebaseAuth(): Auth {
  if (authRef !== undefined) return authRef;
  const app = getFirebaseApp();
  try {
    authRef =
      reactNativePersistence === undefined
        ? getAuth(app)
        : initializeAuth(app, { persistence: reactNativePersistence(AsyncStorage) });
  } catch {
    // Fast Refresh re-runs this module → `auth/already-initialized`.
    authRef = getAuth(app);
  }
  return authRef;
}

/**
 * `memoryLocalCache` is not a downgrade we chose: the JS SDK has no durable
 * offline store on React Native (IndexedDB is web-only). Listeners still serve
 * from cache within a session, which is what docs/06 §6.6 needs to keep
 * proposals visible when the backend is down. Documented in README.
 */
export function getDb(): Firestore {
  if (dbRef !== undefined) return dbRef;
  const app = getFirebaseApp();
  try {
    dbRef = initializeFirestore(app, {
      localCache: memoryLocalCache(),
      // RN's fetch/XHR stack breaks Firestore's default streaming transport.
      experimentalAutoDetectLongPolling: true,
    });
  } catch {
    dbRef = getFirestore(app);
  }
  return dbRef;
}

export function currentUser(): User | null {
  return getFirebaseAuth().currentUser;
}

export function watchAuth(next: (user: User | null) => void): () => void {
  return onAuthStateChanged(getFirebaseAuth(), next);
}

/**
 * A fresh-enough Firebase ID token for the `Authorization` header. Never
 * persisted by us and never logged (docs/06 §6.7) — the SDK owns its lifetime.
 */
export async function getIdToken(forceRefresh = false): Promise<string> {
  const user = currentUser();
  if (user === null) throw new Error('not signed in');
  return user.getIdToken(forceRefresh);
}

export async function signOut(): Promise<void> {
  await fbSignOut(getFirebaseAuth());
}

/** Test seam only — drops the memoised singletons. */
export function resetFirebaseForTests(): void {
  appRef = undefined;
  authRef = undefined;
  dbRef = undefined;
}
