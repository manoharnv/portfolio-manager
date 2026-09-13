/**
 * The app-wide `ApiClient` singleton, wired to the real env + Firebase token.
 *
 * Kept out of `api.ts` on purpose: `api.ts` must stay importable (and testable)
 * without touching `expo-constants` or the Firebase SDK.
 */
import { createApiClient, type ApiClient } from './api';
import { backendBaseUrl } from './env';
import { getIdToken } from './firebase';

let client: ApiClient | undefined;

export function backend(): ApiClient {
  if (client === undefined) {
    client = createApiClient({ baseUrl: backendBaseUrl(), getIdToken });
  }
  return client;
}

/** Test seam: inject a fake client, or pass `undefined` to restore the real one. */
export function setBackendForTests(fake: ApiClient | undefined): void {
  client = fake;
}
