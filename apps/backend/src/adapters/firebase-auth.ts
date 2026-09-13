/**
 * {@link TokenVerifier} backed by the Firebase Admin SDK — docs/04 §4.9
 * ("Firebase ID token verified per request").
 *
 * `checkRevoked: true` costs one extra lookup and means a revoked session stops
 * working immediately rather than at the token's natural expiry — the right
 * trade for the one process that can spend money.
 */

import type { Auth } from 'firebase-admin/auth';
import type { TokenVerifier } from '../ports/index.js';

export function createFirebaseTokenVerifier(auth: Auth): TokenVerifier {
  return {
    async verify(idToken: string): Promise<{ uid: string }> {
      const decoded = await auth.verifyIdToken(idToken, true);
      return { uid: decoded.uid };
    },
  };
}
