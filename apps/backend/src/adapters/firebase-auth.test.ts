import { describe, expect, it } from 'vitest';
import type { Auth } from 'firebase-admin/auth';
import { createFirebaseTokenVerifier } from './firebase-auth.js';

/** Only `verifyIdToken` is used; nothing here reaches Firebase. */
function fakeAuth(impl: (token: string, checkRevoked?: boolean) => Promise<{ uid: string }>): Auth {
  return { verifyIdToken: impl } as unknown as Auth;
}

describe('createFirebaseTokenVerifier', () => {
  it('returns the uid from a valid token', async () => {
    const verifier = createFirebaseTokenVerifier(
      fakeAuth((token) => Promise.resolve({ uid: `uid-for-${token}` })),
    );
    expect(await verifier.verify('abc')).toEqual({ uid: 'uid-for-abc' });
  });

  it('asks Firebase to check revocation', async () => {
    const calls: [string, boolean | undefined][] = [];
    const verifier = createFirebaseTokenVerifier(
      fakeAuth((token, checkRevoked) => {
        calls.push([token, checkRevoked]);
        return Promise.resolve({ uid: 'u1' });
      }),
    );

    await verifier.verify('abc');
    expect(calls).toEqual([['abc', true]]);
  });

  it('propagates a rejection rather than inventing a uid', async () => {
    const verifier = createFirebaseTokenVerifier(
      fakeAuth(() => Promise.reject(new Error('auth/id-token-expired'))),
    );
    await expect(verifier.verify('stale')).rejects.toThrow(/id-token-expired/);
  });
});
