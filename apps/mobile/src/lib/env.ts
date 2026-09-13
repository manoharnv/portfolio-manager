/**
 * The single reader of `expo.extra` (populated from `EXPO_PUBLIC_*` in
 * app.config.ts).
 *
 * Fails closed, per docs/00 §0.7.1: a missing backend URL or Firebase config is
 * an error at the point of use, never a silent default that would send an ID
 * token to `undefined` or talk to the wrong project.
 */
import Constants from 'expo-constants';

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

export interface AppExtra {
  backendBaseUrl?: string | undefined;
  firebase?: Partial<FirebaseWebConfig> | undefined;
  google?: { webClientId?: string | undefined; iosClientId?: string | undefined } | undefined;
  brokerLoginUrlTemplates?: { kite?: string | undefined; dhan?: string | undefined } | undefined;
  brokerRedirectUrl?: string | undefined;
}

export class MissingConfigError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(
      `missing app config "${key}" — set the matching EXPO_PUBLIC_* variable (see .env.example)`,
    );
    this.name = 'MissingConfigError';
    this.key = key;
  }
}

export function extra(): AppExtra {
  return (Constants.expoConfig?.extra ?? {}) as AppExtra;
}

/** Backend origin with any trailing slash removed. Throws when unset. */
export function backendBaseUrl(): string {
  const value = extra().backendBaseUrl;
  if (value === undefined || value === '') throw new MissingConfigError('backendBaseUrl');
  return value.replace(/\/+$/, '');
}

const FIREBASE_KEYS = [
  'apiKey',
  'authDomain',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
] as const;

export function firebaseConfig(): FirebaseWebConfig {
  const raw = extra().firebase ?? {};
  for (const key of FIREBASE_KEYS) {
    const value = raw[key];
    if (value === undefined || value === '') throw new MissingConfigError(`firebase.${key}`);
  }
  return raw as FirebaseWebConfig;
}

/** `undefined` rather than a throw: Apple sign-in alone is a valid setup. */
export function googleClientIds(): { webClientId?: string; iosClientId?: string } {
  const raw = extra().google ?? {};
  return {
    ...(raw.webClientId === undefined ? {} : { webClientId: raw.webClientId }),
    ...(raw.iosClientId === undefined ? {} : { iosClientId: raw.iosClientId }),
  };
}

export function brokerRedirectUrl(): string {
  return extra().brokerRedirectUrl ?? 'pm://broker-callback';
}

/** Fallback only — the live URL comes from `POST /v1/auth/:broker/login-url`. */
export function brokerLoginUrlTemplate(broker: 'dhan' | 'kite'): string | undefined {
  const templates = extra().brokerLoginUrlTemplates ?? {};
  const value = templates[broker];
  return value === undefined || value === '' ? undefined : value;
}
